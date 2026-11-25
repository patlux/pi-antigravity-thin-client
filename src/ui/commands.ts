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
import type { AcpProcessManager } from "../acp/process-manager.ts";
import type {
	AcpSessionListResult,
	AcpSessionLoadResult,
	AcpSessionSummary,
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
import { AGY_SESSION_ANCHOR_CUSTOM_TYPE, type AgySessionAnchor } from "../session/checkpoint-sync.ts";
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
}

/** `/agy mode` and `/agy bridge` of upstream: switching away from agy-tools does not exist here. */
export const THIN_CLIENT_FIXED_MODE =
	"There is no /agy mode or /agy bridge in this thin client: Antigravity always works with its own tools, and Pi's MCP servers, skills and AGENTS.md are never passed to it.";

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "Antigravity CLI, subscription tier, execution mode and session" },
	{ value: "agent-mode", label: "agent-mode", description: "切换 AGY 原生执行模式 (default | accept-edits | plan)" },
	{ value: "refresh", label: "refresh", description: "重新探测当前账号可用的模型与思考档位" },
	{ value: "sessions", label: "sessions", description: "浏览本机 AGY 会话并导入至当前 Pi 会话" },
	{ value: "login", label: "login", description: "执行官方 agy 终端登录授权" },
	{ value: "logout", label: "logout", description: "登出当前 AGY 账号凭据" },
];

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
			{ value: "agent-mode default", label: "default", description: "修改与执行命令前按权限规则询问" },
			{ value: "agent-mode accept-edits", label: "accept-edits", description: "自动批准工作区内文件编辑" },
			{ value: "agent-mode plan", label: "plan", description: "先规划方案再执行操作" },
		].filter((i) => i.value.startsWith(`agent-mode ${arg1}`));
	}

	return null;
}

