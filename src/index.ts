import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type ProviderConfig,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { buildAgySpawnSpec, resolveAgyBinary } from "./acp/binary-resolver.ts";
import { BackgroundActivityController } from "./background/background-controller.ts";
import { AcpProcessManager } from "./acp/process-manager.ts";
import {
	ANTIGRAVITY_API_ID,
	ANTIGRAVITY_BASE_URL,
	ANTIGRAVITY_PROVIDER_ID,
	type ChatModelConfig,
	getSeedModels,
	probeLiveAntigravityCatalog,
	readCachedCatalog,
} from "./catalog/model-discovery.ts";
import { loadBridgeConfig, resolvePiAgentDir } from "./config.ts";
import { discoverAgySkillDirectoriesForPi } from "./session/customization-mounter.ts";
import { extractVisibleMessages } from "./session/reconcile.ts";
import { TurnCoordinator } from "./session/turn-coordinator.ts";
import {
	AgyTurnMirrorBroker,
	createAgyMirrorToolDefinitions,
} from "./tools/agy-mirror-tools.ts";
import { createAgyToolRendererResolver } from "./tools/agy-renderers.ts";
import {
	registerAntigravityCommands,
	ToolActivationController,
} from "./ui/commands.ts";
import {
	AUTONOMOUS_ENTRY_TYPE,
	isAutonomousEntryData,
	renderAutonomousEntry,
	setAgyModelNames,
} from "./ui/background-activity.ts";
import { updateAntigravityStatusBar } from "./ui/status-bar.ts";

const SENTINEL_API_KEY = "agy-managed";
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const MODEL_CACHE_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * 读取 Pi 的 `trust.json` 判断指定工作目录在 `resources_discover` 早期阶段是否已被授予项目信任。
 */
