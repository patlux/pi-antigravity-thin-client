import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
	normalizeContext,
	type AssistantMessage,
	type Model,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type {
	CustomEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProviderConfig,
	RegisteredCommand,
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { AcpProcessManager } from "../src/acp/process-manager.ts";
import { BackgroundActivityController } from "../src/background/background-controller.ts";
import { ANTIGRAVITY_PROVIDER_ID } from "../src/catalog/model-discovery.ts";
import { DEFAULT_BRIDGE_CONFIG, type BridgeConfig } from "../src/config.ts";
import antigravityBridgeExtension from "../src/index.ts";
import {
	AGY_SESSION_ANCHOR_CUSTOM_TYPE,
	type AgySessionAnchor,
} from "../src/session/checkpoint-sync.ts";
import { computeTranscriptDigest } from "../src/session/reconcile.ts";
import { TurnCoordinator } from "../src/session/turn-coordinator.ts";
import {
	AgyTurnMirrorBroker,
	createAgyMirrorToolDefinitions,
} from "../src/tools/agy-mirror-tools.ts";
import { AUTONOMOUS_ENTRY_TYPE, isAutonomousEntryData } from "../src/ui/background-activity.ts";
import { registerAntigravityCommands } from "../src/ui/commands.ts";
import { typedByHuman } from "./human-input.ts";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

const TEST_MODEL: Model<"antigravity-acp"> = {
	id: "gemini-4-neon",
	name: "Gemini 4 Neon",
	api: "antigravity-acp",
	provider: "antigravity",
	baseUrl: "acp://antigravity-cli",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 512_000,
	maxTokens: 65_536,
};

function isExtensionApi(value: object): value is ExtensionAPI {
	return "registerCommand" in value && "on" in value && "appendEntry" in value;
}

function isExtensionContext(value: object): value is ExtensionContext {
	return "hasUI" in value && "cwd" in value && "ui" in value && "sessionManager" in value;
}

function isCommandContext(value: object): value is ExtensionCommandContext {
	return isExtensionContext(value) && "newSession" in value;
}

function isSessionManager(value: object): value is SessionManager {
	return "appendMessage" in value && "appendCustomEntry" in value && "appendSessionInfo" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAgySessionAnchor(value: unknown): value is AgySessionAnchor {
	return (
		isRecord(value) &&
		value.version === 1 &&
		typeof value.agySessionId === "string" &&
		typeof value.transcriptDigest === "string" &&
		typeof value.messageCount === "number"
	);
}

function writeExecutableScript(dir: string, name: string, source: string): string {
	if (process.platform === "win32") {
		const script = path.join(dir, `${name}.mjs`);
		fs.writeFileSync(script, source);
		const wrapper = path.join(dir, `${name}.cmd`);
		fs.writeFileSync(wrapper, `@node "${script}" %*\r\n`);
		return wrapper;
	}
	const script = path.join(dir, name);
	fs.writeFileSync(script, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
	return script;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedConversationDb(geminiDir: string, sessionId: string, stepTypes: number[]): void {
	const convDir = path.join(geminiDir, "antigravity-cli", "conversations");
	fs.mkdirSync(convDir, { recursive: true });
	const dbPath = path.join(convDir, `${sessionId}.db`);
	const db = new DatabaseSync(dbPath);
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer);
			CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0);
			CREATE TABLE IF NOT EXISTS gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
			CREATE TABLE IF NOT EXISTS executor_metadata (idx integer PRIMARY KEY, data blob);
			CREATE TABLE IF NOT EXISTS parent_references (idx integer PRIMARY KEY, data blob);
			CREATE TABLE IF NOT EXISTS trajectory_metadata_blob (id text PRIMARY KEY DEFAULT "main", data blob);
		`);
		db.prepare("INSERT OR REPLACE INTO trajectory_meta VALUES (?, ?, 4, 17)").run(sessionId, sessionId);
		db.prepare("INSERT OR REPLACE INTO trajectory_metadata_blob VALUES ('main', ?)").run(
			Buffer.from(`mock-meta:default-agy-agent:${sessionId}`),
		);
		for (let i = 0; i < stepTypes.length; i++) {
			db.prepare("INSERT OR REPLACE INTO steps (idx, step_type, status) VALUES (?, ?, 3)").run(i, stepTypes[i]);
		}
	} finally {
		db.close();
	}
}

function appendConversationSteps(geminiDir: string, sessionId: string, stepTypes: number[]): void {
	const dbPath = path.join(geminiDir, "antigravity-cli", "conversations", `${sessionId}.db`);
	const db = new DatabaseSync(dbPath);
	try {
		const row = db.prepare("SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM steps").get();
		const start = isRecord(row) && typeof row.next === "number" ? row.next : 0;
		for (let i = 0; i < stepTypes.length; i++) {
			db.prepare("INSERT INTO steps (idx, step_type, status) VALUES (?, ?, 3)").run(start + i, stepTypes[i]);
		}
	} finally {
		db.close();
	}
}

function writeRunningTaskTranscript(geminiDir: string, agySessionId: string): string {
	const logsDir = path.join(geminiDir, "antigravity-cli", "brain", agySessionId, ".system_generated", "logs");
	fs.mkdirSync(logsDir, { recursive: true });
	const file = path.join(logsDir, "transcript_full.jsonl");
	const lines = [
		JSON.stringify({
			step_index: 0,
			source: "USER_EXPLICIT",
			type: "USER_INPUT",
			status: "DONE",
			created_at: "2026-11-26T10:00:00Z",
			content: "<USER_REQUEST>\nRun sleep in background\n</USER_REQUEST>",
		}),
		JSON.stringify({
			step_index: 1,
			source: "MODEL",
			type: "PLANNER_RESPONSE",
			status: "DONE",
			created_at: "2026-11-26T10:00:01Z",
			tool_calls: [{ name: "run_command", args: { CommandLine: '"sleep 60"', WaitMsBeforeAsync: "500" } }],
		}),
		JSON.stringify({
			step_index: 2,
			source: "MODEL",
			type: "GENERIC",
			status: "RUNNING",
			created_at: "2026-11-26T10:00:02Z",
			content: `Created At: 2026-11-26T10:00:02Z\nTool is running as a background task with task id: ${agySessionId}/task-2\nTask Description: sleep 60`,
		}),
		JSON.stringify({
			step_index: 3,
			source: "MODEL",
			type: "PLANNER_RESPONSE",
			status: "DONE",
			created_at: "2026-11-26T10:00:03Z",
			content: "Started in background.",
		}),
	];
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function appendFinishedAutonomousTurn(transcriptFile: string, agySessionId: string, startStep: number, answer: string): void {
	const nowIso = new Date().toISOString();
	const lines = [
		JSON.stringify({
			step_index: startStep,
			source: "SYSTEM",
			type: "SYSTEM_MESSAGE",
			status: "DONE",
			created_at: nowIso,
			content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${nowIso} sender=${agySessionId}/task-2 priority=MESSAGE_PRIORITY_HIGH content=Task id "${agySessionId}/task-2" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`,
		}),
		JSON.stringify({
			step_index: startStep + 1,
			source: "MODEL",
			type: "PLANNER_RESPONSE",
			status: "DONE",
			created_at: nowIso,
			content: answer,
		}),
	];
	fs.appendFileSync(transcriptFile, `${lines.join("\n")}\n`);
}

