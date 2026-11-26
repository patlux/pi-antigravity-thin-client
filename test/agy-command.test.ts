import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { AcpProcessManager } from "../src/acp/process-manager.ts";
import { DEFAULT_BRIDGE_CONFIG } from "../src/config.ts";
import { TurnCoordinator } from "../src/session/turn-coordinator.ts";
import { AgyTurnMirrorBroker } from "../src/tools/agy-mirror-tools.ts";
import { registerAntigravityCommands, THIN_CLIENT_FIXED_MODE } from "../src/ui/commands.ts";
import { STATUS_BAR_KEY, updateAntigravityStatusBar } from "../src/ui/status-bar.ts";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

interface Recorder {
	commands: Map<string, CommandOptions>;
	activeToolChanges: string[][];
	notes: Array<{ message: string; level: string | undefined }>;
	statuses: Array<{ key: string; text: string | undefined }>;
}

function isExtensionApi(value: object): value is ExtensionAPI {
	return "registerCommand" in value && "setActiveTools" in value;
}

function isCommandContext(value: object): value is ExtensionCommandContext {
	return "hasUI" in value && "ui" in value && "cwd" in value;
}

function writeStubAgyScript(dir: string, name: string, source: string): string {
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

function stubPi(recorder: Recorder): ExtensionAPI {
	const stub = {
		appendEntry() {},
		getSessionName() {
			return undefined;
		},
		setSessionName() {},
		registerCommand(name: string, options: CommandOptions) {
			recorder.commands.set(name, options);
		},
		getActiveTools() {
			return ["agy_bash", "agy_edit"];
		},
		getAllTools() {
			return [];
		},
		setActiveTools(names: string[]) {
			recorder.activeToolChanges.push(names);
		},
	};
	if (!isExtensionApi(stub)) throw new Error("stub lacks the extension API members the test needs");
	return stub;
}

function stubContext(
	recorder: Recorder,
	cwd: string,
	options?: {
		mode?: "tui" | "rpc" | "json" | "print";
		confirmResult?: boolean;
		selectResult?: string | undefined;
	},
): ExtensionCommandContext {
	const stub = {
		hasUI: true,
		mode: options?.mode ?? "tui",
		cwd,
		model: { provider: "antigravity", id: "gemini-4-neon" },
		isProjectTrusted: () => false,
		ui: {
			notify(message: string, level?: string) {
				recorder.notes.push({ message, level });
			},
			setStatus(key: string, text: string | undefined) {
				recorder.statuses.push({ key, text });
			},
			async select(_title: string, items: string[]) {
				return options?.selectResult !== undefined ? options.selectResult : items[0];
			},
			async confirm() {
				return options?.confirmResult ?? true;
			},
			custom<T>(
				factory: (
					tui: { stop(): void; start(): void; requestRender(force?: boolean): void },
					theme: Record<string, never>,
					kb: Record<string, never>,
					done: (result: T) => void,
				) => unknown,
			): Promise<T> {
				return new Promise<T>((resolve, reject) => {
					let resolved = false;
					factory(
						{ stop() {}, start() {}, requestRender() {} },
						{},
						{},
						(result) => {
							resolved = true;
							resolve(result);
						},
					);
					if (!resolved) {
						reject(new Error("custom UI factory did not call done()"));
					}
				});
			},
		},
	};
	if (!isCommandContext(stub)) throw new Error("stub lacks the command context members the test needs");
	return stub;
}

async function withAgyCommand(
	fn: (run: (args: string) => Promise<void>, agy: CommandOptions, recorder: Recorder, agentDir: string) => Promise<void>,
	options?: {
		agyBinFactory?: (root: string) => string;
		onRefreshProviderModels?: (ctx: ExtensionContext) => Promise<number>;
		onLogout?: () => void;
		ctxOptions?: {
			mode?: "tui" | "rpc" | "json" | "print";
			confirmResult?: boolean;
			selectResult?: string | undefined;
		};
	},
): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-command-"));
	const agentDir = path.join(root, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const recorder: Recorder = { commands: new Map(), activeToolChanges: [], notes: [], statuses: [] };
	const pi = stubPi(recorder);
	const agyBin =
		options?.agyBinFactory?.(root) ??
		writeStubAgyScript(root, "mock-agy-noop", "process.exit(1);\n");
	const processManager = new AcpProcessManager();
	const coordinator = new TurnCoordinator(pi, processManager, new AgyTurnMirrorBroker(), {
		...DEFAULT_BRIDGE_CONFIG,
		agyBin,
		geminiDir: path.join(root, ".gemini"),
	});
	try {
		registerAntigravityCommands({
			pi,
			processManager,
			coordinator,
			onRefreshProviderModels: options?.onRefreshProviderModels ?? (async () => 0),
			onLogout: options?.onLogout,
		});
		const agy = recorder.commands.get("agy");
		assert.ok(agy, "/agy is registered");
		const ctx = stubContext(recorder, root, options?.ctxOptions);
		await fn((args) => agy.handler(args, ctx), agy, recorder, agentDir);
		assert.equal(coordinator.config.toolMode, "agy-tools");
		assert.equal(coordinator.config.bridgePiMcp, false);
	} finally {
		await coordinator.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("/agy command in the thin client", () => {
	it("offers no subcommand that leaves agy-tools or bridges Pi resources", async () => {
		await withAgyCommand(async (_run, agy) => {
			const offered = (await agy.getArgumentCompletions?.("")) ?? [];
			const values = offered.map((item) => item.value);
			assert.ok(values.includes("status"));
			assert.ok(values.includes("agent-mode"), "agy's own execution mode stays available");
			assert.ok(!values.includes("mode"));
			assert.ok(!values.includes("bridge"));
			assert.equal(await agy.getArgumentCompletions?.("mode "), null);
			assert.equal(await agy.getArgumentCompletions?.("bridge mcp "), null);
		});
	});

	for (const args of ["mode pi-tools", "mode hybrid", "mode", "bridge mcp on", "bridge skills auto"]) {
		it(`/agy ${args} changes nothing and says why`, async () => {
			await withAgyCommand(async (run, _agy, recorder, agentDir) => {
				await run(args);
				assert.deepEqual(recorder.notes, [{ message: THIN_CLIENT_FIXED_MODE, level: "warning" }]);
				assert.deepEqual(recorder.activeToolChanges, [], "Pi's active tools stay as they are");
				assert.equal(fs.existsSync(path.join(agentDir, "antigravity.json")), false, "nothing is saved");
			});
		});
	}

	it("/agy login reports refresh failures via ui.notify instead of throwing", async () => {
		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("login");
				assert.equal(recorder.notes.length, 1);
				assert.equal(recorder.notes[0].level, "error");
				assert.match(recorder.notes[0].message, /Signed in, but model reload failed: catalog offline/);
			},
			{
				agyBinFactory: (root) => writeStubAgyScript(root, "mock-agy-login", "process.exit(0);\n"),
				onRefreshProviderModels: async () => {
					throw new Error("catalog offline");
				},
			},
		);
	});

	it("/agy logout invokes onLogout callback after auth/logout succeeds", async () => {
		let logoutCalls = 0;
		const rpcMock = `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { auth: { logout: {} } } } });
	} else if (msg.method === "auth/logout") {
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
	} else if (msg.id !== undefined) {
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
	}
});
`;
		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("logout");
				assert.equal(logoutCalls, 1);
				assert.deepEqual(recorder.notes, [{ message: "Signed out of Antigravity.", level: "info" }]);
			},
			{
				agyBinFactory: (root) => writeStubAgyScript(root, "mock-agy-logout", rpcMock),
				onLogout: () => {
					logoutCalls++;
				},
			},
		);
	});

	it("/agy sessions notifies cleanly when process startup, session/list, or session/load fails", async () => {
		// 1. acquire failure (mock process exits immediately)
		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("sessions");
				assert.equal(recorder.notes.length, 1);
				assert.equal(recorder.notes[0].level, "error");
				assert.match(recorder.notes[0].message, /Failed to list Antigravity sessions:/);
			},
			{
				agyBinFactory: (root) => writeStubAgyScript(root, "mock-agy-crash", "process.exit(1);\n"),
			},
		);

		// 2. session/list RPC error
		const listErrMock = `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {}, close: {} } } } });
	} else if (msg.method === "session/list") {
		send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "list broken" } });
	}
});
`;
		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("sessions");
				assert.equal(recorder.notes.length, 1);
				assert.equal(recorder.notes[0].level, "error");
				assert.match(recorder.notes[0].message, /Failed to list Antigravity sessions: list broken/);
			},
			{
				agyBinFactory: (root) => writeStubAgyScript(root, "mock-agy-list-err", listErrMock),
			},
		);

		// 3. session/load RPC error
		const loadErrMock = `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {}, close: {} } } } });
	} else if (msg.method === "session/list") {
		send({ jsonrpc: "2.0", id: msg.id, result: { sessions: [{ sessionId: "sess-broken-1", cwd: "/tmp", title: "Broken" }] } });
	} else if (msg.method === "session/load") {
		send({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "corrupt transcript" } });
	} else if (msg.id !== undefined) {
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
	}
});
`;
		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("sessions");
				assert.equal(recorder.notes.length, 1);
				assert.equal(recorder.notes[0].level, "error");
				assert.match(recorder.notes[0].message, /Failed to load Antigravity session: corrupt transcript/);
			},
			{
				agyBinFactory: (root) => writeStubAgyScript(root, "mock-agy-load-err", loadErrMock),
			},
		);
	});
});

describe("footer badge", () => {
	it("shows no AGY badge, also for an Antigravity model, and clears an old one", () => {
		const recorder: Recorder = { commands: new Map(), activeToolChanges: [], notes: [], statuses: [] };
		const ctx: ExtensionContext = stubContext(recorder, os.tmpdir());
		updateAntigravityStatusBar(ctx, DEFAULT_BRIDGE_CONFIG, { backendCompactedRecently: true });
		assert.deepEqual(recorder.statuses, [{ key: STATUS_BAR_KEY, text: undefined }]);
	});
});