function checkProjectTrustedFromStore(cwd: string): boolean {
	try {
		const trustFile = path.join(resolvePiAgentDir(), "trust.json");
		if (!fs.existsSync(trustFile)) return false;
		const parsed: unknown = JSON.parse(fs.readFileSync(trustFile, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		const store = parsed as Record<string, unknown>;
		const isWin = process.platform === "win32";
		const norm = (p: string) => {
			let resolved = p;
			try {
				resolved = fs.realpathSync(p);
			} catch {
				resolved = path.resolve(p);
			}
			return isWin ? resolved.toLowerCase() : resolved;
		};

		const normalizedStore = new Map<string, boolean>();
		for (const [k, v] of Object.entries(store)) {
			if (typeof v === "boolean") {
				normalizedStore.set(norm(k), v);
			}
		}

		let current = norm(cwd);
		while (true) {
			const decision = normalizedStore.get(current);
			if (typeof decision === "boolean") {
				return decision;
			}
			const parent = path.dirname(current);
			if (parent === current) return false;
			current = parent;
		}
	} catch {
		return false;
	}
}

/**
 * Pi × Antigravity ACP 桥接扩展主入口。
 */
export default function antigravityBridgeExtension(pi: ExtensionAPI): void {
	let currentConfig = loadBridgeConfig();
	const processManager = new AcpProcessManager();
	const mirrorBroker = new AgyTurnMirrorBroker();
	const coordinator = new TurnCoordinator(pi, processManager, mirrorBroker, currentConfig);
	const toolActivation = new ToolActivationController(pi);

	const cachedCatalog = readCachedCatalog();
	if (cachedCatalog?.tier) {
		coordinator.setLatestTier(cachedCatalog.tier);
	}
	let currentModels: ChatModelConfig[] = cachedCatalog?.models ?? getSeedModels();
	// Display names for models agy reports in its transcripts (subagents, own turns).
	setAgyModelNames((baseId) => currentModels.find((model) => model.id === baseId)?.name);

	const buildProviderConfig = (models: ChatModelConfig[]): ProviderConfig => ({
		name: "Google Antigravity (ACP)",
		baseUrl: ANTIGRAVITY_BASE_URL,
		apiKey: SENTINEL_API_KEY,
		api: ANTIGRAVITY_API_ID,
		models,
		streamSimple: (model, context, options) => coordinator.streamSimple(model, context, options),
		async refreshModels(refreshCtx) {
			if (!refreshCtx.allowNetwork) {
				const disk = readCachedCatalog();
				if (disk?.tier) {
					coordinator.setLatestTier(disk.tier);
				}
				if (disk?.models && disk.models.length > 0) {
					currentModels = disk.models;
				}
				return currentModels;
			}
			const snapshot = await probeLiveAntigravityCatalog(
				processManager,
				coordinator.config,
				process.cwd(),
				{ signal: refreshCtx.signal, force: refreshCtx.force },
			);
			if (snapshot.tier) {
				coordinator.setLatestTier(snapshot.tier);
			}
			currentModels = snapshot.models;
			return snapshot.models;
		},
		oauth: {
			name: "Google Antigravity CLI (agy)",
			isSubscription: true,
			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				callbacks.onProgress?.(
					"认证由官方 agy CLI 本地自行管理，本扩展不读取或存储任何 OAuth 令牌。",
				);
				const bin = resolveAgyBinary({
					configuredBin: coordinator.config.agyBin,
					geminiDir: coordinator.config.geminiDir,
				});
				if (!bin) {
					throw new Error("未找到本机 agy 可执行文件，请先安装 Antigravity CLI。");
				}

				// 先探测当前本机 agy 是否已处于有效登录态
				try {
					const snapshot = await probeLiveAntigravityCatalog(
						processManager,
						coordinator.config,
						process.cwd(),
						callbacks.signal,
					);
					if (snapshot.models.length > 0) {
						currentModels = snapshot.models;
						if (snapshot.tier) coordinator.setLatestTier(snapshot.tier);
						return {
							access: SENTINEL_API_KEY,
							refresh: SENTINEL_API_KEY,
							expires: Date.now() + TEN_YEARS_MS,
						};
					}
				} catch {
					// 未登录或探测失败时继续后续引导
				}

				const activeCtx = coordinator.getActiveContext();
				if (activeCtx?.mode === "tui") {
					throw new Error(
						"当前处于交互式 TUI 面板，请按 Esc 返回后执行 `/agy login`（自动安全释放并恢复终端完成登录），或在独立终端运行 `agy acp --login`。",
					);
				}

				const loginSpec = buildAgySpawnSpec(bin, [
					"acp",
					"--login",
					"--gemini-dir",
					coordinator.config.geminiDir,
				]);
				const res = spawnSync(loginSpec.command, loginSpec.args, {
					stdio: "inherit",
					windowsVerbatimArguments: loginSpec.windowsVerbatimArguments,
				});
				if (res.status !== 0) {
					throw new Error("官方 agy 登录未完成，可在独立终端运行 `agy acp --login` 后重试。");
				}

				return {
					access: SENTINEL_API_KEY,
					refresh: SENTINEL_API_KEY,
					expires: Date.now() + TEN_YEARS_MS,
				};
			},
			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
				return {
					...credentials,
					access: SENTINEL_API_KEY,
					expires: Date.now() + TEN_YEARS_MS,
				};
			},
			getApiKey(): string {
				return SENTINEL_API_KEY;
			},
		},
	});

	// 1. 注册 Antigravity 自定义 Provider
	pi.registerProvider(ANTIGRAVITY_PROVIDER_ID, buildProviderConfig(currentModels));

	// 2. 注册模式 A 镜像工具定义与全局渲染器（支持历史回放与 HTML 导出渲染）
	const mirrorTools = createAgyMirrorToolDefinitions(mirrorBroker, (agySessionId) => {
		coordinator.cancelAgySessionById(agySessionId);
	});
	for (const tool of mirrorTools) {
		pi.registerTool(tool);
	}
	pi.registerToolRenderer(createAgyToolRendererResolver());

	// 2b. What agy does between Pi turns (background tasks, turns it takes on its own):
	// a live widget and session cards. Display only; nothing goes to agy or the model.
	const background = new BackgroundActivityController(pi, coordinator);
	mirrorBroker.setEmptyResultNote((context) => background.emptyResultNote(context));
	coordinator.setOutOfTurnListener((agySessionId, update) => background.onOutOfTurnUpdate(agySessionId, update));
	pi.registerEntryRenderer(AUTONOMOUS_ENTRY_TYPE, (entry, options, theme) => {
		if (!isAutonomousEntryData(entry.data)) return undefined;
		return renderAutonomousEntry(
			entry.data,
			options.expanded,
			theme,
			(text) => new Markdown(text, 0, 0, getMarkdownTheme()),
			options.keyHint("app.tools.expand", "zum Aufklappen"),
		);
	});

	// 3. 注册 `/agy` 命令族
	let backgroundRefreshController: AbortController | undefined;
	const refreshAndReRegisterModels = async (
		ctx: ExtensionContext,
		overrideSignal?: AbortSignal,
	): Promise<number> => {
		const signal = overrideSignal ?? ctx.signal;
		const snapshot = await probeLiveAntigravityCatalog(
			processManager,
			coordinator.config,
			ctx.cwd,
			{ signal, force: true },
		);
		if (signal?.aborted) {
			return currentModels.length;
		}
		if (snapshot.tier) {
			coordinator.setLatestTier(snapshot.tier);
		}
		currentModels = snapshot.models;
		pi.registerProvider(ANTIGRAVITY_PROVIDER_ID, buildProviderConfig(currentModels));
		updateAntigravityStatusBar(ctx, coordinator.config, coordinator.getTelemetrySnapshot());
		return currentModels.length;
	};

	registerAntigravityCommands({
		pi,
		processManager,
		coordinator,
		toolActivation,
		onRefreshProviderModels: refreshAndReRegisterModels,
	});

	// 4. 注册可选的反向 AGY Skills 发现钩子
	pi.on("resources_discover", (event) => {
		const isTrusted =
			coordinator.getActiveContext()?.cwd === event.cwd
				? (coordinator.getActiveContext()?.isProjectTrusted() ?? false)
				: checkProjectTrustedFromStore(event.cwd);
		const cfg = loadBridgeConfig({ cwd: event.cwd, isProjectTrusted: isTrusted });
		const skillDirs = discoverAgySkillDirectoriesForPi(cfg, event.cwd);
		if (skillDirs.length === 0) {
			return undefined;
		}
		return { skillPaths: skillDirs };
	});

	// 5. 会话生命周期与状态栏同步钩子
	pi.on("session_start", (_event, ctx) => {
		currentConfig = loadBridgeConfig({
			cwd: ctx.cwd,
			isProjectTrusted: ctx.isProjectTrusted(),
		});
		coordinator.setConfig(currentConfig);
		coordinator.setActiveContext(ctx);
		toolActivation.syncForContext(ctx, currentConfig);

		// 若首次加载尚无本地缓存快照或缓存已超过 6 小时，复用内置 Singleflight 后台静默探测一次最新模型目录
		const diskCache = readCachedCatalog();
		const isCacheStale =
			!diskCache ||
			typeof diskCache.updatedAt !== "number" ||
			Date.now() - diskCache.updatedAt > MODEL_CACHE_STALE_MS;
		if (isCacheStale) {
			backgroundRefreshController?.abort();
			backgroundRefreshController = new AbortController();
			void refreshAndReRegisterModels(ctx, backgroundRefreshController.signal).catch(() => {});
		}
	});

	// Thin-client guard: remember which user messages the human typed in this session.
	pi.on("input", (event) => {
		coordinator.humanPromptGate.noteInput(event.source, event.text);
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "user") {
			coordinator.humanPromptGate.noteUserMessage(event.message);
		}
	});

	pi.on("model_select", (_event, ctx) => {
		coordinator.setActiveContext(ctx);
		toolActivation.syncForContext(ctx, coordinator.config);
		updateAntigravityStatusBar(ctx, coordinator.config, coordinator.getTelemetrySnapshot());
	});

	pi.on("before_agent_start", (_event, ctx) => {
		coordinator.setActiveContext(ctx);
		toolActivation.syncForContext(ctx, coordinator.config);
	});

	pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
		if (ctx.model?.provider !== ANTIGRAVITY_PROVIDER_ID) return;
		background.sync(ctx);
		const stopReason = event.message.role === "assistant" ? event.message.stopReason : undefined;
		if (stopReason === "toolUse") {
			updateAntigravityStatusBar(ctx, coordinator.config, coordinator.getTelemetrySnapshot());
			return;
		}
		if (
			stopReason === "aborted" ||
			stopReason === "error" ||
			event.outcome !== "completed"
		) {
			if (stopReason === "aborted" || event.outcome === "aborted") {
				coordinator.cancelActiveTurnForPiSession(ctx.sessionManager.getSessionId());
			}
			updateAntigravityStatusBar(ctx, coordinator.config, coordinator.getTelemetrySnapshot());
			return;
		}
		const visible = extractVisibleMessages(event.context.llmMessages);
		await coordinator.persistTurnAnchor(visible, ctx.sessionManager.getSessionId());
		updateAntigravityStatusBar(ctx, coordinator.config, coordinator.getTelemetrySnapshot());
	});

	pi.on("agent_end", (_event, ctx) => {
		// 若用户在本地工具执行间隙按下 Esc 中断退出，同步结算挂起的后台 MCP 请求并异步发送 session/cancel
		coordinator.cancelActiveTurnForPiSession(ctx.sessionManager.getSessionId());
		updateAntigravityStatusBar(ctx, coordinator.config, coordinator.getTelemetrySnapshot());
	});

	pi.on("session_compact", async (_event, ctx) => {
		// 上下文压缩完成后关闭旧 ACP 会话，使下一轮请求自动携带压缩摘要开启轻装新会话
		await coordinator.invalidatePiSession(ctx.sessionManager.getSessionId());
		updateAntigravityStatusBar(ctx, coordinator.config, coordinator.getTelemetrySnapshot());
	});

	pi.on("session_tree", (_event, ctx) => {
		coordinator.setActiveContext(ctx);
		updateAntigravityStatusBar(ctx, coordinator.config, coordinator.getTelemetrySnapshot());
	});

	pi.on("session_shutdown", async () => {
		background.stop();
		backgroundRefreshController?.abort();
		backgroundRefreshController = undefined;
		await coordinator.dispose();
	});
}