interface RecordedCall {
	method: string;
	sessionId?: string;
}

function writeLifecycleMockAgy(root: string, geminiDir: string, callsLog: string): string {
	const source = `
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { DatabaseSync } from "node:sqlite";

const geminiDir = ${JSON.stringify(geminiDir)};
const callsLog = ${JSON.stringify(callsLog)};
const convDir = path.join(geminiDir, "antigravity-cli", "conversations");
fs.mkdirSync(convDir, { recursive: true });

let nextSessionNum = 1;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const log = (entry) => fs.appendFileSync(callsLog, JSON.stringify(entry) + "\\n");

function ensureDb(id) {
	const dbPath = path.join(convDir, id + ".db");
	if (fs.existsSync(dbPath)) return;
	const db = new DatabaseSync(dbPath);
	db.exec(\`
		CREATE TABLE IF NOT EXISTS trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer);
		CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0);
		CREATE TABLE IF NOT EXISTS gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
		CREATE TABLE IF NOT EXISTS executor_metadata (idx integer PRIMARY KEY, data blob);
		CREATE TABLE IF NOT EXISTS parent_references (idx integer PRIMARY KEY, data blob);
		CREATE TABLE IF NOT EXISTS trajectory_metadata_blob (id text PRIMARY KEY DEFAULT "main", data blob);
	\`);
	db.prepare("INSERT OR REPLACE INTO trajectory_meta VALUES (?, ?, 4, 17)").run(id, id);
	db.prepare("INSERT OR REPLACE INTO trajectory_metadata_blob VALUES ('main', ?)").run(Buffer.from("mock-meta:default-agy-agent:" + id));
	db.prepare("INSERT OR REPLACE INTO steps (idx, step_type, status) VALUES (0, 14, 3), (1, 15, 3)").run();
	db.close();
}

const CONFIG_OPTIONS = [
	{ id: "model", name: "Model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] },
	{ id: "thought_level", name: "Thinking", type: "select", currentValue: "high", options: [{ value: "high", name: "high" }] },
	{ id: "mode", name: "Mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
];

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (!msg.method) return;
	const p = msg.params ?? {};
	log({ method: msg.method, sessionId: p.sessionId });
	const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });

	if (msg.method === "initialize") {
		reply({
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: true,
				sessionCapabilities: { resume: {}, close: {}, list: {}, load: {} },
				auth: { logout: {} },
				_meta: { antigravity: { tier: true } },
			},
			agentInfo: { name: "Mock Lifecycle AGY", version: "1.5.13" },
		});
		return;
	}
	if (msg.method === "session/new") {
		const sessionId = "agy-life-" + nextSessionNum++;
		ensureDb(sessionId);
		reply({ sessionId, configOptions: CONFIG_OPTIONS, _meta: { antigravity: { tier: { id: "ultra", name: "Ultra" } } } });
		return;
	}
	if (msg.method === "session/resume") {
		reply({ sessionId: p.sessionId, configOptions: CONFIG_OPTIONS, _meta: { antigravity: { tier: { id: "ultra", name: "Ultra" } } } });
		return;
	}
	if (msg.method === "session/prompt") {
		const promptText = (p.prompt ?? []).map((b) => (b.type === "text" ? b.text : "")).join(" ");
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: p.sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
			},
		});
		reply({ stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } });
		if (promptText.includes("emit-out-of-turn")) {
			setTimeout(() => {
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: p.sessionId,
						update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "autonomous update" } },
					},
				});
			}, 40);
		}
		return;
	}
	if (msg.method === "session/close" || msg.method === "auth/logout") {
		reply({});
		return;
	}
	if (msg.id !== undefined) {
		reply({});
	}
});
`;
	return writeExecutableScript(root, "mock-lifecycle-agy", source);
}

function readCallsLog(callsLog: string): RecordedCall[] {
	if (!fs.existsSync(callsLog)) return [];
	return fs
		.readFileSync(callsLog, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const parsed: unknown = JSON.parse(line);
			if (!isRecord(parsed) || typeof parsed.method !== "string") {
				return { method: "" };
			}
			return {
				method: parsed.method,
				sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
			};
		});
}

interface UiRecorder {
	widgets: Array<{ key: string; active: boolean }>;
	statuses: Array<{ key: string; text: string | undefined }>;
	notes: Array<{ message: string; level: string | undefined }>;
}

const BG_KEY = "antigravity-background";

function latestBgWidget(ui: UiRecorder): boolean | undefined {
	return ui.widgets.filter((w) => w.key === BG_KEY).at(-1)?.active;
}

function latestBgStatus(ui: UiRecorder): string | undefined {
	return ui.statuses.filter((s) => s.key === BG_KEY).at(-1)?.text;
}

