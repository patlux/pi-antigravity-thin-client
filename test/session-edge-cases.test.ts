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
	type ToolCall,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { AcpProcessManager } from "../src/acp/process-manager.ts";
import { DEFAULT_BRIDGE_CONFIG, type BridgeConfig } from "../src/config.ts";
import {
	AGY_SESSION_ANCHOR_CUSTOM_TYPE,
	captureSqliteCheckpoint,
	findBranchAnchorForHistory,
} from "../src/session/checkpoint-sync.ts";
import { computeTranscriptDigest, exceedsSafeSingleStepBudget } from "../src/session/reconcile.ts";
import { TurnCoordinator } from "../src/session/turn-coordinator.ts";
import {
	AgyTurnMirrorBroker,
	createAgyMirrorToolDefinitions,
} from "../src/tools/agy-mirror-tools.ts";
import { interactiveContext, interactiveToolContext, typedByHuman } from "./human-input.ts";

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
	return "appendEntry" in value && "getSessionName" in value && "setSessionName" in value;
}

function createStubPi(options?: {
	onAppendEntry?: (customType: string, data: unknown) => void;
	getSessionName?: () => string | undefined;
	onSetSessionName?: (name: string) => void;
}): ExtensionAPI {
	const stub = {
		appendEntry(customType: string, data: unknown) {
			options?.onAppendEntry?.(customType, data);
		},
		getSessionName() {
			return options?.getSessionName?.();
		},
		setSessionName(name: string) {
			options?.onSetSessionName?.(name);
		},
		getAllTools() {
			return [];
		},
	};
	if (!isExtensionApi(stub)) {
		throw new Error("stub ExtensionAPI missing required methods");
	}
	return stub;
}

function makeUser(content: UserMessage["content"], timestamp: number): UserMessage {
	return { role: "user", content, timestamp };
}

function makeAssistant(
	text: string,
	stopReason: AssistantMessage["stopReason"],
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "antigravity-acp",
		provider: "antigravity",
		model: "gemini-4-neon",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

function makeToolResult(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "agy_bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp,
	};
}

function createConversationDb(dbPath: string, sessionId: string, stepRows?: Array<[number, number, number]>): void {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	try {
		db.exec(`
			PRAGMA user_version = 1;
			CREATE TABLE IF NOT EXISTS trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer);
			CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0);
			CREATE TABLE IF NOT EXISTS gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
			CREATE TABLE IF NOT EXISTS executor_metadata (idx integer PRIMARY KEY, data blob);
			CREATE TABLE IF NOT EXISTS parent_references (idx integer PRIMARY KEY, data blob);
			CREATE TABLE IF NOT EXISTS trajectory_metadata_blob (id text PRIMARY KEY DEFAULT "main", data blob);
		`);
		db.prepare("INSERT OR REPLACE INTO trajectory_meta VALUES (?, ?, 4, 17)").run(sessionId, sessionId);
		db.prepare("INSERT OR REPLACE INTO trajectory_metadata_blob VALUES ('main', ?)").run(
			Buffer.from(`mock-meta:default-agy-agent:${sessionId}`, "utf8"),
		);
		if (stepRows) {
			const insert = db.prepare("INSERT OR REPLACE INTO steps (idx, step_type, status) VALUES (?, ?, ?)");
			for (const [idx, stepType, status] of stepRows) {
				insert.run(idx, stepType, status);
			}
		}
	} finally {
		db.close();
	}
}

/**
 * Lightweight mock `agy` binary for testing TurnCoordinator session edge cases without
 * ever reaching the real `agy` CLI.
 */
