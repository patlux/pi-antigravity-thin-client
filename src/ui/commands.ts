import { spawnSync } from "node:child_process";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { buildAgySpawnSpec, probeAgyVersion, resolveAgyBinary } from "../acp/binary-resolver.ts";
import { type AcpProcessManager, AcpRpcError } from "../acp/process-manager.ts";
import type {
	AcpSessionListResult,
	AcpSessionLoadResult,
	AcpSessionSummary,
	AcpToolCallContentItem,
} from "../acp/protocol.ts";
import {
	ANTIGRAVITY_API_ID,
	ANTIGRAVITY_PROVIDER_ID,
} from "../catalog/model-discovery.ts";
import {
	type AgyExecutionMode,
	type BridgeConfig,
	resolveEffectiveFlags,
	saveGlobalBridgeConfigPatch,
	type ToolMode,
} from "../config.ts";
import { isPiMcpRelatedTool } from "../mcp/pi-mcp-forwarder.ts";
import {
	AGY_SESSION_ANCHOR_CUSTOM_TYPE,
	type AgySessionAnchor,
	captureSqliteCheckpoint,
} from "../session/checkpoint-sync.ts";
import { computeTranscriptDigest } from "../session/reconcile.ts";
import type { TurnCoordinator } from "../session/turn-coordinator.ts";
import { createZeroUsage } from "../stream/event-mapper.ts";
import { classifyAgyToolCall } from "../tools/agy-mirror-tools.ts";
import { AGY_MIRROR_TOOL_NAMES } from "../tools/agy-renderers.ts";
import { updateAntigravityStatusBar } from "./status-bar.ts";

const OVERLAPPING_PI_BASE_TOOLS = new Set<string>([
	"read",
	"edit",
	"write",
	"bash",
	"powershell",
	"grep",
	"find",
	"ls",
]);

/**
 * 管理进入或退出 Antigravity 不同工具模式时的 Pi 激活工具集快照与自动恢复。
 * 遵循 Pi 1.6.0 MCP 暴露策略（不强行激活 hidden/deferred 工具），并保留会话途中 `tool_search` 动态加载的工具。
 */
