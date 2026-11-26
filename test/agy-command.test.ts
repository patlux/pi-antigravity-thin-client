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
	selects: Array<{ title: string; items: string[] }>;
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
		hasUI?: boolean;
		mode?: "tui" | "rpc" | "json" | "print";
		confirmResult?: boolean;
		selectResult?: string | undefined;
	},
): ExtensionCommandContext {
	const stub = {
		hasUI: options?.hasUI ?? true,
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
			async select(title: string, items: string[]) {
				recorder.selects.push({ title, items: [...items] });
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
			hasUI?: boolean;
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
	const recorder: Recorder = {
		commands: new Map(),
		activeToolChanges: [],
		notes: [],
		statuses: [],
		selects: [],
	};
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

	it("/agy logout uses ACP v1 logout first and invokes onLogout callback", async () => {
		let logoutCalls = 0;
		let methodsPath = "";
		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("logout");
				assert.equal(logoutCalls, 1);
				assert.deepEqual(recorder.notes, [{ message: "Signed out of Antigravity.", level: "info" }]);
				const methods: unknown = JSON.parse(fs.readFileSync(methodsPath, "utf8"));
				assert.deepEqual(methods, ["initialize", "logout"]);
			},
			{
				agyBinFactory: (root) => {
					methodsPath = path.join(root, "logout-methods.json");
					const rpcMock = `
import * as fs from "node:fs";
import * as readline from "node:readline";
const methodsPath = ${JSON.stringify(methodsPath)};
const seen = [];
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method) {
		seen.push(msg.method);
		fs.writeFileSync(methodsPath, JSON.stringify(seen));
	}
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { auth: { logout: {} } } } });
	} else if (msg.method === "logout") {
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
	} else if (msg.id !== undefined) {
		send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unexpected method: " + msg.method } });
	}
});
`;
					return writeStubAgyScript(root, "mock-agy-logout-v1", rpcMock);
				},
				onLogout: () => {
					logoutCalls++;
				},
			},
		);
	});

	it("/agy logout falls back to auth/logout when logout returns -32601", async () => {
		let logoutCalls = 0;
		let methodsPath = "";
		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("logout");
				assert.equal(logoutCalls, 1);
				assert.deepEqual(recorder.notes, [{ message: "Signed out of Antigravity.", level: "info" }]);
				const methods: unknown = JSON.parse(fs.readFileSync(methodsPath, "utf8"));
				assert.deepEqual(methods, ["initialize", "logout", "auth/logout"]);
			},
			{
				agyBinFactory: (root) => {
					methodsPath = path.join(root, "logout-fallback-methods.json");
					const rpcMock = `
import * as fs from "node:fs";
import * as readline from "node:readline";
const methodsPath = ${JSON.stringify(methodsPath)};
const seen = [];
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method) {
		seen.push(msg.method);
		fs.writeFileSync(methodsPath, JSON.stringify(seen));
	}
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { auth: { logout: {} } } } });
	} else if (msg.method === "logout") {
		send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
	} else if (msg.method === "auth/logout") {
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
	} else if (msg.id !== undefined) {
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
	}
});
`;
					return writeStubAgyScript(root, "mock-agy-logout-fallback", rpcMock);
				},
				onLogout: () => {
					logoutCalls++;
				},
			},
		);
	});

	it("/agy logout does not fall back when logout fails with a non--32601 error", async () => {
		let logoutCalls = 0;
		let methodsPath = "";
		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("logout");
				assert.equal(logoutCalls, 0);
				assert.equal(recorder.notes.length, 1);
				assert.equal(recorder.notes[0].level, "error");
				assert.match(recorder.notes[0].message, /Sign-out failed: keyring locked/);
				const methods: unknown = JSON.parse(fs.readFileSync(methodsPath, "utf8"));
				assert.deepEqual(methods, ["initialize", "logout"]);
			},
			{
				agyBinFactory: (root) => {
					methodsPath = path.join(root, "logout-err-methods.json");
					const rpcMock = `
import * as fs from "node:fs";
import * as readline from "node:readline";
const methodsPath = ${JSON.stringify(methodsPath)};
const seen = [];
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method) {
		seen.push(msg.method);
		fs.writeFileSync(methodsPath, JSON.stringify(seen));
	}
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { auth: { logout: {} } } } });
	} else if (msg.method === "logout") {
		send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "keyring locked" } });
	} else if (msg.id !== undefined) {
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
	}
});
`;
					return writeStubAgyScript(root, "mock-agy-logout-err", rpcMock);
				},
				onLogout: () => {
					logoutCalls++;
				},
			},
		);
	});

	it("/agy agent-mode supports auto in completions, interactive menu, and persisted config", async () => {
		await withAgyCommand(async (run, agy, recorder, agentDir) => {
			const allModeItems = (await agy.getArgumentCompletions?.("agent-mode ")) ?? [];
			assert.deepEqual(
				allModeItems.map((i) => i.value),
				["agent-mode default", "agent-mode accept-edits", "agent-mode plan", "agent-mode auto"],
			);
			const autoOnly = (await agy.getArgumentCompletions?.("agent-mode au")) ?? [];
			assert.deepEqual(
				autoOnly.map((i) => i.value),
				["agent-mode auto"],
			);

			await run("agent-mode auto");
			assert.deepEqual(recorder.notes, [{ message: "agy execution mode set to auto.", level: "info" }]);
			const saved: unknown = JSON.parse(fs.readFileSync(path.join(agentDir, "antigravity.json"), "utf8"));
			assert.ok(saved && typeof saved === "object" && "agyExecutionMode" in saved);
			assert.equal(saved.agyExecutionMode, "auto");
		});

		await withAgyCommand(
			async (run, _agy, recorder, agentDir) => {
				await run("agent-mode");
				assert.equal(recorder.selects.length, 1);
				assert.ok(
					recorder.selects[0].items.includes(
						"auto — let Antigravity auto-approve safe actions when supported",
					),
				);
				const saved: unknown = JSON.parse(fs.readFileSync(path.join(agentDir, "antigravity.json"), "utf8"));
				assert.ok(saved && typeof saved === "object" && "agyExecutionMode" in saved);
				assert.equal(saved.agyExecutionMode, "auto");
			},
			{
				ctxOptions: {
					selectResult: "auto — let Antigravity auto-approve safe actions when supported",
				},
			},
		);

		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("agent-mode invalid-mode");
				assert.deepEqual(recorder.notes, [
					{ message: "Usage: /agy agent-mode <default | accept-edits | plan | auto>", level: "warning" },
				]);
			},
			{
				ctxOptions: { hasUI: false },
			},
		);
	});

	it("/agy status warns when agy version is older than 1.5.1 and stays quiet for 1.5.1+", async () => {
		const hint = "Note: agy 1.5.1 or newer is recommended for full model access.";

		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("status");
				assert.equal(recorder.selects.length, 1);
				assert.ok(recorder.selects[0].items.includes(hint));
			},
			{
				agyBinFactory: (root) =>
					writeStubAgyScript(root, "mock-agy-v150", 'console.log("1.5.0");\n'),
			},
		);

		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("status");
				assert.equal(recorder.selects.length, 1);
				assert.ok(!recorder.selects[0].items.includes(hint));
			},
			{
				agyBinFactory: (root) =>
					writeStubAgyScript(root, "mock-agy-v151", 'console.log("1.5.1");\n'),
			},
		);

		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("status");
				assert.equal(recorder.selects.length, 1);
				assert.ok(!recorder.selects[0].items.includes(hint));
			},
			{
				agyBinFactory: (root) =>
					writeStubAgyScript(root, "mock-agy-v1513", 'console.log("1.5.13");\n'),
			},
		);

		await withAgyCommand(
			async (run, _agy, recorder) => {
				await run("status");
				assert.equal(recorder.selects.length, 1);
				assert.ok(!recorder.selects[0].items.includes(hint));
			},
			{
				agyBinFactory: (root) =>
					writeStubAgyScript(root, "mock-agy-vdev", 'console.log("dev-snapshot");\n'),
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
		const recorder: Recorder = {
			commands: new Map(),
			activeToolChanges: [],
			notes: [],
			statuses: [],
			selects: [],
		};
		const ctx: ExtensionContext = stubContext(recorder, os.tmpdir());
		updateAntigravityStatusBar(ctx, DEFAULT_BRIDGE_CONFIG, { backendCompactedRecently: true });
		assert.deepEqual(recorder.statuses, [{ key: STATUS_BAR_KEY, text: undefined }]);
	});
});