function writeEdgeCaseMockAgy(dir: string): { bin: string; callsLog: string } {
	const scriptPath = path.join(dir, "mock-agy-edge.mjs");
	const callsLog = path.join(dir, "calls.jsonl");
	const source = `#!/usr/bin/env node
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const callsLog = path.join(rootDir, "calls.jsonl");
let sessionCounter = 0;

function send(obj) {
	process.stdout.write(JSON.stringify(obj) + "\\n");
}

function logCall(entry) {
	fs.appendFileSync(callsLog, JSON.stringify(entry) + "\\n");
}

function seedDb(sessionId) {
	const convDir = path.join(rootDir, ".gemini", "antigravity-cli", "conversations");
	fs.mkdirSync(convDir, { recursive: true });
	const db = new DatabaseSync(path.join(convDir, sessionId + ".db"));
	db.exec(\`
		PRAGMA user_version = 1;
		CREATE TABLE IF NOT EXISTS trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer);
		CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0);
		CREATE TABLE IF NOT EXISTS gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
		CREATE TABLE IF NOT EXISTS executor_metadata (idx integer PRIMARY KEY, data blob);
		CREATE TABLE IF NOT EXISTS parent_references (idx integer PRIMARY KEY, data blob);
		CREATE TABLE IF NOT EXISTS trajectory_metadata_blob (id text PRIMARY KEY DEFAULT "main", data blob);
	\`);
	db.prepare("INSERT OR REPLACE INTO trajectory_meta VALUES (?, ?, 4, 17)").run(sessionId, sessionId);
	db.prepare("INSERT OR REPLACE INTO trajectory_metadata_blob VALUES ('main', ?)").run(
		Buffer.from("mock-meta:default-agy-agent:" + sessionId, "utf8"),
	);
	db.close();
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method) {
		const promptText = Array.isArray(msg.params?.prompt)
			? msg.params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("\\n")
			: undefined;
		logCall({ method: msg.method, sessionId: msg.params?.sessionId, promptLength: promptText?.length ?? 0, promptHead: promptText?.slice(0, 64) });
	}

	if (msg.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				protocolVersion: 1,
				agentCapabilities: {
					mcpCapabilities: { http: true },
					sessionCapabilities: { resume: {}, close: {}, list: {}, load: {}, additionalDirectories: {} },
				},
				agentInfo: { name: "Mock AGY Edge", version: "1.5.13" },
			},
		});
		return;
	}

	if (msg.method === "session/new") {
		const sessionId = "edge-sess-" + (++sessionCounter) + "-" + crypto.randomUUID().slice(0, 8);
		seedDb(sessionId);
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				sessionId,
				models: {
					availableModels: [
						{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
						{ modelId: "gpt-oss-120b-medium", name: "GPT OSS 120B (Medium)" },
					],
				},
				configOptions: [
					{
						id: "model",
						name: "Model",
						type: "select",
						currentValue: "gemini-4-neon",
						options: [
							{ value: "gemini-4-neon", name: "Gemini 4 Neon" },
							{ value: "gpt-oss-120b-medium", name: "GPT OSS 120B (Medium)" },
						],
					},
					{
						id: "thought_level",
						name: "Thinking",
						type: "select",
						currentValue: "high",
						options: [
							{ value: "medium", name: "Medium" },
							{ value: "high", name: "High" },
						],
					},
					{ id: "mode", name: "Mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
				],
			},
		});
		return;
	}

	if (msg.method === "session/resume") {
		const sessionId = msg.params?.sessionId;
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				sessionId,
				models: { availableModels: [{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" }] },
				configOptions: [
					{ id: "model", name: "Model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] },
					{ id: "thought_level", name: "Thinking", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
					{ id: "mode", name: "Mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
				],
			},
		});
		return;
	}

	if (msg.method === "session/set_config_option" || msg.method === "session/close") {
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
		return;
	}

	if (msg.method === "session/cancel") {
		return;
	}

	if (msg.method === "session/prompt") {
		const sessionId = msg.params.sessionId;
		const text = (msg.params.prompt || [])
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\\n");

		if (text.startsWith("EMIT_DELAYED_UPDATES")) {
			send({
				jsonrpc: "2.0",
				method: "session/update",
				params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ready" } } },
			});
			send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
			const triggerFile = path.join(rootDir, "emit-delayed-now");
			const poll = setInterval(() => {
				if (!fs.existsSync(triggerFile)) return;
				clearInterval(poll);
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: { sessionId, update: { sessionUpdate: "session_info_update", title: "Background Session Title" } },
				});
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: { sessionId, update: { sessionUpdate: "usage_update", used: 42000, size: 1048576 } },
				});
			}, 10);
			poll.unref();
			return;
		}

		if (text.startsWith("EMIT_IMMEDIATE_UPDATES")) {
			send({
				jsonrpc: "2.0",
				method: "session/update",
				params: { sessionId, update: { sessionUpdate: "session_info_update", title: "Current Session Title" } },
			});
			send({
				jsonrpc: "2.0",
				method: "session/update",
				params: { sessionId, update: { sessionUpdate: "usage_update", used: 12000, size: 1048576 } },
			});
			send({
				jsonrpc: "2.0",
				method: "session/update",
				params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "updated" } } },
			});
			send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
			return;
		}

		if (text.startsWith("SUBAGENT_CASES")) {
			const calls = [
				{
					toolCallId: "sub-inherit-other",
					title: "Run invoke_subagent",
					kind: "other",
					status: "pending",
					rawInput: { Role: "Researcher", TypeName: "researcher", Model: "inherit", Prompt: "Check docs" },
				},
				{
					toolCallId: "sub-inherit-upper",
					title: "Run invoke_subagent",
					kind: "other",
					status: "pending",
					rawInput: { Role: "Auditor", TypeName: "auditor", Model: "INHERIT", Prompt: "Audit code" },
				},
				{
					toolCallId: "sub-self-omitted",
					title: "Run invoke_subagent",
					kind: "other",
					status: "pending",
					rawInput: { Role: "SelfWorker", TypeName: "self", Prompt: "Do work" },
				},
				{
					toolCallId: "sub-explicit-model",
					title: "Run invoke_subagent",
					kind: "other",
					status: "pending",
					rawInput: { Role: "ExplicitWorker", TypeName: "researcher", Model: "claude-sonnet-4-6", Prompt: "Analyze" },
				},
				{
					toolCallId: "sub-other-omitted",
					title: "Run invoke_subagent",
					kind: "other",
					status: "pending",
					rawInput: { Role: "DefaultResearcher", TypeName: "researcher", Prompt: "Browse" },
				},
			];
			for (const c of calls) {
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: { sessionId, update: { sessionUpdate: "tool_call", ...c } },
				});
			}
			setTimeout(() => {
				for (const c of calls) {
					send({
						jsonrpc: "2.0",
						method: "session/update",
						params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: c.toolCallId, status: "completed", rawOutput: "done" } },
					});
				}
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "spawned" } } },
				});
				send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
			}, 40);
			return;
		}

		if (text.startsWith("STRAY_TOOL_UPDATES")) {
			// 1. Stray tool_call_update for an ID never announced in this turn.
			send({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "stray-call-999",
						title: "Stray background update",
						status: "completed",
						rawOutput: "orphan output",
					},
				},
			});
			// 2. Real tool_call followed immediately by an early tool_call_update (before dequeue).
			send({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId,
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "real-call-1",
						title: "echo ok",
						kind: "execute",
						status: "pending",
						rawInput: { CommandLine: "echo ok" },
					},
				},
			});
			send({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "real-call-1",
						status: "completed",
						rawOutput: "real output",
					},
				},
			});
			// 3. After Pi consumes real-call-1, send a late duplicate update for real-call-1 before turn finishes.
			setTimeout(() => {
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId,
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: "real-call-1",
							status: "completed",
							rawOutput: "late duplicate output",
						},
					},
				});
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "finished" } } },
				});
				send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
			}, 120);
			return;
		}

		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo:" + text.length } } },
		});
		send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
	}
});
`;
	fs.writeFileSync(scriptPath, source, { mode: 0o755 });
	if (process.platform === "win32") {
		const cmdPath = path.join(dir, "mock-agy-edge.cmd");
		fs.writeFileSync(cmdPath, `@node "${scriptPath}" %*\r\n`);
		return { bin: cmdPath, callsLog };
	}
	return { bin: scriptPath, callsLog };
}