/** 注册统一的 `/agy` 斜杠命令入口 */
export function registerAntigravityCommands(deps: CommandDependencies): void {
	const { pi, processManager, coordinator, onRefreshProviderModels } = deps;

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
					ctx.ui.notify("正在探测 Antigravity 可用模型目录...", "info");
					try {
						const count = await onRefreshProviderModels(ctx);
						ctx.ui.notify(`已刷新 Antigravity 模型目录（共 ${count} 个可用模型）。`, "info");
					} catch (error) {
						ctx.ui.notify(
							`模型刷新失败：${error instanceof Error ? error.message : String(error)}`,
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
					await handleLogoutSubcommand(ctx, processManager, coordinator);
					return;
				}
				case "sessions":
				case "import": {
					await handleSessionsImportSubcommand(ctx, processManager, coordinator);
					return;
				}
				default: {
					ctx.ui.notify(
						`未知子命令 "${sub}"。可用子命令：status, agent-mode, refresh, sessions, login, logout`,
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
		`Antigravity CLI：${bin ? `${bin.binPath}${ver ? ` (v${ver})` : ""}` : "未找到可执行文件"}`,
		`订阅层级：${telemetry.tier ? `${telemetry.tier.name}` : "待首次连接探测"}`,
		"Thin client: Antigravity's own tools; Pi MCP, skills and AGENTS.md are never passed on",
		`AGY 原生执行策略：${cfg.agyExecutionMode}`,
		`活跃会话：${telemetry.agySessionId ?? "无（将在下次提问时按需创建）"}`,
	];

	if (typeof telemetry.usedTokens === "number") {
		const winText = telemetry.windowSize ? ` / ${telemetry.windowSize.toLocaleString()}` : "";
		lines.push(`实时后端上下文占用：${telemetry.usedTokens.toLocaleString()}${winText} tokens`);
	}

	if (ctx.hasUI) {
		await ctx.ui.select("Antigravity 状态总览（按 Esc 关闭）", lines);
	} else {
		ctx.ui.notify(lines.join("\n"), "info");
	}
}

async function handleAgentModeSubcommand(
	args: string[],
	ctx: ExtensionCommandContext,
	coordinator: TurnCoordinator,
): Promise<void> {
	const valid: AgyExecutionMode[] = ["default", "accept-edits", "plan"];
	let chosen = args[0]?.toLowerCase() as AgyExecutionMode | undefined;

	if (!chosen || !valid.includes(chosen)) {
		if (!ctx.hasUI) {
			ctx.ui.notify("用法：/agy agent-mode <default | accept-edits | plan>", "warning");
			return;
		}
		const picked = await ctx.ui.select(
			`选择 AGY 原生执行模式（当前：${coordinator.config.agyExecutionMode}）`,
			[
				"default — 修改文件与执行命令前按权限设置询问",
				"accept-edits — 自动批准工作区内文件修改",
				"plan — 先输出规划方案再执行",
			],
		);
		if (!picked) return;
		chosen = picked.split(" ")[0] as AgyExecutionMode;
	}

	const nextConfig: BridgeConfig = {
		...coordinator.config,
		agyExecutionMode: chosen,
	};
	coordinator.setConfig(nextConfig);
	saveGlobalBridgeConfigPatch({ agyExecutionMode: chosen });
	await coordinator.applyExecutionModeLive(chosen);
	updateAntigravityStatusBar(ctx, nextConfig, coordinator.getTelemetrySnapshot());

	ctx.ui.notify(`已将 AGY 原生执行模式设为 ${chosen}。`, "info");
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
		ctx.ui.notify("未找到本机 agy 可执行文件，请先安装 Antigravity CLI。", "error");
		return;
	}

	if (ctx.mode === "tui") {
		const confirmed = await ctx.ui.confirm(
			"Antigravity 登录说明",
			"认证凭据由官方 agy CLI 本地管理，本扩展不读取或保存任何令牌。\n是否在当前终端启动官方 `agy acp --login` 完成授权？",
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
			const count = await onRefreshProviderModels(ctx);
			ctx.ui.notify(`登录完成，已加载 ${count} 个可用模型。`, "info");
		} else {
			ctx.ui.notify("登录流程未完成，也可在独立终端执行 `agy acp --login` 后运行 `/agy refresh`。", "warning");
		}
		return;
	}

	ctx.ui.notify("请在终端执行 `agy acp --login` 完成登录，随后运行 `/agy refresh` 刷新模型。", "info");
}

async function handleLogoutSubcommand(
	ctx: ExtensionCommandContext,
	processManager: AcpProcessManager,
	coordinator: TurnCoordinator,
): Promise<void> {
	try {
		const conn = await processManager.acquire(coordinator.config);
		await conn.request("auth/logout", {}, { timeoutMs: 10_000 });
		await coordinator.dispose();
		ctx.ui.notify("已登出 Antigravity 账号。", "info");
	} catch (error) {
		ctx.ui.notify(
			`登出失败：${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

async function handleSessionsImportSubcommand(
	ctx: ExtensionCommandContext,
	processManager: AcpProcessManager,
	coordinator: TurnCoordinator,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("浏览并导入历史会话需要交互式界面支持。", "warning");
		return;
	}

	const conn = await processManager.acquire(coordinator.config);
	const listRes = await conn.request<AcpSessionListResult>(
		"session/list",
		{ cwd: ctx.cwd },
		{ timeoutMs: 15_000 },
	);

	const sessions: AcpSessionSummary[] = listRes.sessions ?? [];
	if (sessions.length === 0) {
		ctx.ui.notify("未找到可导入的本机 Antigravity 历史会话。", "info");
		return;
	}

	const topSessions = sessions.slice(0, 30);
	const labels = topSessions.map((s) => {
		const title = s.title?.trim() || "(无标题会话)";
		const time = s.updatedAt ? ` · ${s.updatedAt}` : "";
		return `${title}${time} [${s.sessionId.slice(0, 8)}]`;
	});

	const pickedLabel = await ctx.ui.select("选择要导入到新 Pi 会话的 AGY 会话", labels);
	if (!pickedLabel) return;

	const idx = labels.indexOf(pickedLabel);
	const target = topSessions[idx >= 0 ? idx : 0];

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
				content: [],
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
			if (update.content && update.content.length > 0) {
				const blocks: Array<TextContent | ImageContent> = [];
				for (const item of update.content) {
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
					entry.content = blocks;
				}
			} else if (typeof update.rawOutput === "string" && update.rawOutput.trim().length > 0) {
				entry.content = [{ type: "text", text: update.rawOutput }];
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
	} finally {
		unsubscribe();
		await conn.closeSessionSafe(target.sessionId);
	}

	const importedAnchor: AgySessionAnchor = {
		version: 1,
		agySessionId: target.sessionId,
		toolMode: coordinator.config.toolMode,
		transcriptDigest: computeTranscriptDigest(replayedMessages),
		messageCount: replayedMessages.length,
		mountDigest: "",
		toolsDigest: "",
		importedRaw: true,
	};

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
					? " 当前模型非 Antigravity，请先使用 `/model` 切换至 `antigravity` 分组模型以无缝续接该会话。"
					: "";
			replacedCtx.ui.notify(
				`已导入会话 "${target.title || target.sessionId.slice(0, 8)}"（共 ${replayedMessages.length} 条消息）。${modelHint}`,
				"info",
			);
		},
	});
}