function createUiContext(options: {
	cwd: string;
	piSessionId: string;
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	provider?: string;
	modelId?: string;
	entries?: SessionEntry[];
	branch?: SessionEntry[];
	uiRecorder?: UiRecorder;
	selectResult?: (items: string[]) => string | undefined;
	onNewSession?: (captured: {
		messages: Array<UserMessage | AssistantMessage | ToolResultMessage>;
		sessionInfos: string[];
		customEntries: Array<{ customType: string; data: unknown }>;
	}) => void;
}): { ctx: ExtensionCommandContext; ui: UiRecorder; newSessionCalls: number } {
	const ui: UiRecorder = options.uiRecorder ?? { widgets: [], statuses: [], notes: [] };
	let newSessionCalls = 0;

	const stub = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		cwd: options.cwd,
		model:
			options.provider === undefined
				? { provider: ANTIGRAVITY_PROVIDER_ID, id: options.modelId ?? "gemini-4-neon" }
				: { provider: options.provider, id: options.modelId ?? "other-model" },
		isProjectTrusted: () => false,
		sessionManager: {
			getSessionId: () => options.piSessionId,
			getEntries: () => options.entries ?? [],
			getBranch: () => options.branch ?? options.entries ?? [],
		},
		ui: {
			notify(message: string, level?: string) {
				ui.notes.push({ message, level });
			},
			setStatus(key: string, text: string | undefined) {
				ui.statuses.push({ key, text });
			},
			setWidget(key: string, content: unknown) {
				ui.widgets.push({ key, active: content !== undefined });
			},
			async select(_title: string, items: string[]) {
				return options.selectResult ? options.selectResult(items) : items[0];
			},
		},
		async newSession(newOptions?: {
			setup?: (sessionManager: SessionManager) => Promise<void>;
			withSession?: (replacedCtx: ExtensionContext) => Promise<void>;
		}) {
			newSessionCalls++;
			const messages: Array<UserMessage | AssistantMessage | ToolResultMessage> = [];
			const sessionInfos: string[] = [];
			const customEntries: Array<{ customType: string; data: unknown }> = [];
			const smStub = {
				appendMessage(msg: UserMessage | AssistantMessage | ToolResultMessage) {
					messages.push(msg);
				},
				appendSessionInfo(title: string) {
					sessionInfos.push(title);
				},
				appendCustomEntry(customType: string, data: unknown) {
					customEntries.push({ customType, data });
				},
			};
			if (!isSessionManager(smStub)) {
				throw new Error("sessionManager stub incomplete");
			}
			if (newOptions?.setup) {
				await newOptions.setup(smStub);
			}
			options.onNewSession?.({ messages, sessionInfos, customEntries });
			if (newOptions?.withSession) {
				await newOptions.withSession(ctx);
			}
			return { cancelled: false };
		},
	};
	if (!isCommandContext(stub)) {
		throw new Error("command context stub incomplete");
	}
	const ctx: ExtensionCommandContext = stub;
	return {
		ctx,
		ui,
		get newSessionCalls() {
			return newSessionCalls;
		},
	};
}

interface ExtensionHarness {
	pi: ExtensionAPI;
	providers: Map<string, ProviderConfig>;
	commands: Map<string, CommandOptions>;
	handlers: Map<string, EventHandler[]>;
	appendedEntries: Array<{ customType: string; data: unknown }>;
	emit(eventName: string, event: unknown, ctx: ExtensionContext): Promise<void>;
}

function createExtensionHarness(): ExtensionHarness {
	const providers = new Map<string, ProviderConfig>();
	const commands = new Map<string, CommandOptions>();
	const handlers = new Map<string, EventHandler[]>();
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	let activeTools = ["read", "edit", "write", "bash"];

	const stub = {
		registerProvider(name: string, config: ProviderConfig) {
			providers.set(name, config);
		},
		registerTool() {},
		registerToolRenderer() {},
		registerEntryRenderer() {},
		registerCommand(name: string, options: CommandOptions) {
			commands.set(name, options);
		},
		on(eventName: string, handler: EventHandler) {
			const list = handlers.get(eventName) ?? [];
			list.push(handler);
			handlers.set(eventName, list);
		},
		appendEntry(customType: string, data: unknown) {
			appendedEntries.push({ customType, data });
		},
		getSessionName() {
			return undefined;
		},
		setSessionName() {},
		getActiveTools() {
			return [...activeTools];
		},
		getAllTools() {
			return [];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
	};
	if (!isExtensionApi(stub)) {
		throw new Error("extension API stub incomplete");
	}
	return {
		pi: stub,
		providers,
		commands,
		handlers,
		appendedEntries,
		async emit(eventName: string, event: unknown, ctx: ExtensionContext): Promise<void> {
			for (const handler of handlers.get(eventName) ?? []) {
				await handler(event, ctx);
			}
		},
	};
}

async function runOneCoordinatorTurn(
	coordinator: TurnCoordinator,
	broker: AgyTurnMirrorBroker,
	piSessionId: string,
	text: string,
): Promise<void> {
	const msg: UserMessage = { role: "user", content: text, timestamp: Date.now() };
	typedByHuman(coordinator.humanPromptGate, msg);
	const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));
	const stream = coordinator.streamSimple(
		TEST_MODEL,
		normalizeContext({ messages: [msg], tools }),
		{ sessionId: piSessionId },
	);
	const result = await stream.result();
	assert.equal(result.stopReason, "stop", `expected turn to succeed, got error: ${result.errorMessage ?? ""}`);
}

