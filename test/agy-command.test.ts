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

function stubContext(recorder: Recorder, cwd: string): ExtensionCommandContext {
	const stub = {
		hasUI: true,
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
			async select() {
				return undefined;
			},
		},
	};
	if (!isCommandContext(stub)) throw new Error("stub lacks the command context members the test needs");
	return stub;
}

async function withAgyCommand(
	fn: (run: (args: string) => Promise<void>, agy: CommandOptions, recorder: Recorder, agentDir: string) => Promise<void>,
): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-command-"));
	const agentDir = path.join(root, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const recorder: Recorder = { commands: new Map(), activeToolChanges: [], notes: [], statuses: [] };
	const pi = stubPi(recorder);
	const coordinator = new TurnCoordinator(pi, new AcpProcessManager(), new AgyTurnMirrorBroker(), {
		...DEFAULT_BRIDGE_CONFIG,
		agyBin: path.join(root, "no-agy"),
		geminiDir: path.join(root, ".gemini"),
	});
	try {
		registerAntigravityCommands({
			pi,
			processManager: new AcpProcessManager(),
			coordinator,
			onRefreshProviderModels: async () => 0,
		});
		const agy = recorder.commands.get("agy");
		assert.ok(agy, "/agy is registered");
		const ctx = stubContext(recorder, root);
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
});

describe("footer badge", () => {
	it("shows no AGY badge, also for an Antigravity model, and clears an old one", () => {
		const recorder: Recorder = { commands: new Map(), activeToolChanges: [], notes: [], statuses: [] };
		const ctx: ExtensionContext = stubContext(recorder, os.tmpdir());
		updateAntigravityStatusBar(ctx, DEFAULT_BRIDGE_CONFIG, { backendCompactedRecently: true });
		assert.deepEqual(recorder.statuses, [{ key: STATUS_BAR_KEY, text: undefined }]);
	});
});