function readMockCalls(callsLog: string): Array<{ method: string; sessionId?: string; promptLength?: number }> {
	if (!fs.existsSync(callsLog)) return [];
	return fs
		.readFileSync(callsLog, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === "object" && "method" in parsed && typeof parsed.method === "string") {
				return {
					method: parsed.method,
					sessionId: "sessionId" in parsed && typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
					promptLength:
						"promptLength" in parsed && typeof parsed.promptLength === "number" ? parsed.promptLength : undefined,
				};
			}
			return { method: "" };
		});
}

function promptOfPayload(payload: unknown): Array<{ type: string; text?: string }> {
	if (payload && typeof payload === "object" && "prompt" in payload && Array.isArray(payload.prompt)) {
		return payload.prompt.filter(
			(item): item is { type: string; text?: string } =>
				Boolean(item) && typeof item === "object" && "type" in item && typeof item.type === "string",
		);
	}
	return [];
}

describe("session coordination and resume edge cases", () => {
	it("Task 1: sends oversized (>110 KB) continuation prompts and projected history directly on the live thin-client session", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-edge-t1-live-"));
		const mock = writeEdgeCaseMockAgy(root);
		const config: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: mock.bin,
			geminiDir: path.join(root, ".gemini"),
		};
		const broker = new AgyTurnMirrorBroker();
		const coordinator = new TurnCoordinator(createStubPi(), new AcpProcessManager(), broker, config);
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
		const piSessionId = "edge-t1-live";
		coordinator.setActiveContext(
			interactiveContext(root, { sessionManager: { getSessionId: () => piSessionId, getBranch: () => [] } }),
		);

		try {
			// Turn 1 includes 4 user images so we can later project all 4 into traffic-opt placeholders (delta = 4 >= 4).
			const turn1User = makeUser(
				[
					{ type: "text", text: "Inspect these four screenshots" },
					{ type: "image", data: "IMG1", mimeType: "image/png" },
					{ type: "image", data: "IMG2", mimeType: "image/png" },
					{ type: "image", data: "IMG3", mimeType: "image/png" },
					{ type: "image", data: "IMG4", mimeType: "image/png" },
				],
				1,
			);
			typedByHuman(coordinator.humanPromptGate, turn1User);
			const turn1 = await coordinator
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [turn1User], tools }), { sessionId: piSessionId })
				.result();
			assert.equal(turn1.stopReason, "stop", turn1.errorMessage);
			assert.ok(turn1.responseId);

			// Turn 2: both oversized (>110 KB) AND prior history now carries 4 archived image placeholders.
			const hugeText = "A".repeat(125_000);
			assert.equal(exceedsSafeSingleStepBudget([{ type: "text", text: hugeText }]), true);
			const projectedTurn1User = makeUser(
				[
					{ type: "text", text: "Inspect these four screenshots" },
					{ type: "text", text: `[已归档图片 ctx://image/${"a".repeat(64)}]` },
					{ type: "text", text: `[已归档图片 ctx://image/${"b".repeat(64)}]` },
					{ type: "text", text: `[已归档图片 ctx://image/${"c".repeat(64)}]` },
					{ type: "text", text: `[已归档图片 ctx://image/${"d".repeat(64)}]` },
				],
				1,
			);
			const turn2User = makeUser(hugeText, 2);
			typedByHuman(coordinator.humanPromptGate, turn2User);

			const sentPayloads: unknown[] = [];
			const turn2 = await coordinator
				.streamSimple(
					TEST_MODEL,
					normalizeContext({ messages: [projectedTurn1User, turn1, turn2User], tools }),
					{
						sessionId: piSessionId,
						onPayload: (payload) => {
							sentPayloads.push(payload);
						},
					},
				)
				.result();

			assert.equal(turn2.stopReason, "stop", turn2.errorMessage);
			assert.equal(turn2.responseId, turn1.responseId, "live session must stay intact");
			const calls = readMockCalls(mock.callsLog).map((c) => c.method);
			assert.equal(calls.filter((m) => m === "session/new").length, 1);
			assert.equal(calls.filter((m) => m === "session/close").length, 0);
			assert.equal(sentPayloads.length, 1);
			assert.deepEqual(promptOfPayload(sentPayloads[0]), [{ type: "text", text: hugeText }]);
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("Task 1: resumes thin-client session directly with oversized prompt even when projection changed", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-edge-t1-resume-"));
		const mock = writeEdgeCaseMockAgy(root);
		const config: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: mock.bin,
			geminiDir: path.join(root, ".gemini"),
		};
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const piSessionId = "edge-t1-resume";
		const startCoordinator = () => {
			const pi = createStubPi({
				onAppendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			});
			const broker = new AgyTurnMirrorBroker();
			const coordinator = new TurnCoordinator(pi, new AcpProcessManager(), broker, config);
			coordinator.setActiveContext(
				interactiveContext(root, { sessionManager: { getSessionId: () => piSessionId, getBranch: () => entries } }),
			);
			const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			}));
			return { coordinator, tools };
		};

		try {
			const firstProc = startCoordinator();
			const turn1User = makeUser(
				[
					{ type: "text", text: "Initial screenshots" },
					{ type: "image", data: "IMG1", mimeType: "image/png" },
					{ type: "image", data: "IMG2", mimeType: "image/png" },
					{ type: "image", data: "IMG3", mimeType: "image/png" },
					{ type: "image", data: "IMG4", mimeType: "image/png" },
				],
				1,
			);
			let turn1: AssistantMessage;
			try {
				typedByHuman(firstProc.coordinator.humanPromptGate, turn1User);
				turn1 = await firstProc.coordinator
					.streamSimple(TEST_MODEL, normalizeContext({ messages: [turn1User], tools: firstProc.tools }), {
						sessionId: piSessionId,
					})
					.result();
				assert.equal(turn1.stopReason, "stop");
				assert.ok(turn1.responseId);
				const dbPath = path.join(
					config.geminiDir,
					config.appDataDirName,
					"conversations",
					`${turn1.responseId}.db`,
				);
				createConversationDb(dbPath, turn1.responseId, [
					[0, 14, 3],
					[1, 15, 3],
				]);
				await firstProc.coordinator.persistTurnAnchor([turn1User, turn1], piSessionId);
				assert.equal(entries.length, 1);
			} finally {
				await firstProc.coordinator.dispose();
			}

			fs.rmSync(mock.callsLog, { force: true });

			const secondProc = startCoordinator();
			try {
				const projectedTurn1User = makeUser(
					[
						{ type: "text", text: "Initial screenshots" },
						{ type: "text", text: `[已归档图片 ctx://image/${"1".repeat(64)}]` },
						{ type: "text", text: `[已归档图片 ctx://image/${"2".repeat(64)}]` },
						{ type: "text", text: `[已归档图片 ctx://image/${"3".repeat(64)}]` },
						{ type: "text", text: `[已归档图片 ctx://image/${"4".repeat(64)}]` },
					],
					1,
				);
				const hugeResumePrompt = "B".repeat(125_000);
				const turn2User = makeUser(hugeResumePrompt, 2);
				typedByHuman(secondProc.coordinator.humanPromptGate, turn2User);
				const sentPayloads: unknown[] = [];

				const turn2 = await secondProc.coordinator
					.streamSimple(
						TEST_MODEL,
						normalizeContext({ messages: [projectedTurn1User, turn1, turn2User], tools: secondProc.tools }),
						{
							sessionId: piSessionId,
							onPayload: (payload) => {
								sentPayloads.push(payload);
							},
						},
					)
					.result();

				assert.equal(turn2.stopReason, "stop", turn2.errorMessage);
				assert.equal(turn2.responseId, turn1.responseId);
				const methods = readMockCalls(mock.callsLog).map((c) => c.method);
				assert.ok(methods.includes("session/resume"), methods.join(","));
				assert.ok(!methods.includes("session/new"), methods.join(","));
				assert.equal(sentPayloads.length, 1);
				assert.deepEqual(promptOfPayload(sentPayloads[0]), [{ type: "text", text: hugeResumePrompt }]);
			} finally {
				await secondProc.coordinator.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("Task 2: findBranchAnchorForHistory matches exact anchor across failed/aborted turns without tool results", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-edge-t2-anchor-"));
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			enableSqliteFork: false,
			geminiDir: path.join(root, ".gemini"),
		};
		const agySessionId = "anchor-failed-turns";
		const dbPath = path.join(cfg.geminiDir, cfg.appDataDirName, "conversations", `${agySessionId}.db`);
		try {
			createConversationDb(dbPath, agySessionId, [
				[0, 14, 3],
				[1, 15, 3],
			]);
			const u1 = makeUser("first", 1);
			const a1 = makeAssistant("first answer", "stop", 2);
			const entries: SessionEntry[] = [
				{
					type: "custom",
					id: "anchor-1",
					parentId: null,
					timestamp: "2026-11-26T00:00:00Z",
					customType: AGY_SESSION_ANCHOR_CUSTOM_TYPE,
					data: {
						version: 1,
						agySessionId,
						toolMode: "agy-tools",
						transcriptDigest: computeTranscriptDigest([u1, a1]),
						messageCount: 2,
						mountDigest: "m1",
						toolsDigest: "",
						dbCheckpoint: { steps: 2, generations: 0, executions: 0, fingerprint: "fp" },
					},
				},
			];

			// Failed/aborted turns after anchor with no tool results -> exact match.
			const u2 = makeUser("refused goal", 3);
			const a2Err = makeAssistant("", "error", 4);
			const u3 = makeUser("aborted startup", 5);
			const a3Aborted = makeAssistant("", "aborted", 6);
			const matchFailed = findBranchAnchorForHistory({
				branchEntries: entries,
				priorMessages: [u1, a1, u2, a2Err, u3, a3Aborted],
				toolMode: "agy-tools",
				mountDigest: "m1",
				config: cfg,
			});
			assert.equal(matchFailed.kind, "exact");

			// Delta containing a toolResult -> must NOT match as exact.
			const a2Tool = makeAssistant("", "toolUse", 4);
			const tr2 = makeToolResult("call-1", 5);
			const matchWithTool = findBranchAnchorForHistory({
				branchEntries: entries,
				priorMessages: [u1, a1, u2, a2Tool, tr2, a3Aborted],
				toolMode: "agy-tools",
				mountDigest: "m1",
				config: cfg,
			});
			assert.equal(matchWithTool.kind, "none");

			// Delta containing a completed assistant turn before a later error -> must NOT match as exact.
			const a2Done = makeAssistant("completed", "stop", 4);
			const matchAfterCompleted = findBranchAnchorForHistory({
				branchEntries: entries,
				priorMessages: [u1, a1, u2, a2Done, u3, a3Aborted],
				toolMode: "agy-tools",
				mountDigest: "m1",
				config: cfg,
			});
			assert.equal(matchAfterCompleted.kind, "none");

			// Delta ending with a user message (no failed assistant) -> must NOT match as exact.
			const matchTrailingUser = findBranchAnchorForHistory({
				branchEntries: entries,
				priorMessages: [u1, a1, u2],
				toolMode: "agy-tools",
				mountDigest: "m1",
				config: cfg,
			});
			assert.equal(matchTrailingUser.kind, "none");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("Task 2: resumes after a refused/failed turn unseen by agy, but still refuses when agy recorded USER_INPUT", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-edge-t2-resume-"));
		const mock = writeEdgeCaseMockAgy(root);
		const config: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: mock.bin,
			geminiDir: path.join(root, ".gemini"),
		};
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const piSessionId = "edge-t2-resume";
		const startCoordinator = () => {
			const pi = createStubPi({
				onAppendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			});
			const broker = new AgyTurnMirrorBroker();
			const coordinator = new TurnCoordinator(pi, new AcpProcessManager(), broker, config);
			coordinator.setActiveContext(
				interactiveContext(root, { sessionManager: { getSessionId: () => piSessionId, getBranch: () => entries } }),
			);
			const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			}));
			return { coordinator, tools };
		};

		try {
			const u1 = makeUser("turn 1 prompt", 1);
			let a1: AssistantMessage;
			const firstProc = startCoordinator();
			try {
				typedByHuman(firstProc.coordinator.humanPromptGate, u1);
				a1 = await firstProc.coordinator
					.streamSimple(TEST_MODEL, normalizeContext({ messages: [u1], tools: firstProc.tools }), {
						sessionId: piSessionId,
					})
					.result();
				assert.equal(a1.stopReason, "stop");
				assert.ok(a1.responseId);
				const dbPath = path.join(
					config.geminiDir,
					config.appDataDirName,
					"conversations",
					`${a1.responseId}.db`,
				);
				createConversationDb(dbPath, a1.responseId, [
					[0, 14, 3],
					[1, 15, 3],
				]);
				await firstProc.coordinator.persistTurnAnchor([u1, a1], piSessionId);
				assert.equal(entries.length, 1);
			} finally {
				await firstProc.coordinator.dispose();
			}

			// Case A: agy never saw the refused turn (DB still only has steps 0..1) -> resumes cleanly!
			fs.rmSync(mock.callsLog, { force: true });
			const secondProc = startCoordinator();
			try {
				const uRefused = makeUser("automated goal message", 2);
				const aRefused = makeAssistant("", "error", 3);
				const uNext = makeUser("real follow-up after refusal", 4);
				typedByHuman(secondProc.coordinator.humanPromptGate, uNext);
				const sent: unknown[] = [];

				const res = await secondProc.coordinator
					.streamSimple(
						TEST_MODEL,
						normalizeContext({ messages: [u1, a1, uRefused, aRefused, uNext], tools: secondProc.tools }),
						{ sessionId: piSessionId, onPayload: (payload) => { sent.push(payload); } },
					)
					.result();

				assert.equal(res.stopReason, "stop", res.errorMessage);
				assert.equal(res.responseId, a1.responseId);
				const methods = readMockCalls(mock.callsLog).map((c) => c.method);
				assert.ok(methods.includes("session/resume"), methods.join(","));
				assert.ok(!methods.includes("session/new"), methods.join(","));
				assert.equal(sent.length, 1);
				assert.deepEqual(promptOfPayload(sent[0]), [{ type: "text", text: "real follow-up after refusal" }]);
			} finally {
				await secondProc.coordinator.dispose();
			}

			// Case B: agy DID record a USER_INPUT step (step_type = 14) for the aborted turn -> RESUME_DIVERGED_REFUSED!
			const dbPath = path.join(
				config.geminiDir,
				config.appDataDirName,
				"conversations",
				`${a1.responseId}.db`,
			);
			const db = new DatabaseSync(dbPath);
			try {
				db.exec("INSERT INTO steps (idx, step_type, status) VALUES (2, 14, 4)");
			} finally {
				db.close();
			}

			fs.rmSync(mock.callsLog, { force: true });
			const thirdProc = startCoordinator();
			try {
				const uAborted = makeUser("aborted after reaching agy", 5);
				const aAborted = makeAssistant("", "aborted", 6);
				const uNext = makeUser("next after diverged abort", 7);
				typedByHuman(thirdProc.coordinator.humanPromptGate, uNext);
				const sent: unknown[] = [];

				const res = await thirdProc.coordinator
					.streamSimple(
						TEST_MODEL,
						normalizeContext({ messages: [u1, a1, uAborted, aAborted, uNext], tools: thirdProc.tools }),
						{ sessionId: piSessionId, onPayload: (payload) => { sent.push(payload); } },
					)
					.result();

				assert.equal(res.stopReason, "error");
				assert.match(res.errorMessage ?? "", /refusing to continue from this point/);
				assert.equal(sent.length, 0);
				const methods = readMockCalls(mock.callsLog).map((c) => c.method);
				assert.ok(!methods.includes("session/resume"), methods.join(","));
				assert.ok(!methods.includes("session/prompt"), methods.join(","));
			} finally {
				await thirdProc.coordinator.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("Task 2: captureSqliteCheckpoint retries when DB file or steps appear slightly after turn end", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-edge-t2-retry-"));
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			geminiDir: path.join(root, ".gemini"),
		};
		const convDir = path.join(cfg.geminiDir, cfg.appDataDirName, "conversations");

		try {
			// Subcase 1: DB file does not exist initially, created 20ms later with steps.
			const delayedFileId = "delayed-file-session";
			const delayedFilePath = path.join(convDir, `${delayedFileId}.db`);
			const createTimer = setTimeout(() => {
				createConversationDb(delayedFilePath, delayedFileId, [
					[0, 14, 3],
					[1, 15, 3],
				]);
			}, 20);
			try {
				const cp1 = await captureSqliteCheckpoint(cfg, delayedFileId, [15, 30, 50]);
				assert.ok(cp1, "expected checkpoint after delayed file creation");
				assert.equal(cp1.steps, 2);
			} finally {
				clearTimeout(createTimer);
			}

			// Subcase 2: DB exists with empty steps table initially, WAL/steps flushed 20ms later.
			const delayedStepsId = "delayed-steps-session";
			const delayedStepsPath = path.join(convDir, `${delayedStepsId}.db`);
			createConversationDb(delayedStepsPath, delayedStepsId);
			const flushTimer = setTimeout(() => {
				const db = new DatabaseSync(delayedStepsPath);
				try {
					db.exec("INSERT INTO steps (idx, step_type, status) VALUES (0, 14, 3), (1, 15, 3)");
				} finally {
					db.close();
				}
			}, 20);
			try {
				const cp2 = await captureSqliteCheckpoint(cfg, delayedStepsId, [15, 30, 50]);
				assert.ok(cp2, "expected checkpoint after delayed steps flush");
				assert.equal(cp2.steps, 2);
			} finally {
				clearTimeout(flushTimer);
			}

			// Subcase 3: DB remains empty -> still returns undefined after bounded retries.
			const alwaysEmptyId = "always-empty-session";
			createConversationDb(path.join(convDir, `${alwaysEmptyId}.db`), alwaysEmptyId);
			const cpEmpty = await captureSqliteCheckpoint(cfg, alwaysEmptyId, [5, 5]);
			assert.equal(cpEmpty, undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("Task 3: guards session_info_update and usage_update against cross-session bleed", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-edge-t3-bleed-"));
		const mock = writeEdgeCaseMockAgy(root);
		const config: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: mock.bin,
			geminiDir: path.join(root, ".gemini"),
		};
		const setNames: string[] = [];
		const statusCalls: string[] = [];
		const modelA: Model<"antigravity-acp"> = { ...TEST_MODEL, contextWindow: 512_000 };
		const modelB: Model<"antigravity-acp"> = { ...TEST_MODEL, contextWindow: 200_000 };

		const pi = createStubPi({
			getSessionName: () => undefined,
			onSetSessionName: (name) => setNames.push(name),
		});
		const broker = new AgyTurnMirrorBroker();
		const coordinator = new TurnCoordinator(pi, new AcpProcessManager(), broker, config);
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));

		const makeCtx = (sessionId: string, model: Model<"antigravity-acp">): ExtensionContext => {
			const base = interactiveContext(root, {
				model,
				sessionManager: {
					getSessionId: () => sessionId,
					getBranch: () => [],
				},
			});
			base.ui.setStatus = (key) => {
				statusCalls.push(`${sessionId}:${key}`);
			};
			return base;
		};

		coordinator.setActiveContext(makeCtx("session-a", modelA));

		try {
			// Start Session A, which waits for `emit-delayed-now` before emitting background updates.
			const promptA = makeUser("EMIT_DELAYED_UPDATES", 1);
			typedByHuman(coordinator.humanPromptGate, promptA);
			const resA = await coordinator
				.streamSimple(modelA, normalizeContext({ messages: [promptA], tools }), { sessionId: "session-a" })
				.result();
			assert.equal(resA.stopReason, "stop");

			// Switch Pi's active session to Session B, then release Session A's delayed updates.
			coordinator.setActiveContext(makeCtx("session-b", modelB));
			statusCalls.length = 0;
			fs.writeFileSync(path.join(root, "emit-delayed-now"), "go");

			// Wait until Session A's ledger receives the delayed usage_update.
			for (let i = 0; i < 60; i++) {
				if (coordinator.getTelemetrySnapshot("session-a").usedTokens === 42_000) break;
				await new Promise((r) => setTimeout(r, 15));
			}

			assert.equal(coordinator.getTelemetrySnapshot("session-a").usedTokens, 42_000);
			assert.equal(coordinator.getTelemetrySnapshot("session-a").windowSize, 1_048_576);
			assert.equal(setNames.length, 0, "non-active session must not name Session B");
			assert.equal(modelB.contextWindow, 200_000, "non-active session must not mutate Session B's contextWindow");
			assert.equal(statusCalls.length, 0, "non-active session must not update Session B's status bar");

			// Positive check: when Session B itself receives updates, they DO apply to Session B.
			const promptB = makeUser("EMIT_IMMEDIATE_UPDATES", 2);
			typedByHuman(coordinator.humanPromptGate, promptB);
			const resB = await coordinator
				.streamSimple(modelB, normalizeContext({ messages: [promptB], tools }), { sessionId: "session-b" })
				.result();
			assert.equal(resB.stopReason, "stop");
			assert.deepEqual(setNames, ["Current Session Title"]);
			assert.equal(modelB.contextWindow, 1_048_576);
			assert.ok(statusCalls.some((entry) => entry.startsWith("session-b:")));
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("Task 4: withParentModel resolves inherit for any agentType and avoids double reasoning suffixes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-edge-t4-parent-model-"));
		const mock = writeEdgeCaseMockAgy(root);
		const config: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: mock.bin,
			geminiDir: path.join(root, ".gemini"),
		};
		const broker = new AgyTurnMirrorBroker();
		const coordinator = new TurnCoordinator(createStubPi(), new AcpProcessManager(), broker, config);
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
		coordinator.setActiveContext(
			interactiveContext(root, { sessionManager: { getSessionId: () => "t4-a", getBranch: () => [] } }),
		);

		try {
			// Case 1: parent runs gemini-4-neon with reasoning "high".
			const p1 = makeUser("SUBAGENT_CASES", 1);
			typedByHuman(coordinator.humanPromptGate, p1);
			const msg1 = await coordinator
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [p1], tools }), {
					sessionId: "t4-a",
					reasoning: "high",
				})
				.result();
			assert.equal(msg1.stopReason, "toolUse");
			const calls1 = msg1.content.filter((c): c is ToolCall => c.type === "toolCall");
			const byId1 = new Map(calls1.map((c) => [c.id, c]));

			const inheritOther = byId1.get("sub-inherit-other");
			assert.ok(inheritOther);
			assert.equal(inheritOther.arguments.model, undefined);
			assert.equal(inheritOther.arguments.parentModel, "gemini-4-neon-high");

			const inheritUpper = byId1.get("sub-inherit-upper");
			assert.ok(inheritUpper);
			assert.equal(inheritUpper.arguments.model, undefined);
			assert.equal(inheritUpper.arguments.parentModel, "gemini-4-neon-high");

			const selfOmitted = byId1.get("sub-self-omitted");
			assert.ok(selfOmitted);
			assert.equal(selfOmitted.arguments.parentModel, "gemini-4-neon-high");

			const explicitModel = byId1.get("sub-explicit-model");
			assert.ok(explicitModel);
			assert.equal(explicitModel.arguments.model, "claude-sonnet-4-6");
			assert.equal(explicitModel.arguments.parentModel, undefined);

			const otherOmitted = byId1.get("sub-other-omitted");
			assert.ok(otherOmitted);
			assert.equal(otherOmitted.arguments.parentModel, undefined);

			// Case 2: parent model ID already carries a reasoning suffix (`gpt-oss-120b-medium`).
			const suffixedModel: Model<"antigravity-acp"> = {
				...TEST_MODEL,
				id: "gpt-oss-120b-medium",
				name: "GPT OSS 120B (Medium)",
			};
			coordinator.setActiveContext(
				interactiveContext(root, { sessionManager: { getSessionId: () => "t4-b", getBranch: () => [] } }),
			);
			const p2 = makeUser("SUBAGENT_CASES", 2);
			typedByHuman(coordinator.humanPromptGate, p2);
			const msg2 = await coordinator
				.streamSimple(suffixedModel, normalizeContext({ messages: [p2], tools }), {
					sessionId: "t4-b",
					reasoning: "high",
				})
				.result();
			assert.equal(msg2.stopReason, "toolUse");
			const calls2 = msg2.content.filter((c): c is ToolCall => c.type === "toolCall");
			const byId2 = new Map(calls2.map((c) => [c.id, c]));

			assert.equal(byId2.get("sub-self-omitted")?.arguments.parentModel, "gpt-oss-120b-medium");
			assert.equal(byId2.get("sub-inherit-other")?.arguments.parentModel, "gpt-oss-120b-medium");
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("Task 5: ignores stray and post-completion tool_call_update while accepting early updates for announced calls", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-edge-t5-stray-"));
		const mock = writeEdgeCaseMockAgy(root);
		const config: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: mock.bin,
			geminiDir: path.join(root, ".gemini"),
		};
		const broker = new AgyTurnMirrorBroker();
		const coordinator = new TurnCoordinator(createStubPi(), new AcpProcessManager(), broker, config);
		const mirrorTools = createAgyMirrorToolDefinitions(broker);
		const tools = mirrorTools.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
		const piSessionId = "edge-t5-stray";
		coordinator.setActiveContext(
			interactiveContext(root, { sessionManager: { getSessionId: () => piSessionId, getBranch: () => [] } }),
		);

		try {
			const prompt = makeUser("STRAY_TOOL_UPDATES", 1);
			typedByHuman(coordinator.humanPromptGate, prompt);
			const step1 = await coordinator
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [prompt], tools }), { sessionId: piSessionId })
				.result();
			assert.equal(step1.stopReason, "toolUse", step1.errorMessage);

			// Stray tool_call_update must NOT have created an orphan entry in mirrorBroker.
			assert.equal(broker.isTracking("stray-call-999"), false, "stray tool_call_update must not leak into mirrorBroker");

			// Real call received an early completion update before dequeue and IS tracked cleanly.
			const realCall = step1.content.find((c): c is ToolCall => c.type === "toolCall");
			assert.ok(realCall);
			assert.equal(realCall.id, "real-call-1");
			assert.equal(broker.isTracking("real-call-1"), true);

			// Execute the mirror tool so mirrorBroker returns its result and removes real-call-1.
			const bashMirror = mirrorTools.find((t) => t.name === realCall.name);
			assert.ok(bashMirror);
			const execResult = await bashMirror.execute(
				realCall.id,
				realCall.arguments,
				undefined,
				undefined,
				interactiveToolContext(root),
			);
			const execText = execResult.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			assert.match(execText, /real output/);
			assert.equal(broker.isTracking("real-call-1"), false);

			// Continue the turn; mock agy sends a late duplicate tool_call_update for real-call-1 before end_turn.
			const step2 = await coordinator
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						messages: [
							prompt,
							step1,
							{
								role: "toolResult",
								toolCallId: realCall.id,
								toolName: realCall.name,
								content: execResult.content,
								isError: false,
								timestamp: 2,
							},
						],
						tools,
					}),
					{ sessionId: piSessionId },
				)
				.result();
			assert.equal(step2.stopReason, "stop", step2.errorMessage);
			assert.equal(
				broker.isTracking("real-call-1"),
				false,
				"late duplicate tool_call_update must not re-register an orphan in mirrorBroker",
			);
			assert.equal(broker.isTracking("stray-call-999"), false);
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