describe("BackgroundActivityController lifecycle & cross-session safety", () => {
	it("stops the previous watcher on session switch without agySessionId and on non-Antigravity model", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-bg-switch-"));
		const geminiDir = path.join(root, ".gemini");
		const callsLog = path.join(root, "calls.log");
		const mockAgy = writeLifecycleMockAgy(root, geminiDir, callsLog);
		const harness = createExtensionHarness();
		const broker = new AgyTurnMirrorBroker();
		const config: BridgeConfig = { ...DEFAULT_BRIDGE_CONFIG, agyBin: mockAgy, geminiDir };
		const coordinator = new TurnCoordinator(harness.pi, new AcpProcessManager(), broker, config);
		const background = new BackgroundActivityController(harness.pi, coordinator);

		try {
			const session1 = createUiContext({ cwd: root, piSessionId: "pi-session-1" });
			coordinator.setActiveContext(session1.ctx);
			await runOneCoordinatorTurn(coordinator, broker, "pi-session-1", "start background work");
			const agyId1 = coordinator.getTelemetrySnapshot("pi-session-1").agySessionId;
			assert.ok(agyId1, "session 1 has an active agySessionId");

			const transcriptFile = writeRunningTaskTranscript(geminiDir, agyId1);
			background.sync(session1.ctx);
			assert.equal(session1.ui.widgets.at(-1)?.active, true, "widget is shown for session 1 running task");
			assert.equal(session1.ui.statuses.at(-1)?.text, "agy ⏳ 1");

			// Switching to a non-Antigravity model stops the watcher and hides the widget.
			const nonAgy = createUiContext({
				cwd: root,
				piSessionId: "pi-session-1",
				provider: "anthropic",
				modelId: "claude-sonnet",
				uiRecorder: session1.ui,
			});
			coordinator.setActiveContext(nonAgy.ctx);
			background.sync(nonAgy.ctx);
			assert.equal(session1.ui.widgets.at(-1)?.active, false, "widget is cleared for non-Antigravity model");
			assert.equal(session1.ui.statuses.at(-1)?.text, undefined, "status is cleared for non-Antigravity model");

			// Out-of-turn updates while on a non-Antigravity model must not re-show the widget.
			background.onOutOfTurnUpdate(agyId1, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "still running" },
			});
			assert.equal(session1.ui.widgets.at(-1)?.active, false);

			// Switching back to Antigravity re-attaches.
			coordinator.setActiveContext(session1.ctx);
			background.sync(session1.ctx);
			assert.equal(session1.ui.widgets.at(-1)?.active, true);

			// Switching to a brand-new Pi session without an agySessionId stops the old watcher.
			const session2 = createUiContext({ cwd: root, piSessionId: "pi-session-2" });
			coordinator.setActiveContext(session2.ctx);
			background.sync(session2.ctx);
			assert.equal(session1.ui.widgets.at(-1)?.active, false, "session 1 widget cleared when session 2 has no agySessionId");
			assert.equal(session1.ui.statuses.at(-1)?.text, undefined);

			// An autonomous turn finishing later in session 1 must never bleed into session 2.
			appendFinishedAutonomousTurn(transcriptFile, agyId1, 4, "Finished in old session");
			await sleep(1_200);
			assert.equal(harness.appendedEntries.length, 0, "no autonomous entry appended after watcher stopped");
		} finally {
			background.stop();
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("clearLive() clears out-of-turn live activity immediately", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-bg-live-"));
		const geminiDir = path.join(root, ".gemini");
		const callsLog = path.join(root, "calls.log");
		const mockAgy = writeLifecycleMockAgy(root, geminiDir, callsLog);
		const harness = createExtensionHarness();
		const broker = new AgyTurnMirrorBroker();
		const config: BridgeConfig = { ...DEFAULT_BRIDGE_CONFIG, agyBin: mockAgy, geminiDir };
		const coordinator = new TurnCoordinator(harness.pi, new AcpProcessManager(), broker, config);
		const background = new BackgroundActivityController(harness.pi, coordinator);

		try {
			const session1 = createUiContext({ cwd: root, piSessionId: "pi-live-1" });
			coordinator.setActiveContext(session1.ctx);
			await runOneCoordinatorTurn(coordinator, broker, "pi-live-1", "hello");
			const agyId = coordinator.getTelemetrySnapshot("pi-live-1").agySessionId;
			assert.ok(agyId);

			background.onOutOfTurnUpdate(agyId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "working autonomously" },
			});
			assert.equal(session1.ui.widgets.at(-1)?.active, true);
			assert.equal(session1.ui.statuses.at(-1)?.text, "agy ⚙ on its own");

			background.clearLive();
			assert.equal(session1.ui.widgets.at(-1)?.active, false, "live widget clears immediately on clearLive()");
			assert.equal(session1.ui.statuses.at(-1)?.text, undefined, "live status badge clears immediately on clearLive()");
		} finally {
			background.stop();
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("record() appends entries only when the active Pi session still resolves to the same agySessionId", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-bg-record-"));
		const geminiDir = path.join(root, ".gemini");
		const callsLog = path.join(root, "calls.log");
		const mockAgy = writeLifecycleMockAgy(root, geminiDir, callsLog);
		const harness = createExtensionHarness();
		const broker = new AgyTurnMirrorBroker();
		const config: BridgeConfig = { ...DEFAULT_BRIDGE_CONFIG, agyBin: mockAgy, geminiDir };
		const coordinator = new TurnCoordinator(harness.pi, new AcpProcessManager(), broker, config);
		const background = new BackgroundActivityController(harness.pi, coordinator);

		try {
			const session1 = createUiContext({ cwd: root, piSessionId: "pi-rec-1" });
			coordinator.setActiveContext(session1.ctx);
			await runOneCoordinatorTurn(coordinator, broker, "pi-rec-1", "start");
			const agyId1 = coordinator.getTelemetrySnapshot("pi-rec-1").agySessionId;
			assert.ok(agyId1);

			const transcriptFile = writeRunningTaskTranscript(geminiDir, agyId1);
			background.sync(session1.ctx);

			// Switch active context to pi-rec-2 WITHOUT calling background.stop(), simulating a race window.
			const session2 = createUiContext({ cwd: root, piSessionId: "pi-rec-2" });
			coordinator.setActiveContext(session2.ctx);

			appendFinishedAutonomousTurn(transcriptFile, agyId1, 4, "Should not bleed into pi-rec-2");
			await sleep(1_200);
			assert.equal(
				harness.appendedEntries.length,
				0,
				"old session autonomous turn must never be appended into newly switched Pi session",
			);

			// Positive control: when active context stays on pi-rec-1, a new autonomous turn IS recorded.
			coordinator.setActiveContext(session1.ctx);
			appendFinishedAutonomousTurn(transcriptFile, agyId1, 6, "Recorded for pi-rec-1");
			await sleep(1_200);
			assert.equal(harness.appendedEntries.length, 1);
			assert.equal(harness.appendedEntries[0].customType, AUTONOMOUS_ENTRY_TYPE);
			assert.ok(isAutonomousEntryData(harness.appendedEntries[0].data));
			assert.equal(harness.appendedEntries[0].data.agySessionId, agyId1);
			assert.equal(harness.appendedEntries[0].data.text, "Recorded for pi-rec-1");
		} finally {
			background.stop();
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("extension lifecycle hooks (src/index.ts)", () => {
	it("never spawns agy acp on headless session_start even when model cache is missing", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-headless-start-"));
		const agentDir = path.join(root, "agent");
		const geminiDir = path.join(root, ".gemini");
		fs.mkdirSync(agentDir, { recursive: true });
		const marker = path.join(root, "agy-spawned");
		const recordingBin = writeExecutableScript(
			root,
			"recording-agy",
			`import * as fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(marker)}, "spawned\\n");\nprocess.exit(1);\n`,
		);

		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		const prevBin = process.env.PI_AGY_BIN;
		const prevGemini = process.env.PI_AGY_GEMINI_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_AGY_BIN = recordingBin;
		process.env.PI_AGY_GEMINI_DIR = geminiDir;

		const harness = createExtensionHarness();
		antigravityBridgeExtension(harness.pi);

		try {
			const headless = createUiContext({
				cwd: root,
				piSessionId: "pi-headless-1",
				hasUI: false,
				mode: "print",
			});
			await harness.emit("session_start", {}, headless.ctx);
			await sleep(150);
			assert.equal(fs.existsSync(marker), false, "headless session_start must never spawn agy acp");

			// Positive control: interactive UI session_start with missing cache does trigger background probe.
			const interactive = createUiContext({
				cwd: root,
				piSessionId: "pi-interactive-1",
				hasUI: true,
				mode: "tui",
			});
			await harness.emit("session_start", {}, interactive.ctx);
			for (let i = 0; i < 30 && !fs.existsSync(marker); i++) {
				await sleep(25);
			}
			assert.equal(fs.existsSync(marker), true, "interactive session_start probes stale catalog using mock agy");
		} finally {
			const dummy = createUiContext({ cwd: root, piSessionId: "shutdown" });
			await harness.emit("session_shutdown", {}, dummy.ctx);
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			if (prevBin === undefined) delete process.env.PI_AGY_BIN;
			else process.env.PI_AGY_BIN = prevBin;
			if (prevGemini === undefined) delete process.env.PI_AGY_GEMINI_DIR;
			else process.env.PI_AGY_GEMINI_DIR = prevGemini;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("tears down previous session ledger and watcher on session switch, model_select, before_agent_start, session_compact, session_tree, and /agy logout", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-ext-lifecycle-"));
		const agentDir = path.join(root, "agent");
		const geminiDir = path.join(root, ".gemini");
		fs.mkdirSync(agentDir, { recursive: true });
		// Seed a fresh model cache so session_start does not spawn an unrelated catalog probe.
		fs.mkdirSync(path.join(agentDir, "cache"), { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "cache", "antigravity-models.json"),
			JSON.stringify({
				version: 1,
				updatedAt: Date.now(),
				models: [{ ...TEST_MODEL, type: "chat" }],
				modelEfforts: { "gemini-4-neon": ["high"] },
			}),
		);
		const callsLog = path.join(root, "calls.log");
		const mockAgy = writeLifecycleMockAgy(root, geminiDir, callsLog);

		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		const prevBin = process.env.PI_AGY_BIN;
		const prevGemini = process.env.PI_AGY_GEMINI_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_AGY_BIN = mockAgy;
		process.env.PI_AGY_GEMINI_DIR = geminiDir;

		const harness = createExtensionHarness();
		antigravityBridgeExtension(harness.pi);

		const runProviderTurn = async (
			ctx: ExtensionCommandContext,
			piSessionId: string,
			promptText: string,
			beforeTurnEnd?: () => void,
		) => {
			const provider = harness.providers.get(ANTIGRAVITY_PROVIDER_ID);
			assert.ok(provider?.streamSimple, "antigravity provider registered");
			const msg: UserMessage = { role: "user", content: promptText, timestamp: Date.now() };
			await harness.emit("before_agent_start", {}, ctx);
			await harness.emit("input", { source: "interactive", text: promptText }, ctx);
			await harness.emit("message_start", { message: msg }, ctx);
			const mirrorTools = createAgyMirrorToolDefinitions(new AgyTurnMirrorBroker()).map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			}));
			const stream = provider.streamSimple(
				TEST_MODEL,
				normalizeContext({ messages: [msg], tools: mirrorTools }),
				{ sessionId: piSessionId },
			);
			const assistant = await stream.result();
			assert.equal(assistant.stopReason, "stop", `turn error: ${assistant.errorMessage ?? ""}`);
			beforeTurnEnd?.();
			await harness.emit(
				"turn_end",
				{
					message: assistant,
					outcome: "completed",
					context: { llmMessages: [msg, assistant] },
				},
				ctx,
			);
			return assistant;
		};

		try {
			// Session 1: start, run turn with out-of-turn live update, verify before_agent_start clears live activity.
			const s1 = createUiContext({ cwd: root, piSessionId: "pi-ext-1" });
			await harness.emit("session_start", {}, s1.ctx);
			await runProviderTurn(s1.ctx, "pi-ext-1", "first turn emit-out-of-turn");

			const firstPromptCall = readCallsLog(callsLog).find((c) => c.method === "session/prompt");
			assert.ok(firstPromptCall?.sessionId, "first turn opened agy session");
			const agyId1 = firstPromptCall.sessionId;

			// Wait for the out-of-turn update emitted 40ms after end_turn.
			for (let i = 0; i < 40 && latestBgStatus(s1.ui) !== "agy ⚙ on its own"; i++) {
				await sleep(25);
			}
			assert.equal(latestBgStatus(s1.ui), "agy ⚙ on its own", "out-of-turn live status appears");
			assert.equal(latestBgWidget(s1.ui), true, "out-of-turn live widget appears");

			// before_agent_start clears live "working on its own" immediately instead of lingering for 20s.
			await harness.emit("before_agent_start", {}, s1.ctx);
			assert.equal(latestBgWidget(s1.ui), false, "before_agent_start clears live widget immediately");
			assert.equal(latestBgStatus(s1.ui), undefined, "before_agent_start clears live status immediately");

			// Write a running task transcript, switch away via model_select, then verify session_tree re-syncs watcher.
			writeRunningTaskTranscript(geminiDir, agyId1);
			const s1NonAgy = createUiContext({
				cwd: root,
				piSessionId: "pi-ext-1",
				provider: "openai",
				modelId: "gpt-5",
				uiRecorder: s1.ui,
			});
			await harness.emit("model_select", {}, s1NonAgy.ctx);
			assert.equal(latestBgWidget(s1.ui), false, "model_select to non-Antigravity clears widget");

			// Re-attaching via session_tree with an Antigravity context restores the background widget.
			await harness.emit("session_tree", {}, s1.ctx);
			assert.equal(latestBgWidget(s1.ui), true, "session_tree syncs background widget");

			// Switching back to non-Antigravity via model_select hides it again, and switching back restores it.
			await harness.emit("model_select", {}, s1NonAgy.ctx);
			assert.equal(latestBgWidget(s1.ui), false, "model_select hides widget");
			await harness.emit("model_select", {}, s1.ctx);
			assert.equal(latestBgWidget(s1.ui), true, "model_select back to Antigravity restores widget");

			// Switching to Pi session 2 stops watcher and tears down pi-ext-1's ledger (sends session/close).
			const s2 = createUiContext({ cwd: root, piSessionId: "pi-ext-2" });
			await harness.emit("session_start", {}, s2.ctx);
			assert.equal(latestBgWidget(s1.ui), false, "session_start for new Pi session clears old widget");
			const closedAfterSwitch = readCallsLog(callsLog).some(
				(c) => c.method === "session/close" && c.sessionId === agyId1,
			);
			assert.equal(closedAfterSwitch, true, "session_start closes previous Pi session's agy ledger");

			// Session 2: start a turn with running task transcript, then test session_compact clears widget & closes ledger.
			const agyId2 = "agy-life-2";
			await runProviderTurn(s2.ctx, "pi-ext-2", "second session turn", () => {
				writeRunningTaskTranscript(geminiDir, agyId2);
			});
			assert.equal(latestBgWidget(s2.ui), true);

			await harness.emit("session_compact", {}, s2.ctx);
			assert.equal(latestBgWidget(s2.ui), false, "session_compact clears background widget");
			const closedAfterCompact = readCallsLog(callsLog).some(
				(c) => c.method === "session/close" && c.sessionId === agyId2,
			);
			assert.equal(closedAfterCompact, true, "session_compact invalidates ledger");

			// Session 3: run turn with running task transcript, then test /agy logout stops watcher & clears widget.
			const s3 = createUiContext({ cwd: root, piSessionId: "pi-ext-3" });
			await harness.emit("session_start", {}, s3.ctx);
			const agyId3 = "agy-life-3";
			await runProviderTurn(s3.ctx, "pi-ext-3", "third session turn", () => {
				writeRunningTaskTranscript(geminiDir, agyId3);
			});
			assert.equal(latestBgWidget(s3.ui), true);

			const agyCmd = harness.commands.get("agy");
			assert.ok(agyCmd);
			await agyCmd.handler("logout", s3.ctx);
			assert.equal(latestBgWidget(s3.ui), false, "/agy logout clears background widget");
			assert.ok(
				readCallsLog(callsLog).some((c) => c.method === "auth/logout"),
				"/agy logout sent auth/logout",
			);
		} finally {
			const dummy = createUiContext({ cwd: root, piSessionId: "shutdown" });
			await harness.emit("session_shutdown", {}, dummy.ctx);
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			if (prevBin === undefined) delete process.env.PI_AGY_BIN;
			else process.env.PI_AGY_BIN = prevBin;
			if (prevGemini === undefined) delete process.env.PI_AGY_GEMINI_DIR;
			else process.env.PI_AGY_GEMINI_DIR = prevGemini;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

interface MockImportScenario {
	sessionId: string;
	title: string;
	updates: unknown[];
}

function writeImportMockAgy(
	root: string,
	geminiDir: string,
	callsLog: string,
	scenarios: MockImportScenario[],
): string {
	const source = `
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const callsLog = ${JSON.stringify(callsLog)};
const scenarios = ${JSON.stringify(scenarios)};
const scenarioById = new Map(scenarios.map((s) => [s.sessionId, s]));

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const log = (entry) => fs.appendFileSync(callsLog, JSON.stringify(entry) + "\\n");
const CONFIG_OPTIONS = [
	{ id: "model", name: "Model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] },
	{ id: "thought_level", name: "Thinking", type: "select", currentValue: "high", options: [{ value: "high", name: "high" }] },
	{ id: "mode", name: "Mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
];

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (!msg.method) return;
	const p = msg.params ?? {};
	log({ method: msg.method, sessionId: p.sessionId });
	const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });

	if (msg.method === "initialize") {
		reply({
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: true,
				sessionCapabilities: { resume: {}, close: {}, list: {}, load: {} },
				_meta: { antigravity: { tier: true } },
			},
			agentInfo: { name: "Mock Import AGY", version: "1.5.13" },
		});
		return;
	}
	if (msg.method === "session/list") {
		reply({
			sessions: scenarios.map((s) => ({
				sessionId: s.sessionId,
				cwd: ${JSON.stringify(root)},
				title: s.title,
				updatedAt: "2026-11-26T10:00:00Z",
			})),
		});
		return;
	}
	if (msg.method === "session/load") {
		const scenario = scenarioById.get(p.sessionId);
		if (!scenario) {
			send({ jsonrpc: "2.0", id: msg.id, error: { code: -32004, message: "not found" } });
			return;
		}
		for (const update of scenario.updates) {
			send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: p.sessionId, update } });
		}
		reply({ sessionId: p.sessionId, configOptions: CONFIG_OPTIONS });
		return;
	}
	if (msg.method === "session/new") {
		const first = scenarios[0]?.sessionId ?? "active-sess-1";
		reply({ sessionId: first, configOptions: CONFIG_OPTIONS });
		return;
	}
	if (msg.method === "session/resume") {
		reply({ sessionId: p.sessionId, configOptions: CONFIG_OPTIONS });
		return;
	}
	if (msg.method === "session/prompt") {
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: p.sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continued answer" } },
			},
		});
		reply({ stopReason: "end_turn", usage: { inputTokens: 8, outputTokens: 4 } });
		return;
	}
	if (msg.id !== undefined) {
		reply({});
	}
});
`;
	return writeExecutableScript(root, "mock-import-agy", source);
}

describe("/agy sessions import fixes", () => {
	it("captures dbCheckpoint on importedAnchor and enforces divergence refusal if prompted elsewhere", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-import-ckpt-"));
		const geminiDir = path.join(root, ".gemini");
		const callsLog = path.join(root, "calls.log");
		const sessionId = "11111111-2222-3333-4444-555555555555";
		seedConversationDb(geminiDir, sessionId, [14, 15]);

		const mockAgy = writeImportMockAgy(root, geminiDir, callsLog, [
			{
				sessionId,
				title: "Checkpoint Session",
				updates: [
					{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hello" } },
					{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi there" } },
				],
			},
		]);

		const harness = createExtensionHarness();
		const processManager = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coordinator = new TurnCoordinator(harness.pi, processManager, broker, {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: mockAgy,
			geminiDir,
		});
		registerAntigravityCommands({
			pi: harness.pi,
			processManager,
			coordinator,
			onRefreshProviderModels: async () => 0,
		});

		try {
			let importedMessages: Array<UserMessage | AssistantMessage | ToolResultMessage> = [];
			let importedAnchor: AgySessionAnchor | undefined;
			const cmdCtx = createUiContext({
				cwd: root,
				piSessionId: "pi-import-source",
				onNewSession: ({ messages, customEntries }) => {
					importedMessages = messages;
					const anchorEntry = customEntries.find((e) => e.customType === AGY_SESSION_ANCHOR_CUSTOM_TYPE);
					if (anchorEntry && isAgySessionAnchor(anchorEntry.data)) {
						importedAnchor = anchorEntry.data;
					}
				},
			});

			const agy = harness.commands.get("agy");
			assert.ok(agy);
			await agy.handler("sessions", cmdCtx.ctx);

			assert.equal(importedMessages.length, 2);
			assert.ok(importedAnchor, "imported anchor written");
			assert.equal(importedAnchor.agySessionId, sessionId);
			assert.equal(importedAnchor.importedRaw, true);
			assert.ok(importedAnchor.dbCheckpoint, "dbCheckpoint captured on importedAnchor");
			assert.equal(importedAnchor.dbCheckpoint.steps, 2);
			assert.ok(importedAnchor.dbCheckpoint.fingerprint.length > 0);

			// Simulate another client prompting the same agy conversation after import.
			appendConversationSteps(geminiDir, sessionId, [14, 15]);

			const anchorCustomEntry: CustomEntry<AgySessionAnchor> = {
				type: "custom",
				id: "entry-anchor-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: AGY_SESSION_ANCHOR_CUSTOM_TYPE,
				data: importedAnchor,
			};
			const resumedCtx = createUiContext({
				cwd: root,
				piSessionId: "pi-imported-diverged",
				branch: [anchorCustomEntry],
			});
			coordinator.setActiveContext(resumedCtx.ctx);

			const followUp: UserMessage = { role: "user", content: "continue here", timestamp: Date.now() };
			typedByHuman(coordinator.humanPromptGate, followUp);
			const mirrorTools = createAgyMirrorToolDefinitions(broker).map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			}));
			const stream = coordinator.streamSimple(
				TEST_MODEL,
				normalizeContext({ messages: [...importedMessages, followUp], tools: mirrorTools }),
				{ sessionId: "pi-imported-diverged" },
			);
			const result = await stream.result();
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage ?? "", /refusing to continue from this point/);
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("extracts inline content and rawOutput directly from tool_call replay updates", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-import-tools-"));
		const geminiDir = path.join(root, ".gemini");
		const callsLog = path.join(root, "calls.log");
		const sessionId = "22222222-3333-4444-5555-666666666666";
		seedConversationDb(geminiDir, sessionId, [14, 15]);

		const mockAgy = writeImportMockAgy(root, geminiDir, callsLog, [
			{
				sessionId,
				title: "Inline Tool Replay",
				updates: [
					{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Inspect repo" } },
					{
						sessionUpdate: "tool_call",
						toolCallId: "tc-content",
						title: "Read README.md",
						kind: "read",
						status: "completed",
						content: [{ type: "content", content: { type: "text", text: "inline content text" } }],
					},
					{
						sessionUpdate: "tool_call",
						toolCallId: "tc-raw",
						title: "Run tests",
						kind: "execute",
						status: "failed",
						rawOutput: "inline failure output",
					},
					{
						sessionUpdate: "tool_call",
						toolCallId: "tc-diff",
						title: "Edit src/app.ts",
						kind: "edit",
						status: "completed",
						content: [{ type: "diff", path: "src/app.ts", newText: "export const x = 1;" }],
					},
					{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done inspecting." } },
				],
			},
		]);

		const harness = createExtensionHarness();
		const processManager = new AcpProcessManager();
		const coordinator = new TurnCoordinator(harness.pi, processManager, new AgyTurnMirrorBroker(), {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: mockAgy,
			geminiDir,
		});
		registerAntigravityCommands({
			pi: harness.pi,
			processManager,
			coordinator,
			onRefreshProviderModels: async () => 0,
		});

		try {
			let importedMessages: Array<UserMessage | AssistantMessage | ToolResultMessage> = [];
			const cmdCtx = createUiContext({
				cwd: root,
				piSessionId: "pi-import-tools",
				onNewSession: ({ messages }) => {
					importedMessages = messages;
				},
			});
			const agy = harness.commands.get("agy");
			assert.ok(agy);
			await agy.handler("sessions", cmdCtx.ctx);

			const toolResults = importedMessages.filter((m): m is ToolResultMessage => m.role === "toolResult");
			assert.equal(toolResults.length, 3);
			assert.deepEqual(toolResults[0].content, [{ type: "text", text: "inline content text" }]);
			assert.equal(toolResults[0].isError, false);
			assert.deepEqual(toolResults[1].content, [{ type: "text", text: "inline failure output" }]);
			assert.equal(toolResults[1].isError, true);
			assert.deepEqual(toolResults[2].content, [{ type: "text", text: "Updated src/app.ts" }]);
			assert.equal(toolResults[2].isError, false);
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("drops trailing unanswered user messages so subsequent typed prompts pass HumanPromptGate and resume cleanly", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-import-trailing-"));
		const geminiDir = path.join(root, ".gemini");
		const callsLog = path.join(root, "calls.log");
		const partialId = "33333333-4444-5555-6666-777777777777";
		const userOnlyId = "44444444-5555-6666-7777-888888888888";
		seedConversationDb(geminiDir, partialId, [14, 15, 14]);
		seedConversationDb(geminiDir, userOnlyId, [14]);

		const mockAgy = writeImportMockAgy(root, geminiDir, callsLog, [
			{
				sessionId: partialId,
				title: "Trailing User Session",
				updates: [
					{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "First question" } },
					{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First answer" } },
					{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Aborted question" } },
				],
			},
			{
				sessionId: userOnlyId,
				title: "Only Unanswered User",
				updates: [
					{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Aborted first prompt" } },
				],
			},
		]);

		const harness = createExtensionHarness();
		const processManager = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coordinator = new TurnCoordinator(harness.pi, processManager, broker, {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: mockAgy,
			geminiDir,
		});
		registerAntigravityCommands({
			pi: harness.pi,
			processManager,
			coordinator,
			onRefreshProviderModels: async () => 0,
		});

		try {
			const agy = harness.commands.get("agy");
			assert.ok(agy);

			// 1. Session with completed turn + trailing unanswered user message: drops trailing user and allows continuation.
			let importedMessages: Array<UserMessage | AssistantMessage | ToolResultMessage> = [];
			let importedAnchor: AgySessionAnchor | undefined;
			const cmdCtx1 = createUiContext({
				cwd: root,
				piSessionId: "pi-trailing-src",
				selectResult: (items) => items.find((item) => item.includes("Trailing User Session")),
				onNewSession: ({ messages, customEntries }) => {
					importedMessages = messages;
					const anchorEntry = customEntries.find((e) => e.customType === AGY_SESSION_ANCHOR_CUSTOM_TYPE);
					if (anchorEntry && isAgySessionAnchor(anchorEntry.data)) {
						importedAnchor = anchorEntry.data;
					}
				},
			});
			await agy.handler("sessions", cmdCtx1.ctx);

			assert.equal(importedMessages.length, 2, "trailing unanswered user message was dropped");
			assert.equal(importedMessages[0].role, "user");
			assert.equal(importedMessages[1].role, "assistant");
			assert.ok(importedAnchor);
			assert.equal(importedAnchor.messageCount, 2);
			assert.equal(importedAnchor.transcriptDigest, computeTranscriptDigest(importedMessages));
			assert.match(cmdCtx1.ui.notes.at(-1)?.message ?? "", /skipped 1 unanswered trailing user message/);

			// Now continue in the imported Pi session with a real human prompt: must pass HumanPromptGate & session/resume!
			const anchorCustomEntry: CustomEntry<AgySessionAnchor> = {
				type: "custom",
				id: "entry-trailing-anchor",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: AGY_SESSION_ANCHOR_CUSTOM_TYPE,
				data: importedAnchor,
			};
			const resumedCtx = createUiContext({
				cwd: root,
				piSessionId: "pi-trailing-resumed",
				branch: [anchorCustomEntry],
			});
			coordinator.setActiveContext(resumedCtx.ctx);

			const nextUser: UserMessage = { role: "user", content: "Next real prompt", timestamp: Date.now() };
			typedByHuman(coordinator.humanPromptGate, nextUser);
			const mirrorTools = createAgyMirrorToolDefinitions(broker).map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			}));
			const stream = coordinator.streamSimple(
				TEST_MODEL,
				normalizeContext({ messages: [...importedMessages, nextUser], tools: mirrorTools }),
				{ sessionId: "pi-trailing-resumed" },
			);
			const result = await stream.result();
			assert.equal(result.stopReason, "stop", `expected resume to succeed, got: ${result.errorMessage ?? ""}`);
			assert.ok(
				readCallsLog(callsLog).some((c) => c.method === "session/resume" && c.sessionId === partialId),
				"imported session resumed via session/resume",
			);

			// 2. Session with ONLY unanswered user message(s): warns and does not create an empty Pi session.
			const cmdCtx2 = createUiContext({
				cwd: root,
				piSessionId: "pi-user-only-src",
				selectResult: (items) => items.find((item) => item.includes("Only Unanswered User")),
			});
			await agy.handler("sessions", cmdCtx2.ctx);
			assert.equal(cmdCtx2.newSessionCalls, 0, "does not create an empty Pi session");
			assert.equal(cmdCtx2.ui.notes.at(-1)?.level, "warning");
			assert.match(cmdCtx2.ui.notes.at(-1)?.message ?? "", /unanswered user message/);
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("invalidates the current Pi session's active ledger before session/load when importing the same agySessionId", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-import-active-"));
		const geminiDir = path.join(root, ".gemini");
		const callsLog = path.join(root, "calls.log");
		const activeId = "55555555-6666-7777-8888-999999999999";
		seedConversationDb(geminiDir, activeId, [14, 15]);

		const mockAgy = writeImportMockAgy(root, geminiDir, callsLog, [
			{
				sessionId: activeId,
				title: "Active Session",
				updates: [
					{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Original prompt" } },
					{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Original reply" } },
				],
			},
		]);

		const harness = createExtensionHarness();
		const processManager = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coordinator = new TurnCoordinator(harness.pi, processManager, broker, {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: mockAgy,
			geminiDir,
		});
		registerAntigravityCommands({
			pi: harness.pi,
			processManager,
			coordinator,
			onRefreshProviderModels: async () => 0,
		});

		try {
			let importedCount = 0;
			const cmdCtx = createUiContext({
				cwd: root,
				piSessionId: "pi-active-same",
				onNewSession: ({ messages }) => {
					importedCount = messages.length;
				},
			});
			coordinator.setActiveContext(cmdCtx.ctx);

			// First create an active ledger bound to activeId in the current Pi session.
			await runOneCoordinatorTurn(coordinator, broker, "pi-active-same", "Original prompt");
			assert.equal(coordinator.getTelemetrySnapshot("pi-active-same").agySessionId, activeId);

			const mark = readCallsLog(callsLog).length;
			const agy = harness.commands.get("agy");
			assert.ok(agy);
			await agy.handler("sessions", cmdCtx.ctx);

			const callsAfter = readCallsLog(callsLog).slice(mark);
			const closeIdx = callsAfter.findIndex((c) => c.method === "session/close" && c.sessionId === activeId);
			const loadIdx = callsAfter.findIndex((c) => c.method === "session/load" && c.sessionId === activeId);
			assert.ok(closeIdx >= 0, "active ledger was closed via session/close");
			assert.ok(loadIdx >= 0, "session/load ran");
			assert.ok(closeIdx < loadIdx, "session/close of active ledger happened BEFORE session/load");
			assert.equal(coordinator.getTelemetrySnapshot("pi-active-same").agySessionId, undefined);
			assert.equal(importedCount, 2);
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