export class ToolActivationController {
	private readonly pi: ExtensionAPI;
	private savedUserActiveTools?: string[];
	private readonly temporarilyInjectedTools = new Set<string>();
	private lastAppliedMode?: ToolMode;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	syncForContext(ctx: ExtensionContext | undefined, config: BridgeConfig): void {
		const isAgyModel = ctx?.model?.provider === ANTIGRAVITY_PROVIDER_ID;

		if (!isAgyModel || config.toolMode === "pi-tools") {
			this.restoreUserTools();
			this.lastAppliedMode = isAgyModel ? "pi-tools" : undefined;
			return;
		}

		let current: string[];
		try {
			current = this.pi.getActiveTools();
		} catch {
			return;
		}

		const mirrorSet = new Set<string>(AGY_MIRROR_TOOL_NAMES);
		const hasAnyMirror = current.some((t) => mirrorSet.has(t));
		const nonMirrorCurrent = current.filter((t) => !mirrorSet.has(t));

		if (!this.savedUserActiveTools && nonMirrorCurrent.length > 0) {
			this.savedUserActiveTools = nonMirrorCurrent;
		} else if (this.savedUserActiveTools && hasAnyMirror && nonMirrorCurrent.length > 0) {
			const merged = new Set(this.savedUserActiveTools);
			for (const name of nonMirrorCurrent) {
				if (!OVERLAPPING_PI_BASE_TOOLS.has(name) && !this.temporarilyInjectedTools.has(name)) {
					merged.add(name);
				}
			}
			this.savedUserActiveTools = Array.from(merged);
		}

		// 将首次基线与当前运行态中已动态激活（如 tool_search 解锁）的非镜像工具合并，绝不回滚动态工具
		const activePool = hasAnyMirror
			? Array.from(
					new Set([
						...(this.savedUserActiveTools ?? []),
						...nonMirrorCurrent.filter((name) => !this.temporarilyInjectedTools.has(name)),
					]),
				)
			: (this.savedUserActiveTools ?? nonMirrorCurrent);

		const flags = resolveEffectiveFlags(config);

		if (config.toolMode === "agy-tools") {
			if (flags.bridgePiMcp && config.piMcpBridgeStrategy === "via-host") {
				// 仅保留用户激活集中的 MCP 工具与已启用的 codemode；仅按需补入已注册的 tool_search 入口（绝不强行启用用户关闭的 codemode）
				let registeredToolSearch: string[] = [];
				try {
					registeredToolSearch = this.pi
						.getAllTools()
						.map((t) => t.name)
						.filter((name) => name === "tool_search");
				} catch {
					// 忽略未初始化运行态
				}
				const activeSet = new Set(activePool);
				this.temporarilyInjectedTools.clear();
				for (const name of registeredToolSearch) {
					if (!activeSet.has(name)) {
						this.temporarilyInjectedTools.add(name);
					}
				}
				const mcpBridgedTools = Array.from(
					new Set([
						...activePool.filter(
							(name) =>
								isPiMcpRelatedTool(name) || name === "codemode" || name === "tool_search",
						),
						...registeredToolSearch,
					]),
				);
				this.pi.setActiveTools([...AGY_MIRROR_TOOL_NAMES, ...mcpBridgedTools]);
			} else {
				this.temporarilyInjectedTools.clear();
				this.pi.setActiveTools([...AGY_MIRROR_TOOL_NAMES]);
			}
		} else {
			// hybrid：激活镜像工具 + 当前活跃的非重叠扩展/动态工具（保留 tool_search 动态增量，排除临时注入项）
			const userNonMirrorCurrent = nonMirrorCurrent.filter(
				(name) => !this.temporarilyInjectedTools.has(name),
			);
			const sourceForHybrid =
				this.lastAppliedMode === "hybrid" && hasAnyMirror ? userNonMirrorCurrent : activePool;
			const extraTools = sourceForHybrid.filter((name) => !OVERLAPPING_PI_BASE_TOOLS.has(name));
			this.temporarilyInjectedTools.clear();
			this.pi.setActiveTools([...AGY_MIRROR_TOOL_NAMES, ...extraTools]);
		}

		this.lastAppliedMode = config.toolMode;
	}

	private restoreUserTools(): void {
		let current: string[];
		try {
			current = this.pi.getActiveTools();
		} catch {
			return;
		}

		const mirrorSet = new Set<string>(AGY_MIRROR_TOOL_NAMES);
		const hasAnyMirror = current.some((t) => mirrorSet.has(t));
		const nonMirrorCurrent = current.filter(
			(t) => !mirrorSet.has(t) && !this.temporarilyInjectedTools.has(t),
		);
		this.temporarilyInjectedTools.clear();

		if (this.savedUserActiveTools) {
			const dynamicAdditions = nonMirrorCurrent.filter((t) => !OVERLAPPING_PI_BASE_TOOLS.has(t));
			const restored = Array.from(new Set([...this.savedUserActiveTools, ...dynamicAdditions]));
			this.savedUserActiveTools = undefined;
			this.pi.setActiveTools(restored);
		} else if (hasAnyMirror) {
			this.pi.setActiveTools(
				nonMirrorCurrent.length > 0 ? nonMirrorCurrent : ["read", "bash", "edit", "write"],
			);
		}
	}
}

export interface CommandDependencies {
	pi: ExtensionAPI;
	processManager: AcpProcessManager;
	coordinator: TurnCoordinator;
	onRefreshProviderModels: (ctx: ExtensionContext) => Promise<number>;
	onLogout?: () => void;
}

/** `/agy mode` and `/agy bridge` of upstream: switching away from agy-tools does not exist here. */
export const THIN_CLIENT_FIXED_MODE =
	"There is no /agy mode or /agy bridge in this thin client: Antigravity always works with its own tools, and Pi's MCP servers, skills and AGENTS.md are never passed to it.";

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "Antigravity CLI, subscription tier, execution mode and session" },
	{ value: "agent-mode", label: "agent-mode", description: "Switch agy's own execution mode (default | accept-edits | plan | auto)" },
	{ value: "refresh", label: "refresh", description: "Reload the models and thinking levels of this account" },
	{ value: "sessions", label: "sessions", description: "Browse local agy sessions and import one into Pi" },
	{ value: "login", label: "login", description: "Sign in with the official agy CLI" },
	{ value: "logout", label: "logout", description: "Sign out of the agy account" },
];

