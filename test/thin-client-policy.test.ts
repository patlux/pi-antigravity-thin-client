import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { normalizeContext, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AcpProcessManager } from "../src/acp/process-manager.ts";
import { DEFAULT_BRIDGE_CONFIG, loadBridgeConfig, resolveEffectiveFlags } from "../src/config.ts";
import { filterToolsForHostMcpBridge } from "../src/mcp/pi-mcp-forwarder.ts";
import { buildFreshReplayPlan } from "../src/session/reconcile.ts";
import { TurnCoordinator } from "../src/session/turn-coordinator.ts";
import { AgyTurnMirrorBroker, createAgyMirrorToolDefinitions } from "../src/tools/agy-mirror-tools.ts";
import { typedByHuman } from "./human-input.ts";

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

function stubPi(): ExtensionAPI {
	return {
		appendEntry() {},
		getSessionName() {
			return undefined;
		},
		setSessionName() {},
	} as unknown as ExtensionAPI;
}

function user(text: string, timestamp = 1): UserMessage {
	return { role: "user", content: text, timestamp };
}

function withTempAgentDir<T>(fn: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-policy-"));
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Writes a stand-in for `agy` that only records its start and exits. A missing
 * configured binary is not enough: the resolver then falls back to the real `agy`
 * on PATH, and a test prompt must never reach Antigravity.
 */
function writeRecordingAgy(dir: string): { bin: string; marker: string } {
	const marker = path.join(dir, "agy-started");
	if (process.platform === "win32") {
		// Windows cannot start a shell script; use a node script behind a .cmd wrapper.
		const script = path.join(dir, "recording-agy.mjs");
		fs.writeFileSync(
			script,
			`import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(marker)}, "started\\n");\nprocess.exit(1);\n`,
		);
		const bin = path.join(dir, "recording-agy.cmd");
		fs.writeFileSync(bin, `@node "${script}" %*\r\n`);
		return { bin, marker };
	}
	const bin = path.join(dir, "recording-agy");
	fs.writeFileSync(bin, `#!/bin/sh\necho started >> '${marker}'\nexit 1\n`, { mode: 0o755 });
	return { bin, marker };
}

/** Runs one turn on a coordinator whose agy only records its start; a refusal must come first. */
async function runTurn(params: {
	hasUI: boolean | undefined;
	withTools: boolean;
	systemPrompt?: string;
	messageText?: string;
	cacheRetention?: "none" | "short" | "long";
	/** Report the message as typed by the human (Pi's `input` + `message_start`). Default: true. */
	typed?: boolean;
}) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-policy-turn-"));
	const agy = writeRecordingAgy(tmp);
	const broker = new AgyTurnMirrorBroker();
	const coord = new TurnCoordinator(stubPi(), new AcpProcessManager(), broker, {
		...DEFAULT_BRIDGE_CONFIG,
		agyBin: agy.bin,
		geminiDir: path.join(tmp, ".gemini"),
	});
	if (params.hasUI !== undefined) {
		coord.setActiveContext({
			hasUI: params.hasUI,
			cwd: tmp,
			ui: { setStatus() {} },
		} as unknown as ExtensionContext);
	}
	const tools = params.withTools
		? createAgyMirrorToolDefinitions(broker).map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			}))
		: undefined;
	try {
		const message = user(params.messageText ?? "hello");
		if (params.typed ?? true) {
			typedByHuman(coord.humanPromptGate, message);
		}
		const ctx = normalizeContext({
			systemPrompt: params.systemPrompt,
			messages: [message],
			tools,
		});
		const stream = coord.streamSimple(TEST_MODEL, ctx, {
			sessionId: "pi-policy",
			cacheRetention: params.cacheRetention,
		});
		const result = await stream.result();
		return Object.assign(result, { agyStarted: fs.existsSync(agy.marker) });
	} finally {
		await coord.dispose();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

describe("thin-client policy", () => {
	it("passes none of Pi's tools or MCP tools to Antigravity, even with every bridge switched on", () => {
		const mirror = createAgyMirrorToolDefinitions(new AgyTurnMirrorBroker()).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
		const parameters = mirror[0].parameters;
		const declared = [
			...mirror,
			{ name: "read", description: "Pi read", parameters },
			{ name: "codemode", description: "Pi codemode", parameters },
			{ name: "mcp__github__search_code", description: "Pi MCP tool", parameters },
		];
		for (const toolMode of ["pi-tools", "agy-tools", "hybrid"] as const) {
			for (const piMcpBridgeStrategy of ["via-host", "direct-config"] as const) {
				const config = { ...DEFAULT_BRIDGE_CONFIG, toolMode, piMcpBridgeStrategy, bridgePiMcp: true, bridgePiSkills: true, bridgePiAgentsMd: true };
				assert.deepEqual(filterToolsForHostMcpBridge(declared, config), [], `${toolMode} / ${piMcpBridgeStrategy}`);
			}
		}
	});

	it("pins agy-tools without Pi bridges or SQLite writes, whatever the config says", () => {
		withTempAgentDir((dir) => {
			fs.writeFileSync(
				path.join(dir, "antigravity.json"),
				JSON.stringify({
					toolMode: "pi-tools",
					bridgePiMcp: true,
					bridgePiSkills: true,
					bridgePiAgentsMd: true,
					enableSqliteFork: true,
				}),
			);
			const cfg = loadBridgeConfig({
				env: {
					PI_CODING_AGENT_DIR: dir,
					PI_AGY_TOOL_MODE: "hybrid",
					PI_AGY_BRIDGE_MCP: "true",
					PI_AGY_BRIDGE_SKILLS: "true",
					PI_AGY_BRIDGE_AGENTS_MD: "true",
				},
			});
			assert.equal(cfg.toolMode, "agy-tools");
			assert.equal(cfg.bridgePiMcp, false);
			assert.equal(cfg.bridgePiSkills, false);
			assert.equal(cfg.bridgePiAgentsMd, false);
			assert.equal(cfg.enableSqliteFork, false);
		});
	});

	it("derives the same pinned flags from any in-memory config", () => {
		const flags = resolveEffectiveFlags({
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
			bridgePiMcp: true,
			bridgePiSkills: true,
			bridgePiAgentsMd: true,
		});
		assert.equal(flags.toolMode, "agy-tools");
		assert.equal(flags.bridgePiMcp, false);
		assert.equal(flags.bridgePiSkills, false);
		assert.equal(flags.bridgePiAgentsMd, false);
	});

	it("keeps the pinned config when a command switches modes at runtime", async () => {
		const coord = new TurnCoordinator(stubPi(), new AcpProcessManager(), new AgyTurnMirrorBroker(), {
			...DEFAULT_BRIDGE_CONFIG,
		});
		try {
			assert.equal(coord.config.toolMode, "agy-tools");
			coord.setConfig({ ...coord.config, toolMode: "pi-tools", bridgePiMcp: true, enableSqliteFork: true });
			assert.equal(coord.config.toolMode, "agy-tools");
			assert.equal(coord.config.bridgePiMcp, false);
			assert.equal(coord.config.enableSqliteFork, false);
		} finally {
			await coord.dispose();
		}
	});

	it("sends a first prompt unchanged and without a workspace context block", () => {
		const plan = buildFreshReplayPlan({
			visibleMessages: [user("first prompt")],
			maxContextWindowTokens: 512_000,
		});
		assert.deepEqual(plan.preloadedTurns, []);
		const text = JSON.stringify(plan.finalPromptBlocks);
		assert.match(text, /first prompt/);
		assert.doesNotMatch(text, /conversation-checkpoint|workspace_context/);
	});

	it("refuses to replay earlier conversation", () => {
		assert.throws(
			() =>
				buildFreshReplayPlan({
					visibleMessages: [
						user("earlier", 1),
						{
							role: "assistant",
							content: [{ type: "text", text: "earlier answer" }],
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
							stopReason: "stop",
							timestamp: 2,
						},
						user("next", 3),
					],
					maxContextWindowTokens: 512_000,
				}),
			/refusing to replay earlier conversation/,
		);
	});

	it("refuses headless use (subagents, workflows, pi -p)", async () => {
		for (const hasUI of [undefined, false]) {
			const msg = await runTurn({ hasUI, withTools: true });
			assert.equal(msg.stopReason, "error");
			assert.match(msg.errorMessage ?? "", /refusing headless use/);
		}
	});

	it("refuses requests without Pi's declared tools", async () => {
		const msg = await runTurn({ hasUI: true, withTools: false });
		assert.equal(msg.stopReason, "error");
		assert.match(msg.errorMessage ?? "", /refusing auxiliary request/);
	});

	it("refuses compaction and other uncached one-off requests", async () => {
		const compaction = await runTurn({
			hasUI: true,
			withTools: true,
			systemPrompt: "You are a context summarization assistant.",
			messageText: "<conversation>...</conversation> Create a structured checkpoint",
		});
		assert.equal(compaction.stopReason, "error");
		assert.match(compaction.errorMessage ?? "", /refusing auxiliary request/);

		const uncached = await runTurn({ hasUI: true, withTools: true, cacheRetention: "none" });
		assert.equal(uncached.stopReason, "error");
		assert.match(uncached.errorMessage ?? "", /refusing auxiliary request/);
	});

	it("lets a typed interactive prompt with declared tools reach the agy process", async () => {
		const msg = await runTurn({ hasUI: true, withTools: true });
		assert.equal(msg.stopReason, "error");
		assert.doesNotMatch(msg.errorMessage ?? "", /thin client/);
		assert.equal(msg.agyStarted, true);
	});

	it("refuses a prompt nobody typed before starting agy", async () => {
		const msg = await runTurn({ hasUI: true, withTools: true, typed: false });
		assert.equal(msg.stopReason, "error");
		assert.match(msg.errorMessage ?? "", /refusing a message you did not type/);
		assert.equal(msg.agyStarted, false);
	});
});