const VALID_EXECUTION_MODES: readonly AgyExecutionMode[] = [
	"default",
	"accept-edits",
	"plan",
	"auto",
];

const MIN_RECOMMENDED_AGY_VERSION: readonly [number, number, number] = [1, 5, 1];

function parseExecutionMode(raw: string | undefined): AgyExecutionMode | undefined {
	if (!raw) return undefined;
	const normalized = raw.trim().toLowerCase();
	return VALID_EXECUTION_MODES.find((mode) => mode === normalized);
}

function isAgyVersionOlderThan(
	version: string | undefined,
	minimum: readonly [number, number, number] = MIN_RECOMMENDED_AGY_VERSION,
): boolean {
	if (!version) return false;
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const parsed: readonly [number, number, number] = [
		Number(match[1]),
		Number(match[2]),
		Number(match[3]),
	];
	for (let i = 0; i < 3; i++) {
		if (parsed[i] !== minimum[i]) {
			return parsed[i] < minimum[i];
		}
	}
	return false;
}

function buildCompletions(prefix: string): AutocompleteItem[] | null {
	const trimmed = prefix.trimStart();
	const parts = trimmed.split(/\s+/);

	if (parts.length <= 1) {
		const q = (parts[0] ?? "").toLowerCase();
		const matches = SUBCOMMANDS.filter((c) => c.value.startsWith(q));
		return matches.length > 0 ? matches : null;
	}

	const sub = parts[0].toLowerCase();
	const arg1 = (parts[1] ?? "").toLowerCase();

	if (sub === "agent-mode" && parts.length === 2) {
		return [
			{ value: "agent-mode default", label: "default", description: "Ask before edits and commands, as the permission rules say" },
			{ value: "agent-mode accept-edits", label: "accept-edits", description: "Approve file edits in the workspace automatically" },
			{ value: "agent-mode plan", label: "plan", description: "Plan first, then act" },
			{ value: "agent-mode auto", label: "auto", description: "Let Antigravity auto-approve safe actions when supported" },
		].filter((i) => i.value.startsWith(`agent-mode ${arg1}`));
	}

	return null;
}

/** 注册统一的 `/agy` 斜杠命令入口 */
export function registerAntigravityCommands(deps: CommandDependencies): void {
	const { pi, processManager, coordinator, onRefreshProviderModels, onLogout } = deps;

	pi.registerCommand("agy", {
		description: "Antigravity: status, agy execution mode, model refresh, sessions, login",
		getArgumentCompletions: (prefix) => buildCompletions(prefix),
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			coordinator.setActiveContext(ctx);
			const tokens = rawArgs
				.trim()
				.split(/\s+/)
				.filter((s) => s.length > 0);
			const sub = (tokens[0] ?? "status").toLowerCase();

			switch (sub) {
				case "status": {
					await handleStatusSubcommand(ctx, coordinator);
					return;
				}
				case "mode":
				case "bridge": {
					// Thin client: there is no way to run anything but Antigravity's own tools.
					ctx.ui.notify(THIN_CLIENT_FIXED_MODE, "warning");
					return;
				}
				case "agent-mode": {
					await handleAgentModeSubcommand(tokens.slice(1), ctx, coordinator);
					return;
				}
				case "refresh": {
					ctx.ui.notify("Loading the Antigravity model catalog …", "info");
					try {
						const count = await onRefreshProviderModels(ctx);
						ctx.ui.notify(`Antigravity model catalog reloaded (${count} models).`, "info");
					} catch (error) {
						ctx.ui.notify(
							`Model reload failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
					return;
				}
				case "login": {
					await handleLoginSubcommand(ctx, coordinator, onRefreshProviderModels);
					return;
				}
				case "logout": {
					await handleLogoutSubcommand(ctx, processManager, coordinator, onLogout);
					return;
				}
				case "sessions":
				case "import": {
					await handleSessionsImportSubcommand(ctx, processManager, coordinator);
					return;
				}
				default: {
					ctx.ui.notify(
						`Unknown subcommand "${sub}". Available: status, agent-mode, refresh, sessions, login, logout`,
						"warning",
					);
				}
			}
		},
	});
}

async function handleStatusSubcommand(
	ctx: ExtensionCommandContext,
	coordinator: TurnCoordinator,
): Promise<void> {
	const cfg = coordinator.config;
	const telemetry = coordinator.getTelemetrySnapshot();
	const bin = resolveAgyBinary({ configuredBin: cfg.agyBin, geminiDir: cfg.geminiDir });
	const ver = bin ? probeAgyVersion(bin) : undefined;

	const lines = [
		`Antigravity CLI: ${bin ? `${bin.binPath}${ver ? ` (v${ver})` : ""}` : "not found"}`,
		...(isAgyVersionOlderThan(ver)
			? ["Note: agy 1.5.1 or newer is recommended for full model access."]
			: []),
		`Subscription: ${telemetry.tier ? `${telemetry.tier.name}` : "known after the first connection"}`,
		"Thin client: Antigravity's own tools; Pi MCP, skills and AGENTS.md are never passed on",
		`agy execution mode: ${cfg.agyExecutionMode}`,
		`Active session: ${telemetry.agySessionId ?? "none (created with the next prompt)"}`,
	];

	if (typeof telemetry.usedTokens === "number") {
		const winText = telemetry.windowSize ? ` / ${telemetry.windowSize.toLocaleString()}` : "";
		lines.push(`Context used in agy: ${telemetry.usedTokens.toLocaleString()}${winText} tokens`);
	}

	if (ctx.hasUI) {
		await ctx.ui.select("Antigravity status (Esc closes)", lines);
	} else {
		ctx.ui.notify(lines.join("\n"), "info");
	}
}

async function handleAgentModeSubcommand(
	args: string[],
	ctx: ExtensionCommandContext,
	coordinator: TurnCoordinator,
): Promise<void> {
	let chosen = parseExecutionMode(args[0]);

	if (!chosen) {
		if (!ctx.hasUI) {
			ctx.ui.notify("Usage: /agy agent-mode <default | accept-edits | plan | auto>", "warning");
			return;
		}
		const picked = await ctx.ui.select(
			`agy execution mode (current: ${coordinator.config.agyExecutionMode})`,
			[
				"default — ask before edits and commands, as the permission settings say",
				"accept-edits — approve file edits in the workspace automatically",
				"plan — write a plan first, then act",
				"auto — let Antigravity auto-approve safe actions when supported",
			],
		);
		if (!picked) return;
		chosen = parseExecutionMode(picked.split(" ")[0]);
		if (!chosen) return;
	}

	const nextConfig: BridgeConfig = {
		...coordinator.config,
		agyExecutionMode: chosen,
	};
	coordinator.setConfig(nextConfig);
	saveGlobalBridgeConfigPatch({ agyExecutionMode: chosen });
	await coordinator.applyExecutionModeLive(chosen);
	updateAntigravityStatusBar(ctx, nextConfig, coordinator.getTelemetrySnapshot());

	ctx.ui.notify(`agy execution mode set to ${chosen}.`, "info");
}

async function handleLoginSubcommand(
	ctx: ExtensionCommandContext,
	coordinator: TurnCoordinator,
	onRefreshProviderModels: (ctx: ExtensionContext) => Promise<number>,
): Promise<void> {
	const bin = resolveAgyBinary({
		configuredBin: coordinator.config.agyBin,
		geminiDir: coordinator.config.geminiDir,
	});
	if (!bin) {
		ctx.ui.notify("agy not found on this machine. Install the Antigravity CLI first.", "error");
		return;
	}

	if (ctx.mode === "tui") {
		const confirmed = await ctx.ui.confirm(
			"Antigravity sign-in",
			"The official agy CLI keeps the credentials locally; this extension never reads or stores tokens.\nStart `agy acp --login` in this terminal now?",
		);
		if (!confirmed) return;

		const loginSpec = buildAgySpawnSpec(bin, [
			"acp",
			"--login",
			"--gemini-dir",
			coordinator.config.geminiDir,
		]);

		const exitStatus = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
			tui.stop();
			process.stdout.write("\x1b[2J\x1b[H");
			let status: number | null = null;
			try {
				const res = spawnSync(loginSpec.command, loginSpec.args, {
					stdio: "inherit",
					windowsVerbatimArguments: loginSpec.windowsVerbatimArguments,
				});
				status = res.status;
			} finally {
				tui.start();
				tui.requestRender(true);
				done(status);
			}
			return { render: () => [], invalidate: () => {} };
		});

		if (exitStatus === 0) {
			try {
				const count = await onRefreshProviderModels(ctx);
				ctx.ui.notify(`Signed in; ${count} models loaded.`, "info");
			} catch (error) {
				ctx.ui.notify(
					`Signed in, but model reload failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		} else {
			ctx.ui.notify("The sign-in did not complete. You can also run `agy acp --login` in a separate terminal and then `/agy refresh`.", "warning");
		}
		return;
	}

	ctx.ui.notify("Run `agy acp --login` in a terminal to sign in, then `/agy refresh` to load the models.", "info");
}

async function handleLogoutSubcommand(
	ctx: ExtensionCommandContext,
	processManager: AcpProcessManager,
	coordinator: TurnCoordinator,
	onLogout?: () => void,
): Promise<void> {
	try {
		const conn = await processManager.acquire(coordinator.config);
		try {
			await conn.request("logout", {}, { timeoutMs: 10_000 });
		} catch (error) {
			if (error instanceof AcpRpcError && error.code === -32601) {
				await conn.request("auth/logout", {}, { timeoutMs: 10_000 });
			} else {
				throw error;
			}
		}
		onLogout?.();
		await coordinator.dispose();
		ctx.ui.notify("Signed out of Antigravity.", "info");
	} catch (error) {
		ctx.ui.notify(
			`Sign-out failed: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

function extractReplayedToolOutput(
	content: readonly AcpToolCallContentItem[] | undefined,
	rawOutput: unknown,
): Array<TextContent | ImageContent> {
	if (content && content.length > 0) {
		const blocks: Array<TextContent | ImageContent> = [];
		for (const item of content) {
			if (item.type === "content") {
				if (item.content.type === "text") {
					blocks.push({ type: "text", text: item.content.text });
				} else if (item.content.type === "image") {
					blocks.push({
						type: "image",
						data: item.content.data,
						mimeType: item.content.mimeType,
					});
				}
			} else if (item.type === "diff") {
				blocks.push({ type: "text", text: `Updated ${item.path}` });
			}
		}
		if (blocks.length > 0) {
			return blocks;
		}
	}
	if (typeof rawOutput === "string" && rawOutput.trim().length > 0) {
		return [{ type: "text", text: rawOutput }];
	}
	return [];
}

async function handleSessionsImportSubcommand(
	ctx: ExtensionCommandContext,
	processManager: AcpProcessManager,
	coordinator: TurnCoordinator,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Browsing and importing sessions needs the interactive UI.", "warning");
		return;
	}

	let conn: Awaited<ReturnType<AcpProcessManager["acquire"]>>;
	let listRes: AcpSessionListResult;
	try {
		conn = await processManager.acquire(coordinator.config);
		listRes = await conn.request<AcpSessionListResult>(
			"session/list",
			{ cwd: ctx.cwd },
			{ timeoutMs: 15_000 },
		);
	} catch (error) {
		ctx.ui.notify(
			`Failed to list Antigravity sessions: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

	const sessions: AcpSessionSummary[] = listRes.sessions ?? [];
	if (sessions.length === 0) {
		ctx.ui.notify("No local Antigravity sessions to import.", "info");
		return;
	}

	const topSessions = sessions.slice(0, 30);
	const labels = topSessions.map((s) => {
		const title = s.title?.trim() || "(untitled session)";
		const time = s.updatedAt ? ` · ${s.updatedAt}` : "";
		return `${title}${time} [${s.sessionId.slice(0, 8)}]`;
	});

	const pickedLabel = await ctx.ui.select("agy session to import into a new Pi session", labels);
	if (!pickedLabel) return;

	const idx = labels.indexOf(pickedLabel);
	const target = topSessions[idx >= 0 ? idx : 0];

	// If the current Pi session already holds an active ledger for this agy session,
	// tear it down first so session/load's auxiliary listener and closeSessionSafe do
	// not hijack or close an active ledger behind its back.
	if (coordinator.getTelemetrySnapshot().agySessionId === target.sessionId) {
		try {
			await coordinator.invalidatePiSession();
		} catch (error) {
			ctx.ui.notify(
				`Failed to close active session before import: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
	}

	// 通过 session/load 收集回放事件流并组装为标准 Pi 消息序列（保留文本、思考与历史工具记录）
	const replayedMessages: Array<UserMessage | AssistantMessage | ToolResultMessage> = [];
	let currentUserParts: Array<TextContent | ImageContent> = [];
	let currentAssistantBlocks: Array<ThinkingContent | TextContent | ToolCall> = [];
	const replayedToolResults = new Map<
		string,
		{ toolName: string; content: Array<TextContent | ImageContent>; isError: boolean }
	>();
	let pendingToolCallIds: string[] = [];

	const flushUser = () => {
		if (currentUserParts.length === 0) return;
		replayedMessages.push({
			role: "user",
			content: currentUserParts,
			timestamp: Date.now(),
		});
		currentUserParts = [];
	};

	const flushAssistant = (stopReason: "stop" | "toolUse" = "stop") => {
		if (currentAssistantBlocks.length === 0) return;
		replayedMessages.push({
			role: "assistant",
			content: currentAssistantBlocks,
			api: ANTIGRAVITY_API_ID,
			provider: ANTIGRAVITY_PROVIDER_ID,
			model:
				ctx.model?.provider === ANTIGRAVITY_PROVIDER_ID ? ctx.model.id : "gemini-4-neon",
			responseId: target.sessionId,
			usage: createZeroUsage(),
			stopReason,
			timestamp: Date.now(),
		});
		currentAssistantBlocks = [];

		for (const callId of pendingToolCallIds) {
			const tr = replayedToolResults.get(callId);
			replayedMessages.push({
				role: "toolResult",
				toolCallId: callId,
				toolName: tr?.toolName ?? "agy_tool",
				content:
					tr && tr.content.length > 0
						? tr.content
						: [{ type: "text", text: "(completed)" }],
				isError: tr?.isError ?? false,
				timestamp: Date.now(),
			});
		}
		pendingToolCallIds = [];
	};

	const unsubscribe = coordinator.registerAuxiliaryUpdateListener(target.sessionId, (update) => {
		if (update.sessionUpdate === "user_message_chunk") {
			flushAssistant(pendingToolCallIds.length > 0 ? "toolUse" : "stop");
			if (update.content.type === "text") {
				const prev = currentUserParts[currentUserParts.length - 1];
				if (prev?.type === "text") {
					prev.text += update.content.text;
				} else {
					currentUserParts.push({ type: "text", text: update.content.text });
				}
			} else if (update.content.type === "image") {
				currentUserParts.push({
					type: "image",
					data: update.content.data,
					mimeType: update.content.mimeType,
				});
			}
			return;
		}

		if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
			flushUser();
			if (pendingToolCallIds.length > 0) {
				flushAssistant("toolUse");
			}
			const prev = currentAssistantBlocks[currentAssistantBlocks.length - 1];
			if (prev?.type === "thinking") {
				prev.thinking += update.content.text;
			} else {
				currentAssistantBlocks.push({ type: "thinking", thinking: update.content.text });
			}
			return;
		}

		if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
			flushUser();
			if (pendingToolCallIds.length > 0) {
				flushAssistant("toolUse");
			}
			const prev = currentAssistantBlocks[currentAssistantBlocks.length - 1];
			if (prev?.type === "text") {
				prev.text += update.content.text;
			} else {
				currentAssistantBlocks.push({ type: "text", text: update.content.text });
			}
			return;
		}

		if (update.sessionUpdate === "tool_call") {
			flushUser();
			const classified = classifyAgyToolCall(update);
			currentAssistantBlocks.push({
				type: "toolCall",
				id: update.toolCallId,
				name: classified.mirrorToolName,
				arguments: classified.arguments,
			});
			pendingToolCallIds.push(update.toolCallId);
			replayedToolResults.set(update.toolCallId, {
				toolName: classified.mirrorToolName,
				content: extractReplayedToolOutput(update.content, update.rawOutput),
				isError: update.status === "failed",
			});
			return;
		}

		if (update.sessionUpdate === "tool_call_update") {
			const entry = replayedToolResults.get(update.toolCallId);
			if (!entry) return;
			if (update.status === "failed") {
				entry.isError = true;
			}
			const nextContent = extractReplayedToolOutput(update.content, update.rawOutput);
			if (nextContent.length > 0) {
				entry.content = nextContent;
			}
		}
	});

	try {
		await conn.request<AcpSessionLoadResult>(
			"session/load",
			{
				sessionId: target.sessionId,
				cwd: target.cwd || ctx.cwd,
				mcpServers: [],
			},
			{ timeoutMs: 25_000 },
		);
		flushUser();
		flushAssistant(pendingToolCallIds.length > 0 ? "toolUse" : "stop");
	} catch (error) {
		ctx.ui.notify(
			`Failed to load Antigravity session: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	} finally {
		unsubscribe();
		await conn.closeSessionSafe(target.sessionId).catch(() => {});
	}

	let droppedTrailingUsers = 0;
	while (
		replayedMessages.length > 0 &&
		replayedMessages[replayedMessages.length - 1].role === "user"
	) {
		replayedMessages.pop();
		droppedTrailingUsers++;
	}

	const sessionLabel = target.title?.trim() || target.sessionId.slice(0, 8);
	if (replayedMessages.length === 0) {
		ctx.ui.notify(
			droppedTrailingUsers > 0
				? `Cannot import session "${sessionLabel}": it contains only ${droppedTrailingUsers} unanswered user ${droppedTrailingUsers === 1 ? "message" : "messages"} and no completed turns.`
				: `Cannot import session "${sessionLabel}": it has no messages to import.`,
			"warning",
		);
		return;
	}

	const dbCheckpoint = await captureSqliteCheckpoint(coordinator.config, target.sessionId);
	const importedAnchor: AgySessionAnchor = {
		version: 1,
		agySessionId: target.sessionId,
		toolMode: coordinator.config.toolMode,
		transcriptDigest: computeTranscriptDigest(replayedMessages),
		messageCount: replayedMessages.length,
		mountDigest: "",
		toolsDigest: "",
		importedRaw: true,
		...(dbCheckpoint ? { dbCheckpoint } : {}),
	};

	try {
		await ctx.newSession({
			setup: async (sessionManager) => {
				for (const msg of replayedMessages) {
					sessionManager.appendMessage(msg);
				}
				if (target.title?.trim()) {
					sessionManager.appendSessionInfo(target.title.trim());
				}
				// 直接在 setup 阶段通过新会话自身的 sessionManager 写入恢复锚点，避免旧扩展闭包因 session 替换失效
				sessionManager.appendCustomEntry(AGY_SESSION_ANCHOR_CUSTOM_TYPE, importedAnchor);
			},
			withSession: async (replacedCtx) => {
				const modelHint =
					replacedCtx.model?.provider !== ANTIGRAVITY_PROVIDER_ID
						? " The current model is not an Antigravity model; select an `antigravity/…` model with `/model` to continue this conversation."
						: "";
				const skippedNote =
					droppedTrailingUsers > 0
						? `; skipped ${droppedTrailingUsers} unanswered trailing user ${droppedTrailingUsers === 1 ? "message" : "messages"}`
						: "";
				replacedCtx.ui.notify(
					`Imported session "${target.title || target.sessionId.slice(0, 8)}" (${replayedMessages.length} messages${skippedNote}).${modelHint}`,
					"info",
				);
			},
		});
	} catch (error) {
		ctx.ui.notify(
			`Failed to create imported Pi session: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}
