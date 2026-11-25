import * as fs from "node:fs";
import {
	getCurrentSystemPrompt,
	getCurrentTools,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type Tool,
	type ToolResultMessage,
	type TranscriptContext,
	type Usage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BRIDGE_AGENT_NAME, type AcpClientConnection, type AcpProcessManager } from "../acp/process-manager.ts";
import { AcpUpdateTrace } from "../acp/update-trace.ts";
import { HumanPromptGate, trailingUserMessages } from "../human-prompt-gate.ts";
import {
	AUXILIARY_REFUSED,
	enforceThinClientPolicy,
	HEADLESS_REFUSED,
	NO_NEW_PROMPT_REFUSED,
	ThinClientPolicyError,
} from "../thin-client-policy.ts";
import type {
	AcpAvailableModel,
	AcpConfigOption,
	AcpMcpServerSpec,
	AcpPromptBlock,
	AcpPromptResponse,
	AcpPromptUsage,
	AcpSessionNewResult,
	AcpSessionResumeResult,
	AcpSessionUpdateNotification,
	AcpSessionUpdatePayload,
	AcpSetConfigOptionResult,
	AcpTierInfo,
} from "../acp/protocol.ts";
import {
	ANTIGRAVITY_PROVIDER_ID,
	recordObservedContextWindow,
	removeEmptyProbeSessionFiles,
	resolveSessionModelSelection,
} from "../catalog/model-discovery.ts";
import {
	type BridgeConfig,
	resolveAgyConversationsDir,
	resolveEffectiveFlags,
	type ToolMode,
} from "../config.ts";
import {
	LocalHttpMcpBridge,
	type ParkedToolCall,
	toExposedMcpToolName,
} from "../mcp/http-mcp-bridge.ts";
import {
	computeToolsFingerprint,
	filterToolsForHostMcpBridge,
	loadDirectPiMcpServerSpecs,
} from "../mcp/pi-mcp-forwarder.ts";
import {
	convertAcpUsageToPiUsage,
	createZeroUsage,
	StepStreamWriter,
} from "../stream/event-mapper.ts";
import type { AgyTurnMirrorBroker } from "../tools/agy-mirror-tools.ts";
import {
	updateAntigravityStatusBar,
	type RuntimeTelemetrySnapshot,
} from "../ui/status-bar.ts";
import {
	AGY_SESSION_ANCHOR_CUSTOM_TYPE,
	type AgySessionAnchor,
	appendPreloadedTurnsToSqliteConversation,
	captureSqliteCheckpoint,
	cloneTemplateSqliteConversationWithPreload,
	findBranchAnchorForHistory,
	forkSqliteConversationAtCheckpoint,
	hasLocalConversationDb,
	hasValidAgentMetadataBlob,
	readCurrentMaxSqliteGenIdx,
	readCurrentMaxSqliteStepIdx,
	readLatestSqliteUpstreamRequestSince,
	readSqliteGenerationUsagesSince,
	readSqliteGenerationUsagesSinceWithRetry,
	waitForSqliteToolStepsSettled,
} from "./checkpoint-sync.ts";
import { prepareCustomizationMount } from "./customization-mounter.ts";
import {
	buildDetachedToolResultBlocks,
	buildFreshReplayPlan,
	buildPromptBlocksPreloadPlan,
	computeTranscriptDigest,
	convertUserMessagesToPromptBlocks,
	exceedsSafeSingleStepBudget,
	extractAuxiliaryTaskInstructions,
	extractVisibleMessages,
	inspectTrafficOptProjectionState,
	isAuxiliarySingleTurnRequest,
	SUMMARY_SYSTEM_HINT_PATTERN,
	type PreloadedSqliteTurn,
	type TrafficOptProjectionState,
} from "./reconcile.ts";

/**
 * Error prefix for an exhausted Antigravity quota. "quota exceeded" is in Pi's
 * non-retryable provider-limit pattern, so Pi does not repeat the prompt by itself.
 */
const QUOTA_EXCEEDED_ERROR = "Antigravity quota exceeded (429)";

type PumpQueueItem =
	| { kind: "acp_update"; update: AcpSessionUpdatePayload }
	| { kind: "mcp_parked"; call: ParkedToolCall }
	| { kind: "prompt_done"; response: AcpPromptResponse }
	| { kind: "prompt_error"; error: unknown };

/** 异步 FIFO 事件队列，驱动单个原生 ACP Turn 跨多个 Pi `streamSimple` 步无缝流转 */
class AsyncEventQueue<T> {
	private readonly items: T[] = [];
	private readonly resolvers: Array<(item: T) => void> = [];

	push(item: T): void {
		const waiter = this.resolvers.shift();
		if (waiter) {
			waiter(item);
		} else {
			this.items.push(item);
		}
	}

	shift(signal?: AbortSignal): Promise<T> {
		const next = this.items.shift();
		if (next !== undefined) {
			return Promise.resolve(next);
		}
		if (signal?.aborted) {
			return Promise.reject(signal.reason ?? new Error("Aborted"));
		}

		return new Promise<T>((resolve, reject) => {
			const wrapped = (val: T) => {
				cleanup?.();
				resolve(val);
			};
			let cleanup: (() => void) | undefined;
			if (signal) {
				const onAbort = () => {
					const idx = this.resolvers.indexOf(wrapped);
					if (idx !== -1) this.resolvers.splice(idx, 1);
					reject(signal.reason ?? new Error("Aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				cleanup = () => signal.removeEventListener("abort", onAbort);
			}
			this.resolvers.push(wrapped);
		});
	}

	peek(): T | undefined {
		return this.items[0];
	}

	some(predicate: (item: T) => boolean): boolean {
		return this.items.some(predicate);
	}

	drainAll(): T[] {
		return this.items.splice(0, this.items.length);
	}
}

/**
 * `agy acp` 内部在 `mcpToolCall.callTool` 中将 `McpToolConfig.MaxOutputBytes` 硬编码为 10,240 字节：
 * - 解码后超过该阈值的宿主 MCP 返回图片会被丢弃内联像素；
 * - 超过该阈值的宿主 MCP 返回文本会被掐头去尾截断并转存至外部临时文件，导致大文件读取与结构化输出往返翻倍。
 * 留出安全余量：大于 9,600 字节的图片或大于 9,200 UTF-8 字节的文本在同批工具结算后自动切入同一热会话 `session/prompt` 完整投递。
 */
const AGY_MCP_INLINE_IMAGE_SAFE_BYTES = 9_600;
const AGY_MCP_INLINE_TEXT_SAFE_BYTES = 9_200;
const MAX_AUTO_CONTINUED_TURN_REQUESTS = 3;

interface DeferredMcpToolPayload {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	texts: string[];
	images: ImageContent[];
}

function getDecodedBase64Bytes(data: string): number {
	return Buffer.byteLength(data, "base64");
}

function buildDeferredMcpOutputPromptBlocks(
	payloads: readonly DeferredMcpToolPayload[],
	includeContinueNote: boolean,
): AcpPromptBlock[] {
	const blocks: AcpPromptBlock[] = [];
	let hasAnyText = false;
	let hasAnyImages = false;
	for (const item of payloads) {
		const status = item.isError ? "error" : "ok";
		if (item.texts.length > 0) {
			hasAnyText = true;
			const body = item.texts.join("\n");
			const imageNote =
				item.images.length > 0
					? `\n[Attached ${item.images.length} image(s) from tool "${item.toolName}" below]`
					: "";
			blocks.push({
				type: "text",
				text: `<tool_result id="${item.toolCallId}" tool="${item.toolName}" status="${status}">\n${body}${imageNote}\n</tool_result>`,
			});
		} else if (item.images.length > 0) {
			blocks.push({
				type: "text",
				text: `<tool_result id="${item.toolCallId}" tool="${item.toolName}" status="${status}">\n[Attached ${item.images.length} image(s) from tool "${item.toolName}" delivered via multimodal prompt]\n</tool_result>`,
			});
		}
		for (const img of item.images) {
			hasAnyImages = true;
			blocks.push({
				type: "image",
				data: img.data,
				mimeType: img.mimeType,
			});
		}
	}
	if (includeContinueNote && blocks.length > 0) {
		blocks.push({
			type: "text",
			text:
				hasAnyImages && !hasAnyText
					? "Please inspect the attached tool result image(s) above and continue."
					: "Please continue using the tool output(s) above.",
		});
	}
	return blocks;
}

interface ActiveTurnPump {
	readonly queue: AsyncEventQueue<PumpQueueItem>;
	finished: boolean;
	cancelledByHoldTimeout: boolean;
	/** 本轮前序中间 `toolUse` 步已经记账的输出 Token 累计数 */
	accountedOutputTokens: number;
	/** 本轮已完成的中间 `toolUse` 推理步计数 */
	intermediateStepCount: number;
	/** 最近一次完成中间步记账时的实时窗口水位，用于拦截同一次模型生成拆出多个工具调用时的重复记账 */
	lastAccountedWindowUsed?: number;
	/** 本轮是否已从本地 SQLite `steps.metadata` 读取到精确逐次生成统计 */
	hasSqliteGenTelemetry: boolean;
	/** 已收到 ACP 前置 `tool_call` 宣告但 HTTP MCP `POST /mcp` 仍在途的并发调用计数 */
	pendingAnnouncedMcpCount: number;
	/** 已向 Pi 推理流发出的宿主 MCP `callId` 集合，防止误结算仍在队列中待消费的后续工具请求 */
	readonly emittedMcpCallIds: Set<string>;
	/** 本轮宿主 MCP 工具返回中因超过 `agy` 10KB 内联上限而延迟到工具边界同会话 `session/prompt` 投递的完整文本与图片 */
	readonly deferredMcpOutputs: DeferredMcpToolPayload[];
	/** 单次连续工具循环触及 `max_turn_requests` 后已自动无感续接的次数 */
	autoContinuedTurnCount: number;
	/** 本步是否已向观测扩展通告 `x-acp-upstream-pending: 1` 等待上游全量快照 */
	awaitingUpstreamTelemetry: boolean;
	/** 本步进入时的归档投影是否与后端会话一致（透传给 `acp-upstream` 响应头） */
	lastStepProjectionSynced: boolean;
	/** 本步刚完成的中间步骤是否复用了同一次生成的工具切片池（未向云端发起新请求） */
	lastStepUsedSlicePool: boolean;
}

interface PendingGenSlicePool {
	remainingSlices: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	windowTotal: number;
}

interface ManagedSessionLedger {
	piSessionKey: string;
	agySessionId: string;
	conn: AcpClientConnection;
	cwd: string;
	isProjectTrusted: boolean;
	additionalDirectories: string[];
	useHttpMcp: boolean;
	mcpToken?: string;
	hostMcpTools: Tool[];
	toolsDigest: string;
	mountDigest: string;
	toolMode: ToolMode;
	configOptions: AcpConfigOption[];
	availableModels: AcpAvailableModel[];
	appliedModelValue?: string;
	appliedThoughtLevel?: string;
	appliedExecMode?: string;
	/** 最近一次在此会话上执行请求的 Pi 模型 ID（防止切换模型后旧会话迟到 usage_update 污染新模型窗口） */
	lastSelectedModelId?: string;
	/** 本次随 SQLite 多步预注入一起写入、尚未在下一条 `session/prompt` 的 `onPayload` 中通告的分片列表 */
	pendingPreloadedTurns?: readonly PreloadedSqliteTurn[];
	syncedMessageCount: number;
	syncedTranscriptDigest: string;
	/** 当前 AGY 会话实际承载的 `pi-traffic-optimization` 归档投影指纹与计数 */
	syncedProjectionDigest: string;
	syncedProjectedCount: number;
	usedTokens?: number;
	windowSize?: number;
	/** 当前会话已进入后端 Prompt Cache 的前缀 Token 水位（供无本地库回退路径估算缓存命中率） */
	cachedPrefixTokens: number;
	/** 最近一次观测到的有效非零缓存命中比例 */
	lastObservedCacheRatio?: number;
	/** 本地 SQLite `steps` 表已消费至的最大 `idx`（仅对大于该水位的 `step_type=15` 新生成记账） */
	lastConsumedStepIdx: number;
	/** 本地 SQLite `gen_metadata` 表已上报上游流量快照的最大 `idx`（防顺序工具切片重复计费） */
	lastReportedUpstreamGenIdx: number;
	/** 单次模型生成内含多个顺序工具调用时的整数守恒分摊池（消除后续子步 0 提示词造成的缓存命中率闪烁） */
	pendingGenSlicePool?: PendingGenSlicePool;
	/** 是否正处于工具边界 steer/reload 切入收口窗口，期间拒绝新冲入的同批后续 MCP 调用 */
	steeringCutInPending?: boolean;
	tier?: AcpTierInfo;
	backendCompactedRecently?: boolean;
	parkedCalls: Map<string, ParkedToolCall>;
	detachedCallIds: Set<string>;
	/** 记录已确认为宿主 MCP 宣告的 ACP `toolCallId`，防止省略 `title` 的 `tool_call_update` 在 hybrid 下串扰 */
	hostMcpAnnouncementIds: Set<string>;
	activePump?: ActiveTurnPump;
	/** 当前会话在后端仍在途的 `session/prompt` RPC Promise（严禁在它结算前重叠发送下一条 `session/prompt`） */
	inFlightPrompt?: Promise<void>;
}

const DEFAULT_SESSION_KEY = "__default_pi_session__";

/**
 * 判断是否应因 `pi-traffic-optimization` 归档投影状态变更而按需重建瘦身后的 AGY 会话：
 * - 非 GC 轮次（投影指纹一致或无新归档）严格返回 `false`，零打扰热缓存；
 * - 发生批量 GC 归档（新增归档 >= 4 项，或已用窗口 >= 32k 且有新增归档）时返回 `true`，让 AGY 真实释放旧工具输出与旧图片上下文；
 * - 用户关闭 `/traffic-opt` 恢复完整上下文（原会话承载归档占位符且现已全部恢复原文）时返回 `true`，重建完整上下文。
 */
function shouldRebuildForProjectionSync(
	syncedDigest: string,
	syncedCount: number,
	current: TrafficOptProjectionState,
	usedTokens?: number,
): boolean {
	if (current.projectionDigest === syncedDigest) {
		return false;
	}
	const delta = current.archivedCount - syncedCount;
	if (delta > 0) {
		if (delta >= 4) return true;
		if (typeof usedTokens === "number" && usedTokens >= 32_000) return true;
		return false;
	}
	if (syncedCount > 0 && current.archivedCount < syncedCount) {
		return true;
	}
	return false;
}

/**
 * 双模会话与流式推理总协调器。
 * 统一调度模式 B（`pi-tools`）、模式 A（`agy-tools`）与混合模式（`hybrid`）。
 */
export class TurnCoordinator {
	private readonly pi: ExtensionAPI;
	private readonly processManager: AcpProcessManager;
	private readonly mirrorBroker: AgyTurnMirrorBroker;
	private readonly ledgers = new Map<string, ManagedSessionLedger>();
	private readonly ledgersByAgyId = new Map<string, ManagedSessionLedger>();
	private readonly auxUpdateListeners = new Map<
		string,
		(update: AcpSessionUpdatePayload) => void
	>();
	private readonly httpMcpBridge: LocalHttpMcpBridge;
	private currentConfig: BridgeConfig;
	private activeContext?: ExtensionContext;
	private latestTier?: AcpTierInfo;
	/** Fed by Pi's `input` and `message_start` events; see `HumanPromptGate`. */
	readonly humanPromptGate = new HumanPromptGate();
	/** Local `session/update` trace, enabled with `PI_AGY_TRACE`. */
	readonly updateTrace = new AcpUpdateTrace();

	constructor(
		pi: ExtensionAPI,
		processManager: AcpProcessManager,
		mirrorBroker: AgyTurnMirrorBroker,
		initialConfig: BridgeConfig,
	) {
		this.pi = pi;
		this.processManager = processManager;
		this.mirrorBroker = mirrorBroker;
		this.currentConfig = enforceThinClientPolicy(initialConfig);
		this.httpMcpBridge = new LocalHttpMcpBridge(initialConfig.mcpHoldLimitMs);

		this.processManager.setHandlers({
			onSessionUpdate: (notification) => this.handleSessionUpdate(notification),
			onRequestPermission: (params) => this.mirrorBroker.handlePermissionRequest(params),
			onElicitationCreate: (params) => this.mirrorBroker.handleElicitationRequest(params),
		});
	}

	get config(): BridgeConfig {
		return this.currentConfig;
	}

	setConfig(nextConfig: BridgeConfig): void {
		this.currentConfig = enforceThinClientPolicy(nextConfig);
		this.httpMcpBridge.setHoldLimitMs(this.currentConfig.mcpHoldLimitMs);
		updateAntigravityStatusBar(this.activeContext, this.currentConfig, this.getTelemetrySnapshot());
	}

	getActiveContext(): ExtensionContext | undefined {
		return this.activeContext;
	}

	setActiveContext(ctx: ExtensionContext | undefined): void {
		this.activeContext = ctx;
		this.mirrorBroker.setFallbackUiContext(ctx);
		updateAntigravityStatusBar(ctx, this.currentConfig, this.getTelemetrySnapshot());
	}

	setLatestTier(tier: AcpTierInfo | undefined): void {
		if (tier) {
			this.latestTier = tier;
		}
	}

	getTelemetrySnapshot(piSessionId?: string): RuntimeTelemetrySnapshot {
		const key = piSessionId || this.resolveCurrentPiSessionKey();
		const ledger = this.ledgers.get(key);
		return {
			agySessionId: ledger?.agySessionId,
			tier: ledger?.tier ?? this.latestTier,
			usedTokens: ledger?.usedTokens,
			windowSize: ledger?.windowSize,
			backendCompactedRecently: ledger?.backendCompactedRecently,
		};
	}

	/** Whether the agy process serving this conversation is still running. */
	isAgySessionAlive(agySessionId: string): boolean {
		return Boolean(this.ledgersByAgyId.get(agySessionId)?.conn.isAlive);
	}

	/** 用户主动取消某个正在执行的 AGY 原生会话 */
	cancelAgySessionById(agySessionId: string): void {
		const ledger = this.ledgersByAgyId.get(agySessionId);
		if (!ledger) return;
		this.abortLedgerTurnNonBlocking(ledger);
	}

	/** 实时切换当前活跃会话的 AGY 原生执行模式（`default` | `accept-edits` | `plan`） */
	async applyExecutionModeLive(mode: string): Promise<void> {
		const ledger = this.ledgers.get(this.resolveCurrentPiSessionKey());
		if (!ledger || !ledger.conn.isAlive || ledger.toolMode === "pi-tools") return;
		try {
			const res = await ledger.conn.request<AcpSetConfigOptionResult>(
				"session/set_config_option",
				{
					sessionId: ledger.agySessionId,
					configId: "mode",
					value: mode,
				},
				{ timeoutMs: 8_000 },
			);
			if (res.configOptions) {
				ledger.configOptions = res.configOptions;
			}
			ledger.appliedExecMode = mode;
		} catch {
			// 忽略离线会话设置失败，下一轮请求会自动重新对齐
		}
	}

	/** 当发生 `/compact`、`/new` 或切换会话时清理旧后端会话绑定 */
	async invalidatePiSession(piSessionId?: string): Promise<void> {
		const key = piSessionId || this.resolveCurrentPiSessionKey();
		const ledger = this.ledgers.get(key);
		if (!ledger) return;
		await this.teardownLedger(ledger);
	}

	/** 在每轮对话正常稳定完结时，将最新会话锚点（含可选 SQLite 检查点）追加进 Pi `.jsonl` 分支 */
	async persistTurnAnchor(
		messagesSnapshot?: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
		piSessionId?: string,
	): Promise<void> {
		if (messagesSnapshot && messagesSnapshot.length > 0) {
			const tail = messagesSnapshot[messagesSnapshot.length - 1];
			if (
				tail.role === "assistant" &&
				(tail.stopReason === "aborted" ||
					tail.stopReason === "error" ||
					tail.stopReason === "toolUse")
			) {
				return;
			}
		}

		const key = this.resolveCurrentPiSessionKey(piSessionId);
		const ledger = this.ledgers.get(key);
		if (!ledger || ledger.activePump || ledger.parkedCalls.size > 0) {
			return;
		}

		const settled = await this.waitForInFlightPrompt(ledger, 1_500);
		if (!settled || ledger.activePump || ledger.parkedCalls.size > 0) {
			return;
		}

		if (messagesSnapshot) {
			ledger.syncedMessageCount = messagesSnapshot.length;
			ledger.syncedTranscriptDigest = computeTranscriptDigest(messagesSnapshot);
		}

		const dbCheckpoint = await captureSqliteCheckpoint(this.currentConfig, ledger.agySessionId);
		const anchor: AgySessionAnchor = {
			version: 1,
			agySessionId: ledger.agySessionId,
			toolMode: ledger.toolMode,
			transcriptDigest: ledger.syncedTranscriptDigest,
			messageCount: ledger.syncedMessageCount,
			mountDigest: ledger.mountDigest,
			toolsDigest: ledger.toolsDigest,
			...(ledger.syncedProjectedCount > 0
				? {
						projectionDigest: ledger.syncedProjectionDigest,
						projectedCount: ledger.syncedProjectedCount,
					}
				: {}),
			...(typeof ledger.usedTokens === "number" ? { usedTokens: ledger.usedTokens } : {}),
			dbCheckpoint,
		};

		try {
			this.pi.appendEntry(AGY_SESSION_ANCHOR_CUSTOM_TYPE, anchor);
		} catch {
			// 非持久化模式或只读上下文下忽略
		}
	}

	/** 供 `/agy sessions` 浏览导入后直接建立内存与分支锚点绑定 */
	registerImportedSessionAnchor(params: {
		agySessionId: string;
		visibleMessages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[];
		mountDigest: string;
		importedRaw?: boolean;
	}): AgySessionAnchor {
		const anchor: AgySessionAnchor = {
			version: 1,
			agySessionId: params.agySessionId,
			toolMode: this.currentConfig.toolMode,
			transcriptDigest: computeTranscriptDigest(params.visibleMessages),
			messageCount: params.visibleMessages.length,
			mountDigest: params.mountDigest,
			toolsDigest: "",
			importedRaw: params.importedRaw,
		};
		try {
			this.pi.appendEntry(AGY_SESSION_ANCHOR_CUSTOM_TYPE, anchor);
		} catch {
			// 忽略
		}
		return anchor;
	}

	/**
	 * 当用户按下 `Esc` 中断流或在工具执行期间中断整个 Agent Run 时，
	 * 0 毫秒同步清理挂起中的 MCP 工具调用与活跃队列，并发送 ACP 单向 `session/cancel` 通知。
	 */
	cancelActiveTurnForPiSession(piSessionId?: string): void {
		const key = piSessionId || this.resolveCurrentPiSessionKey();
		const ledger = this.ledgers.get(key);
		if (!ledger) return;
		if (!ledger.activePump && ledger.parkedCalls.size === 0 && !ledger.inFlightPrompt) {
			return;
		}
		this.abortLedgerTurnNonBlocking(ledger);
	}

	private abortLedgerTurnNonBlocking(ledger: ManagedSessionLedger): void {
		this.httpMcpBridge.markSessionTurnCancelled(ledger.agySessionId);
		this.mirrorBroker.abortSessionCalls(ledger.agySessionId, "Aborted");
		for (const [, parked] of ledger.parkedCalls) {
			parked.settle({
				isError: true,
				content: [{ type: "text", text: "Cancelled" }],
			});
		}
		ledger.parkedCalls.clear();
		ledger.pendingGenSlicePool = undefined;
		if (ledger.activePump) {
			ledger.activePump.finished = true;
		}
		ledger.activePump = undefined;
		ledger.conn.notify("session/cancel", { sessionId: ledger.agySessionId });
	}

	/**
	 * 等待会话在途的 `session/prompt` 请求结算完成。
	 * 若超出最大容忍时间仍未结算（例如底层进程死锁），返回 `false` 以便上层驱逐卡死进程并无缝重建。
	 */
	private async waitForInFlightPrompt(
		ledger: ManagedSessionLedger,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<boolean> {
		const inflight = ledger.inFlightPrompt;
		if (!inflight) return true;
		if (signal?.aborted) return false;

		return new Promise<boolean>((resolve) => {
			let done = false;
			const finish = (ok: boolean) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(ok);
			};

			const onAbort = () => finish(false);
			signal?.addEventListener("abort", onAbort, { once: true });

			const timer = setTimeout(() => {
				finish(false);
			}, timeoutMs);

			void inflight.finally(() => {
				finish(true);
			});
		});
	}

	/** 驱逐已卡死的后端连接与会话绑定，确保下一轮消息能通过健康新进程正常响应 */
	private async discardWedgedLedger(ledger: ManagedSessionLedger): Promise<void> {
		this.ledgers.delete(ledger.piSessionKey);
		this.ledgersByAgyId.delete(ledger.agySessionId);

		for (const [, parked] of ledger.parkedCalls) {
			parked.settle({
				isError: true,
				content: [{ type: "text", text: "Session reset" }],
			});
		}
		ledger.parkedCalls.clear();
		ledger.detachedCallIds.clear();
		ledger.activePump = undefined;
		ledger.inFlightPrompt = undefined;

		if (ledger.mcpToken) {
			this.httpMcpBridge.unregisterSessionBinding(ledger.mcpToken);
		}
		this.mirrorBroker.abortSessionCalls(ledger.agySessionId, "Session reset");
		await this.processManager.evict(ledger.conn);
	}

	/** Pi `registerProvider` 核心流式入口 */
	streamSimple(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const writer = new StepStreamWriter(model, {
			thinkingLevel: options?.reasoning,
		});

		const signal = options?.signal;
		if (signal?.aborted) {
			this.cancelActiveTurnForPiSession(options?.sessionId);
			writer.fail("aborted", "Request aborted by user");
			return writer.stream;
		}

		const onImmediateAbort = () => {
			this.cancelActiveTurnForPiSession(options?.sessionId);
			if (!writer.isTerminated) {
				writer.fail("aborted", "Request aborted by user");
			}
		};
		signal?.addEventListener("abort", onImmediateAbort, { once: true });

		void this.runStreamStep(writer, model, context, options)
			.catch((error) => {
				if (!writer.isTerminated) {
					const isAborted = Boolean(signal?.aborted);
					const msg = error instanceof Error ? error.message : String(error);
					writer.fail(isAborted ? "aborted" : "error", msg);
				}
			})
			.finally(() => {
				signal?.removeEventListener("abort", onImmediateAbort);
			});

		return writer.stream;
	}

	async dispose(): Promise<void> {
		for (const ledger of Array.from(this.ledgers.values())) {
			await this.teardownLedger(ledger);
		}
		this.ledgers.clear();
		this.ledgersByAgyId.clear();
		await this.httpMcpBridge.dispose();
		await this.processManager.disposeAll();
	}

	/** 借用带回放监听器的临时监听通道（供 `/agy sessions` 的 `session/load` 使用） */
	registerAuxiliaryUpdateListener(
		agySessionId: string,
		listener: (update: AcpSessionUpdatePayload) => void,
	): () => void {
		this.auxUpdateListeners.set(agySessionId, listener);
		return () => {
			this.auxUpdateListeners.delete(agySessionId);
		};
	}

	private resolveCurrentPiSessionKey(explicitSessionId?: string): string {
		if (explicitSessionId) return explicitSessionId;
		try {
			const sm = this.activeContext?.sessionManager;
			const id = sm?.getSessionId?.();
			if (id) return id;
		} catch {
			// 忽略
		}
		return DEFAULT_SESSION_KEY;
	}

	private handleSessionUpdate(notification: AcpSessionUpdateNotification): void {
		const { sessionId, update } = notification;
		this.updateTrace.record(notification, Boolean(this.ledgersByAgyId.get(sessionId)?.activePump));

		const auxListener = this.auxUpdateListeners.get(sessionId);
		if (auxListener) {
			auxListener(update);
			return;
		}

		const ledger = this.ledgersByAgyId.get(sessionId);
		if (!ledger) return;

		if (update.sessionUpdate === "usage_update") {
			if (typeof update.used === "number") {
				if (
					typeof ledger.usedTokens === "number" &&
					ledger.usedTokens > 64_000 &&
					update.used < ledger.usedTokens * 0.65
				) {
					ledger.backendCompactedRecently = true;
				}
				ledger.usedTokens = update.used;
			}
			if (typeof update.size === "number") {
				ledger.windowSize = update.size;
				const activeModel = this.activeContext?.model;
				const targetModelId =
					ledger.lastSelectedModelId ??
					(activeModel?.provider === ANTIGRAVITY_PROVIDER_ID ? activeModel.id : undefined);
				if (targetModelId) {
					recordObservedContextWindow(targetModelId, update.size);
				}
				if (
					activeModel &&
					activeModel.provider === ANTIGRAVITY_PROVIDER_ID &&
					(!ledger.lastSelectedModelId || activeModel.id === ledger.lastSelectedModelId)
				) {
					activeModel.contextWindow = update.size;
				}
			}
			updateAntigravityStatusBar(
				this.activeContext,
				this.currentConfig,
				this.getTelemetrySnapshot(ledger.piSessionKey),
			);
			return;
		}

		if (update.sessionUpdate === "session_info_update") {
			const newTitle = update.title?.trim();
			if (newTitle) {
				try {
					if (!this.pi.getSessionName()) {
						this.pi.setSessionName(newTitle);
					}
				} catch {
					// 忽略未绑定运行态
				}
			}
			return;
		}

		if (update.sessionUpdate === "config_option_update" && update.configOptions) {
			ledger.configOptions = update.configOptions;
			return;
		}

		if (
			update.sessionUpdate === "agent_thought_chunk" ||
			update.sessionUpdate === "agent_message_chunk"
		) {
			// 在推入队列的同时立即结算仍未显式上报 completed 的挂起镜像工具，消除队列尚未被下一轮消费时的死锁窗口
			this.mirrorBroker.completePendingCallsImplicitly(sessionId);
			ledger.activePump?.queue.push({ kind: "acp_update", update });
			return;
		}

		// 处理工具调用事件路由：优先依据真实 `update.name` 精准区分宿主 MCP 工具前置宣告与 AGY 原生工具调用
		if (update.sessionUpdate === "tool_call") {
			const isHostMcpAnnouncement = this.isHostMcpToolEvent(ledger, update.title, update.name);
			if (isHostMcpAnnouncement) {
				ledger.hostMcpAnnouncementIds.add(update.toolCallId);
				this.httpMcpBridge.recordAcpToolAnnouncement(
					sessionId,
					update.name || update.title || "",
				);
				if (ledger.activePump && !ledger.activePump.finished) {
					ledger.activePump.pendingAnnouncedMcpCount++;
				}
				return;
			}

			if (ledger.toolMode === "pi-tools") {
				// 忽略 pi-tools 模式下非宿主 MCP 的后端内部自执行工具事件，避免污染门控计数或派发未激活的镜像工具
				return;
			}

			// 模式 A / Hybrid 下的 AGY 原生工具调用
			ledger.activePump?.queue.push({ kind: "acp_update", update });
			return;
		}

		if (update.sessionUpdate === "tool_call_update") {
			const isHostMcp =
				ledger.hostMcpAnnouncementIds.has(update.toolCallId) ||
				this.isHostMcpToolEvent(ledger, update.title, update.name);
			// Outside a Pi turn (agy woke up on its own) no mirror tool waits for the
			// update; registering it would only leave an orphaned entry behind.
			const awaited = Boolean(ledger.activePump) || this.mirrorBroker.isTracking(update.toolCallId);
			if (!isHostMcp && ledger.toolMode !== "pi-tools" && awaited) {
				this.mirrorBroker.registerOrUpdateCall(sessionId, update);
			}
			return;
		}

		ledger.activePump?.queue.push({ kind: "acp_update", update });
	}

	private getSafeRegisteredTools(): Array<{ name: string; promptGuidelines?: readonly string[] }> {
		try {
			return this.pi.getAllTools();
		} catch {
			return [];
		}
	}

	private computeCustomizationMount(messages: readonly Message[], cwd: string) {
		return prepareCustomizationMount(messages as Message[], this.currentConfig, cwd, process.env, {
			registeredTools: this.getSafeRegisteredTools(),
		});
	}

	private isHostMcpToolEvent(
		ledger: ManagedSessionLedger,
		rawTitle: string | undefined,
		rawName?: string,
	): boolean {
		if (ledger.hostMcpTools.length === 0) {
			return false;
		}
		if (rawName && rawName.trim().length > 0) {
			const lowerName = rawName.trim().toLowerCase();
			if (lowerName.startsWith("mcp_pi_tools_")) {
				return true;
			}
			if (
				ledger.hostMcpTools.some(
					(t) =>
						lowerName === t.name.toLowerCase() ||
						lowerName === toExposedMcpToolName(t.name).toLowerCase(),
				)
			) {
				return true;
			}
			// 若服务端已提供明确的非宿主原生工具名（如 read_file / list_resources），不再按 title 子串模糊匹配，防止误吞或门控泄漏
			return false;
		}
		if (!rawTitle) {
			return false;
		}
		const lower = rawTitle.trim().toLowerCase();
		if (lower.includes("mcp_pi_tools_")) {
			return true;
		}
		return ledger.hostMcpTools.some(
			(t) =>
				lower === t.name.toLowerCase() ||
				lower === toExposedMcpToolName(t.name).toLowerCase(),
		);
	}

	private async runStreamStep(
		writer: StepStreamWriter,
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): Promise<void> {
		const piSessionKey = this.resolveCurrentPiSessionKey(options?.sessionId);
		const primaryLedger = this.ledgers.get(piSessionKey);
		const hasBusyPrimary = Boolean(
			primaryLedger && (primaryLedger.activePump || primaryLedger.parkedCalls.size > 0),
		);

		// Thin-client policy: interactive sessions only, no auxiliary requests.
		if (!this.activeContext?.hasUI) {
			throw new ThinClientPolicyError(HEADLESS_REFUSED);
		}
		// Pi's agent loop always declares the active (mirror) tools and keeps prompt
		// caching on; one-off requests from compaction or extensions usually do neither.
		if (
			isAuxiliarySingleTurnRequest(context, options, hasBusyPrimary) ||
			getCurrentTools(context.messages).length === 0 ||
			options?.cacheRetention === "none" ||
			SUMMARY_SYSTEM_HINT_PATTERN.test(getCurrentSystemPrompt(context.messages) ?? "")
		) {
			throw new ThinClientPolicyError(AUXILIARY_REFUSED);
		}

		const cwd = this.activeContext?.cwd ?? process.cwd();
		const isProjectTrusted = this.activeContext?.isProjectTrusted?.() ?? false;
		const declaredTools = getCurrentTools(context.messages);
		const hostMcpTools = filterToolsForHostMcpBridge(declaredTools, this.currentConfig);
		const toolsDigest = computeToolsFingerprint(hostMcpTools);
		const visibleMessages = extractVisibleMessages(context.messages);

		// Thin-client policy: no automated loops. Before any session work, every new
		// user message must be typed by the human and not sent before; without one,
		// only the continuation of a running agy turn (tool results) may pass.
		const continuesActiveTurn = Boolean(
			primaryLedger &&
				primaryLedger.conn.isAlive &&
				primaryLedger.toolMode === this.currentConfig.toolMode &&
				(primaryLedger.activePump ||
					primaryLedger.parkedCalls.size > 0 ||
					primaryLedger.detachedCallIds.size > 0),
		);
		this.humanPromptGate.authorize(trailingUserMessages(visibleMessages), continuesActiveTurn);

		// 2. 优先检查活跃轮次续接（2a / 2b）：不因中途编辑 AGENTS.md / SKILL.md 改变 mountDigest 而跳过挂起结算导致死锁，
		// 将规则挂载变更延后至下一新轮次生效。
		const existing = this.ledgers.get(piSessionKey);
		if (
			existing &&
			existing.conn.isAlive &&
			existing.toolMode === this.currentConfig.toolMode
		) {
			// 2a. 模式 B / Hybrid：结算挂起中的 Parked MCP 工具调用
			if (existing.parkedCalls.size > 0 || existing.detachedCallIds.size > 0) {
				await this.continueFromParkedOrDetachedToolResults(
					existing,
					writer,
					model,
					context.messages,
					visibleMessages,
					hostMcpTools,
					toolsDigest,
					options,
				);
				return;
			}

			// 2b. 模式 A / Hybrid：镜像工具执行完毕，若用户在工具运行期间按下 Enter 发送了转向消息（steer），
			// 立即在当前工具边界无损收口后台循环并以真实用户身份切入同一会话；否则无缝续接后台同一活跃 ACP Turn 队列。
			if (existing.activePump) {
				const { trailingUsers } = this.collectRecentToolResultsAndSteeringUsers(visibleMessages);
				if (trailingUsers.length > 0) {
					this.abortLedgerTurnNonBlocking(existing);
					const idleOk = await this.waitForInFlightPrompt(existing, 2_500, options?.signal);
					if (!idleOk) {
						if (options?.signal?.aborted) {
							writer.fail("aborted", "Request aborted by user");
							return;
						}
						await this.discardWedgedLedger(existing);
						// 驱逐后直接跳至第 3 步重建，绝不穿透落入 2c 对已销毁 ledger 执行操作
					} else {
						existing.lastConsumedStepIdx = Math.max(
							existing.lastConsumedStepIdx,
							await readCurrentMaxSqliteStepIdx(this.currentConfig, existing.agySessionId),
						);
						existing.lastReportedUpstreamGenIdx = Math.max(
							existing.lastReportedUpstreamGenIdx,
							await readCurrentMaxSqliteGenIdx(this.currentConfig, existing.agySessionId),
						);
						this.httpMcpBridge.clearSessionCancelled(existing.agySessionId);
						await this.executePromptOnLedger(
							existing,
							convertUserMessagesToPromptBlocks(trailingUsers),
							visibleMessages,
							writer,
							model,
							options,
						);
						return;
					}
				} else {
					const currentProjection = inspectTrafficOptProjectionState(visibleMessages);
					existing.activePump.lastStepProjectionSynced =
						currentProjection.projectionDigest === existing.syncedProjectionDigest;
					existing.activePump.lastStepUsedSlicePool = false;
					writer.setResponseMetadata({
						responseId: existing.agySessionId,
						providerThinkingLevel: existing.appliedThoughtLevel,
					});
					writer.ensureStarted();
					await this.consumePumpForSingleStep(existing, existing.activePump, writer, model, options);
					if (!existing.activePump && existing.parkedCalls.size === 0) {
						this.recordSyncedTranscript(existing, visibleMessages, writer.message);
					}
					return;
				}
			}
		}

		// 进入新用户轮次（2c）或重建路径（3）时才计算最新规则与技能挂载指纹
		const mountInfo = this.computeCustomizationMount(context.messages, cwd);

		// 2c. 连续正常追问：先确认上一轮在途请求已完全收敛；若底层卡死则自动驱逐重建，否则直接复用会话与缓存
		let skipAnchorRestoreForProjectionSync = false;
		const idleCandidate = this.ledgers.get(piSessionKey);
		if (
			idleCandidate &&
			idleCandidate.conn.isAlive &&
			idleCandidate.toolMode === this.currentConfig.toolMode &&
			idleCandidate.mountDigest === mountInfo.mountDigest
		) {
			const idleOk = await this.waitForInFlightPrompt(idleCandidate, 2_500, options?.signal);
			if (!idleOk) {
				if (options?.signal?.aborted) {
					writer.fail("aborted", "Request aborted by user");
					return;
				}
				await this.discardWedgedLedger(idleCandidate);
			} else {
				const continuationPrompts = this.tryExtractIncrementalUserPrompts(
					idleCandidate,
					visibleMessages,
				);
				if (continuationPrompts) {
					const prefixProjection = inspectTrafficOptProjectionState(
						visibleMessages.slice(0, idleCandidate.syncedMessageCount),
					);
					if (
						shouldRebuildForProjectionSync(
							idleCandidate.syncedProjectionDigest,
							idleCandidate.syncedProjectedCount,
							prefixProjection,
							idleCandidate.usedTokens,
						)
					) {
						// pi-traffic-optimization 触发批量 GC（或用户关闭优化恢复原文）：在空闲轮次边界重建瘦身/还原后的新 AGY 会话
						skipAnchorRestoreForProjectionSync = true;
					} else if (exceedsSafeSingleStepBudget(continuationPrompts)) {
						// 热会话中单次追问本身超过单步 64k 安全线：只读分叉并预注入前序分片后无缝续接，失败则落入路径 3 全量预注入重建
						const toolsReady =
							idleCandidate.toolsDigest === toolsDigest ||
							(await this.syncLedgerToolsBetweenTurns(
								idleCandidate,
								hostMcpTools,
								toolsDigest,
								options?.signal,
							));
						if (toolsReady) {
							const preloadedBlocks = await this.tryPreloadOversizedContinuationOnLedger(
								idleCandidate,
								continuationPrompts,
								options?.signal,
							);
							if (preloadedBlocks) {
								await this.executePromptOnLedger(
									idleCandidate,
									preloadedBlocks,
									visibleMessages,
									writer,
									model,
									options,
								);
								return;
							}
						}
					} else if (idleCandidate.toolsDigest === toolsDigest) {
						await this.executePromptOnLedger(
							idleCandidate,
							continuationPrompts,
							visibleMessages,
							writer,
							model,
							options,
						);
						return;
					} else {
						// 跨轮次仅动态工具集合变化：优先通过活跃 SSE 或原地 session/resume 重拉 tools/list，零历史丢失
						const syncedTools = await this.syncLedgerToolsBetweenTurns(
							idleCandidate,
							hostMcpTools,
							toolsDigest,
							options?.signal,
						);
						if (syncedTools) {
							await this.executePromptOnLedger(
								idleCandidate,
								continuationPrompts,
								visibleMessages,
								writer,
								model,
								options,
							);
							return;
						}
					}
				}
			}
		}

		// 3. 会话不存在、工具集/模式变更、归档投影瘦身或历史分支偏离：安全拆解旧会话并按三级状态机重建/恢复
		const stillExisting = this.ledgers.get(piSessionKey);
		if (stillExisting) {
			const settled = await this.waitForInFlightPrompt(stillExisting, 1_500, options?.signal);
			if (!settled) {
				await this.discardWedgedLedger(stillExisting);
			} else {
				await this.teardownLedger(stillExisting);
			}
		}

		const { ledger, initialPromptBlocks } = await this.bootstrapOrRestoreLedger({
			piSessionKey,
			cwd,
			isProjectTrusted,
			visibleMessages,
			hostMcpTools,
			toolsDigest,
			mountedPluginPaths: mountInfo.mountedPluginPaths,
			mountDigest: mountInfo.mountDigest,
			additionalDirectories: mountInfo.additionalDirectories,
			workspaceContextBlock: mountInfo.workspaceContextBlock,
			modelContextWindow: model.contextWindow,
			skipAnchorRestore: skipAnchorRestoreForProjectionSync,
			signal: options?.signal,
		});

		await this.executePromptOnLedger(
			ledger,
			initialPromptBlocks,
			visibleMessages,
			writer,
			model,
			options,
		);
	}

	private tryExtractIncrementalUserPrompts(
		ledger: ManagedSessionLedger,
		visibleMessages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
	): AcpPromptBlock[] | undefined {
		if (visibleMessages.length <= ledger.syncedMessageCount) {
			return undefined;
		}
		const prefix = visibleMessages.slice(0, ledger.syncedMessageCount);
		if (computeTranscriptDigest(prefix) !== ledger.syncedTranscriptDigest) {
			return undefined;
		}
		const delta = visibleMessages.slice(ledger.syncedMessageCount);
		if (delta.every((m): m is UserMessage => m.role === "user")) {
			const blocks = convertUserMessagesToPromptBlocks(delta);
			return blocks.length > 0 ? blocks : undefined;
		}

		// 若增量片段中仅包含因按 Esc 中断或报错失败的未完结轮次（无任何已执行工具结果），
		// 跳过失败片段仅提取末尾新增用户消息，在同一热缓存会话上无损续接，避免误拆长会话退化为截断重放。
		if (delta.some((m) => m.role === "toolResult")) {
			return undefined;
		}
		let lastFailedAssistantIdx = -1;
		for (let i = 0; i < delta.length; i++) {
			const m = delta[i];
			if (m.role === "assistant") {
				if (m.stopReason !== "aborted" && m.stopReason !== "error") {
					return undefined;
				}
				lastFailedAssistantIdx = i;
			}
		}
		if (lastFailedAssistantIdx === -1 || lastFailedAssistantIdx >= delta.length - 1) {
			return undefined;
		}
		const trailingUsers = delta.slice(lastFailedAssistantIdx + 1);
		if (!trailingUsers.every((m): m is UserMessage => m.role === "user")) {
			return undefined;
		}
		const blocks = convertUserMessagesToPromptBlocks(trailingUsers);
		return blocks.length > 0 ? blocks : undefined;
	}

	/** 构造当前会话所需的 ACP `mcpServers` 列表（供初次建连与原地 `session/resume` 工具热重载复用） */
	private async buildSessionMcpServersSpec(params: {
		mcpToken?: string;
		useHttpMcp: boolean;
		cwd: string;
		isProjectTrusted: boolean;
	}): Promise<AcpMcpServerSpec[]> {
		const mcpServers: AcpMcpServerSpec[] = [];
		if (params.mcpToken) {
			mcpServers.push(
				await this.httpMcpBridge.buildAcpMcpServerSpec(params.mcpToken, params.useHttpMcp),
			);
		}
		const effectiveFlags = resolveEffectiveFlags(this.currentConfig);
		if (
			effectiveFlags.toolMode !== "pi-tools" &&
			effectiveFlags.bridgePiMcp &&
			this.currentConfig.piMcpBridgeStrategy === "direct-config"
		) {
			mcpServers.push(
				...loadDirectPiMcpServerSpecs({
					cwd: params.cwd,
					isProjectTrusted: params.isProjectTrusted,
					processPerSession: params.useHttpMcp,
				}),
			);
		}
		return mcpServers;
	}

	/**
	 * 通过「官方 `session/new` 建空模板 -> `session/close` -> `VACUUM INTO` 克隆新 UUID 并写入预注入步 -> `session/resume`」
	 * 创建带有完整 `trajectory_metadata_blob`（包含 `pi-bridge` 等 Agent 规格、挂载插件与工作区配置）的多步预注入会话。
	 * 任意环节失败时立即清理模板与临时副本并返回 `undefined`，由调用方安全降级至单步重放，绝不生成无 Agent 规格的裸库。
	 */
	private async createPreloadedSessionFromTemplate(params: {
		conn: AcpClientConnection;
		cwd: string;
		mcpServers: AcpMcpServerSpec[];
		additionalDirectories?: string[];
		preloadedTurns: readonly PreloadedSqliteTurn[];
		signal?: AbortSignal;
	}): Promise<AcpSessionResumeResult | undefined> {
		if (
			params.preloadedTurns.length === 0 ||
			!this.currentConfig.enableSqliteFork ||
			!params.conn.capabilities?.sessionCapabilities?.resume
		) {
			return undefined;
		}

		let templateSessionId: string | undefined;
		let clonedSessionId: string | undefined;
		try {
			const templateRes = await params.conn.request<AcpSessionNewResult>(
				"session/new",
				{
					cwd: params.cwd,
					mcpServers: [],
					additionalDirectories: params.additionalDirectories,
				},
				{ timeoutMs: 20_000, signal: params.signal },
			);
			const createdTemplateId = templateRes.sessionId;
			if (!createdTemplateId) {
				return undefined;
			}
			templateSessionId = createdTemplateId;
			await params.conn.closeSessionSafe(createdTemplateId);

			clonedSessionId = await cloneTemplateSqliteConversationWithPreload(
				this.currentConfig,
				createdTemplateId,
				params.preloadedTurns,
				{ signal: params.signal },
			);
			if (!clonedSessionId) {
				return undefined;
			}

			return await params.conn.request<AcpSessionResumeResult>(
				"session/resume",
				{
					sessionId: clonedSessionId,
					cwd: params.cwd,
					mcpServers: params.mcpServers,
					additionalDirectories: params.additionalDirectories,
				},
				{ timeoutMs: 25_000, signal: params.signal },
			);
		} catch (error) {
			if (clonedSessionId) {
				removeEmptyProbeSessionFiles(this.currentConfig, clonedSessionId);
			}
			if (params.signal?.aborted) {
				throw error;
			}
			return undefined;
		} finally {
			if (templateSessionId) {
				removeEmptyProbeSessionFiles(this.currentConfig, templateSessionId);
			}
		}
	}

	/**
	 * 热会话中遇到单条追问超过单步 64k 安全预算时，严格遵循只读原库原则：
	 * 通过 `VACUUM INTO` 克隆当前会话快照至新 UUID `.db`，追加前 N-1 个安全文本分片后切换 `session/resume`，
	 * 返回仅包含最后 1 片（及原图）的安全 `finalPromptBlocks`。若不可行则返回 `undefined` 交由上层重建兜底。
	 */
	private async tryPreloadOversizedContinuationOnLedger(
		ledger: ManagedSessionLedger,
		continuationPrompts: readonly AcpPromptBlock[],
		signal?: AbortSignal,
	): Promise<AcpPromptBlock[] | undefined> {
		if (
			!this.currentConfig.enableSqliteFork ||
			!ledger.conn.isAlive ||
			!ledger.conn.capabilities?.sessionCapabilities?.resume ||
			!hasLocalConversationDb(this.currentConfig, ledger.agySessionId)
		) {
			return undefined;
		}
		const plan = buildPromptBlocksPreloadPlan(continuationPrompts, {
			segmentLabel: "user-message-part",
		});
		if (plan.preloadedTurns.length === 0) {
			return plan.finalPromptBlocks;
		}

		const ckpt = await captureSqliteCheckpoint(this.currentConfig, ledger.agySessionId);
		if (!ckpt) {
			return undefined;
		}
		const forkedId = await forkSqliteConversationAtCheckpoint(
			this.currentConfig,
			ledger.agySessionId,
			ckpt,
		);
		if (!forkedId) {
			return undefined;
		}

		const appended = await appendPreloadedTurnsToSqliteConversation(
			this.currentConfig,
			forkedId,
			plan.preloadedTurns,
		);
		if (!appended) {
			removeEmptyProbeSessionFiles(this.currentConfig, forkedId);
			return undefined;
		}

		const mcpServers = await this.buildSessionMcpServersSpec({
			mcpToken: ledger.mcpToken,
			useHttpMcp: ledger.useHttpMcp,
			cwd: ledger.cwd,
			isProjectTrusted: ledger.isProjectTrusted,
		});
		const addDirs =
			ledger.additionalDirectories.length > 0 ? ledger.additionalDirectories : undefined;
		const previousSessionId = ledger.agySessionId;

		try {
			await ledger.conn.closeSessionSafe(previousSessionId);
			const resumed = await ledger.conn.request<AcpSessionResumeResult>(
				"session/resume",
				{
					sessionId: forkedId,
					cwd: ledger.cwd,
					mcpServers,
					additionalDirectories: addDirs,
				},
				{ timeoutMs: 25_000, signal },
			);
			ledger.conn.trackSession(resumed.sessionId);
			this.ledgersByAgyId.delete(previousSessionId);
			ledger.agySessionId = resumed.sessionId;
			this.ledgersByAgyId.set(resumed.sessionId, ledger);
			if (ledger.mcpToken) {
				this.httpMcpBridge.updateBindingSessionId(ledger.mcpToken, resumed.sessionId);
			}
			if (resumed.configOptions) {
				ledger.configOptions = resumed.configOptions;
			}
			if (resumed.models?.availableModels) {
				ledger.availableModels = resumed.models.availableModels;
			}
			ledger.appliedModelValue = undefined;
			ledger.appliedThoughtLevel = undefined;
			ledger.appliedExecMode = undefined;
			ledger.lastConsumedStepIdx = await readCurrentMaxSqliteStepIdx(
				this.currentConfig,
				resumed.sessionId,
			);
			ledger.lastReportedUpstreamGenIdx = await readCurrentMaxSqliteGenIdx(
				this.currentConfig,
				resumed.sessionId,
			);
			ledger.pendingPreloadedTurns = plan.preloadedTurns;
			return plan.finalPromptBlocks;
		} catch {
			removeEmptyProbeSessionFiles(this.currentConfig, forkedId);
			return undefined;
		}
	}

	/**
	 * 确保工具边界切入或迟到补发的提示词块严守 `agy` 单步 64k 安全预算：
	 * 预算内零开销原样直发；超预算时优先通过只读 SQLite 分叉预注入前序分片，不可用时平滑回退单步安全分片。
	 */
	private async resolveSafeContinuationBlocksOnLedger(
		ledger: ManagedSessionLedger,
		blocks: readonly AcpPromptBlock[],
		signal?: AbortSignal,
	): Promise<AcpPromptBlock[]> {
		if (!exceedsSafeSingleStepBudget(blocks)) {
			return [...blocks];
		}
		const preloaded = await this.tryPreloadOversizedContinuationOnLedger(ledger, blocks, signal);
		if (preloaded) {
			return preloaded;
		}
		return buildPromptBlocksPreloadPlan(blocks).singleStepFallbackBlocks;
	}

	private async reloadLedgerSessionForTools(
		ledger: ManagedSessionLedger,
		hostMcpTools: Tool[],
		toolsDigest: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (
			!ledger.conn.isAlive ||
			!ledger.conn.capabilities?.sessionCapabilities?.resume ||
			!hasLocalConversationDb(this.currentConfig, ledger.agySessionId)
		) {
			return false;
		}

		if (ledger.mcpToken) {
			this.httpMcpBridge.updateBindingTools(ledger.mcpToken, hostMcpTools);
		} else if (hostMcpTools.length > 0) {
			// 原会话无 MCP 通道（例如 agy-tools 原本零 MCP 工具，后新增 MCP 工具）时由上层重建
			return false;
		}

		const mcpServers = await this.buildSessionMcpServersSpec({
			mcpToken: ledger.mcpToken,
			useHttpMcp: ledger.useHttpMcp,
			cwd: ledger.cwd,
			isProjectTrusted: ledger.isProjectTrusted,
		});
		const addDirs =
			ledger.additionalDirectories.length > 0 ? ledger.additionalDirectories : undefined;

		try {
			await ledger.conn.closeSessionSafe(ledger.agySessionId);
			const resumed = await ledger.conn.request<AcpSessionResumeResult>(
				"session/resume",
				{
					sessionId: ledger.agySessionId,
					cwd: ledger.cwd,
					mcpServers,
					additionalDirectories: addDirs,
				},
				{ timeoutMs: 20_000, signal },
			);
			ledger.conn.trackSession(resumed.sessionId);
			if (resumed.configOptions) {
				ledger.configOptions = resumed.configOptions;
			}
			if (resumed.models?.availableModels) {
				ledger.availableModels = resumed.models.availableModels;
			}
			ledger.appliedModelValue = undefined;
			ledger.appliedThoughtLevel = undefined;
			ledger.appliedExecMode = undefined;
			ledger.hostMcpTools = hostMcpTools;
			ledger.toolsDigest = toolsDigest;
			ledger.lastConsumedStepIdx = Math.max(
				ledger.lastConsumedStepIdx,
				await readCurrentMaxSqliteStepIdx(this.currentConfig, ledger.agySessionId),
			);
			return true;
		} catch {
			return false;
		}
	}

	private async syncLedgerToolsBetweenTurns(
		ledger: ManagedSessionLedger,
		hostMcpTools: Tool[],
		toolsDigest: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (ledger.mcpToken) {
			const deliveredViaSse = this.httpMcpBridge.updateBindingTools(
				ledger.mcpToken,
				hostMcpTools,
			);
			if (deliveredViaSse) {
				ledger.hostMcpTools = hostMcpTools;
				ledger.toolsDigest = toolsDigest;
				return true;
			}
		}
		return this.reloadLedgerSessionForTools(ledger, hostMcpTools, toolsDigest, signal);
	}

	private collectRecentToolResultsAndSteeringUsers(
		visibleMessages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
	): { recentToolResults: Map<string, ToolResultMessage>; trailingUsers: UserMessage[] } {
		const recentToolResults = new Map<string, ToolResultMessage>();
		const trailingUsers: UserMessage[] = [];
		for (let i = visibleMessages.length - 1; i >= 0; i--) {
			const msg = visibleMessages[i];
			if (msg.role === "toolResult") {
				recentToolResults.set(msg.toolCallId, msg);
			} else if (msg.role === "user" && recentToolResults.size === 0) {
				trailingUsers.unshift(msg);
			} else if (msg.role === "assistant") {
				break;
			}
		}
		return { recentToolResults, trailingUsers };
	}

	private async continueFromParkedOrDetachedToolResults(
		ledger: ManagedSessionLedger,
		writer: StepStreamWriter,
		model: Model<Api>,
		fullContextMessages: readonly Message[],
		visibleMessages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
		hostMcpTools: Tool[],
		toolsDigest: string,
		options?: SimpleStreamOptions,
	): Promise<void> {
		// 更新动态工具表（例如上一轮刚执行了 tool_search 激活了新工具）；
		// 仅在存在活跃 SSE 客户端即时送达变更时更新 ledger.toolsDigest；否则在无 SSE 通道下通过原地 session/resume 重拉 tools/list。
		let needsMidTurnToolsReload = false;
		if (ledger.mcpToken && ledger.toolsDigest !== toolsDigest) {
			const deliveredViaSse = this.httpMcpBridge.updateBindingTools(ledger.mcpToken, hostMcpTools);
			if (deliveredViaSse) {
				ledger.hostMcpTools = hostMcpTools;
				ledger.toolsDigest = toolsDigest;
			} else {
				needsMidTurnToolsReload = true;
			}
		}

		// 从末尾收集本轮产生的 ToolResultMessage 与可能夹带的 Steering UserMessage
		const { recentToolResults, trailingUsers } =
			this.collectRecentToolResultsAndSteeringUsers(visibleMessages);

		// 分支 A：若存在因超过 165 秒守护阈值已剥离的调用，等待在途取消收敛后通过新 session/prompt 补发迟到结果
		if (ledger.detachedCallIds.size > 0) {
			const detachedResults: ToolResultMessage[] = [];
			for (const msg of visibleMessages) {
				if (msg.role === "toolResult" && ledger.detachedCallIds.has(msg.toolCallId)) {
					detachedResults.push(msg);
				}
			}
			for (const callId of ledger.detachedCallIds) {
				const parked = ledger.parkedCalls.get(callId);
				parked?.settle({
					isError: true,
					content: [{ type: "text", text: "Detached" }],
				});
				ledger.parkedCalls.delete(callId);
			}
			ledger.detachedCallIds.clear();
			ledger.activePump = undefined;

			const idleOk = await this.waitForInFlightPrompt(ledger, 2_500, options?.signal);
			if (!idleOk) {
				if (options?.signal?.aborted) {
					writer.fail("aborted", "Request aborted by user");
					return;
				}
				await this.discardWedgedLedger(ledger);
				const cwd = this.activeContext?.cwd ?? process.cwd();
				const isProjectTrusted = this.activeContext?.isProjectTrusted?.() ?? false;
				const mountInfo = this.computeCustomizationMount(fullContextMessages, cwd);
				const restored = await this.bootstrapOrRestoreLedger({
					piSessionKey: ledger.piSessionKey,
					cwd,
					isProjectTrusted,
					visibleMessages,
					hostMcpTools,
					toolsDigest,
					mountedPluginPaths: mountInfo.mountedPluginPaths,
					mountDigest: mountInfo.mountDigest,
					additionalDirectories: mountInfo.additionalDirectories,
					workspaceContextBlock: mountInfo.workspaceContextBlock,
					modelContextWindow: model.contextWindow,
					signal: options?.signal,
				});
				await this.executePromptOnLedger(
					restored.ledger,
					restored.initialPromptBlocks,
					visibleMessages,
					writer,
					model,
					options,
				);
				return;
			}

			this.httpMcpBridge.clearSessionCancelled(ledger.agySessionId);

			if (detachedResults.length > 0) {
				const rawLateBlocks = buildDetachedToolResultBlocks(detachedResults, trailingUsers);
				const safeLateBlocks = await this.resolveSafeContinuationBlocksOnLedger(
					ledger,
					rawLateBlocks,
					options?.signal,
				);
				await this.executePromptOnLedger(
					ledger,
					safeLateBlocks,
					visibleMessages,
					writer,
					model,
					options,
				);
				return;
			}

			const lateFallbackBlocks = buildFreshReplayPlan({
				visibleMessages,
				maxContextWindowTokens: model.contextWindow,
			}).singleStepFallbackBlocks;

			await this.executePromptOnLedger(
				ledger,
				lateFallbackBlocks,
				visibleMessages,
				writer,
				model,
				options,
			);
			return;
		}

		// 分支 B：165 秒内正常完成，直接结算已发给 Pi 的挂起 HTTP MCP 请求并继续消费同一活跃 ACP Turn
		const pump = ledger.activePump;
		if (!pump) {
			for (const [, parked] of ledger.parkedCalls) {
				parked.settle({
					isError: true,
					content: [{ type: "text", text: "Turn ended" }],
				});
			}
			ledger.parkedCalls.clear();
			const idleOk = await this.waitForInFlightPrompt(ledger, 2_000, options?.signal);
			if (!idleOk) {
				if (options?.signal?.aborted) {
					writer.fail("aborted", "Request aborted by user");
					return;
				}
				await this.discardWedgedLedger(ledger);
				const cwd = this.activeContext?.cwd ?? process.cwd();
				const isProjectTrusted = this.activeContext?.isProjectTrusted?.() ?? false;
				const mountInfo = this.computeCustomizationMount(fullContextMessages, cwd);
				const restored = await this.bootstrapOrRestoreLedger({
					piSessionKey: ledger.piSessionKey,
					cwd,
					isProjectTrusted,
					visibleMessages,
					hostMcpTools,
					toolsDigest,
					mountedPluginPaths: mountInfo.mountedPluginPaths,
					mountDigest: mountInfo.mountDigest,
					additionalDirectories: mountInfo.additionalDirectories,
					workspaceContextBlock: mountInfo.workspaceContextBlock,
					modelContextWindow: model.contextWindow,
					signal: options?.signal,
				});
				await this.executePromptOnLedger(
					restored.ledger,
					restored.initialPromptBlocks,
					visibleMessages,
					writer,
					model,
					options,
				);
				return;
			}
			const fallbackPlan = buildFreshReplayPlan({
				visibleMessages,
				maxContextWindowTokens: model.contextWindow,
			});
			if (fallbackPlan.preloadedTurns.length > 0) {
				await this.teardownLedger(ledger);
				const cwd = this.activeContext?.cwd ?? process.cwd();
				const isProjectTrusted = this.activeContext?.isProjectTrusted?.() ?? false;
				const mountInfo = this.computeCustomizationMount(fullContextMessages, cwd);
				const restored = await this.bootstrapOrRestoreLedger({
					piSessionKey: ledger.piSessionKey,
					cwd,
					isProjectTrusted,
					visibleMessages,
					hostMcpTools,
					toolsDigest,
					mountedPluginPaths: mountInfo.mountedPluginPaths,
					mountDigest: mountInfo.mountDigest,
					additionalDirectories: mountInfo.additionalDirectories,
					workspaceContextBlock: mountInfo.workspaceContextBlock,
					modelContextWindow: model.contextWindow,
					signal: options?.signal,
				});
				await this.executePromptOnLedger(
					restored.ledger,
					restored.initialPromptBlocks,
					visibleMessages,
					writer,
					model,
					options,
				);
				return;
			}
			await this.executePromptOnLedger(
				ledger,
				fallbackPlan.finalPromptBlocks,
				visibleMessages,
				writer,
				model,
				options,
			);
			return;
		}

		// 仅结算已发给 Pi 执行的工具调用，保留仍在队列中等待下一步发出的并发/顺序后续请求
		const entriesToSettle = Array.from(ledger.parkedCalls.entries()).filter(
			([callId]) => pump.emittedMcpCallIds.has(callId) || recentToolResults.has(callId),
		);
		const settlingIdSet = new Set(entriesToSettle.map(([callId]) => callId));
		const hasRemainingParkedCalls =
			Array.from(ledger.parkedCalls.keys()).some((id) => !settlingIdSet.has(id)) ||
			pump.queue.some((item) => item.kind === "mcp_parked" && !settlingIdSet.has(item.call.callId));

		// 检测本次结算的宿主 MCP 工具结果是否包含超过 agy 10KB 内联上限的图片，若是则将大图延迟至同会话 session/prompt 投递
		const settlePayloads: Array<{
			callId: string;
			parked: ParkedToolCall;
			content: Array<TextContent | ImageContent>;
			isError: boolean;
		}> = [];
		let hasDeferredImagesInSettledBatch = false;
		let hasDeferredTextsInSettledBatch = false;
		for (const [callId, parked] of entriesToSettle) {
			const tr = recentToolResults.get(callId);
			if (!tr) {
				settlePayloads.push({
					callId,
					parked,
					content: [{ type: "text", text: "(tool call skipped)" }],
					isError: true,
				});
				continue;
			}
			const rawTextBlocks: TextContent[] = [];
			const inlineImages: ImageContent[] = [];
			const oversizedImages: ImageContent[] = [];
			for (const block of tr.content) {
				if (block.type === "image") {
					if (getDecodedBase64Bytes(block.data) > AGY_MCP_INLINE_IMAGE_SAFE_BYTES) {
						oversizedImages.push(block);
					} else {
						inlineImages.push(block);
					}
				} else {
					rawTextBlocks.push(block);
				}
			}

			const joinedText = rawTextBlocks.map((b) => b.text).join("\n");
			const joinedTextBytes = Buffer.byteLength(joinedText, "utf8");
			const isOversizedText = joinedTextBytes > AGY_MCP_INLINE_TEXT_SAFE_BYTES;

			const mcpContent: Array<TextContent | ImageContent> = [];
			if (isOversizedText) {
				hasDeferredTextsInSettledBatch = true;
				mcpContent.push({
					type: "text",
					text: `[Tool "${tr.toolName}" produced ${joinedTextBytes} bytes of text output; full untruncated content is delivered in the immediately following prompt block.]`,
				});
			} else {
				mcpContent.push(...rawTextBlocks);
			}
			mcpContent.push(...inlineImages);

			if (oversizedImages.length > 0) {
				hasDeferredImagesInSettledBatch = true;
				if (!isOversizedText) {
					mcpContent.push({
						type: "text",
						text: `[${oversizedImages.length} image(s) (>10KB) delivered via follow-up multimodal prompt block.]`,
					});
				}
			}

			if (isOversizedText || oversizedImages.length > 0) {
				pump.deferredMcpOutputs.push({
					toolCallId: tr.toolCallId,
					toolName: tr.toolName,
					isError: tr.isError,
					texts: isOversizedText ? rawTextBlocks.map((b) => b.text) : [],
					images: oversizedImages,
				});
			}

			settlePayloads.push({
				callId,
				parked,
				content: mcpContent,
				isError: tr.isError,
			});
		}

		// 若即将执行工具边界切入（用户 steer、无 SSE 下的动态工具重载、或同批工具已全数结算且存在超过 10KB 内联上限的文本/图片），
		// 先开启切入保护标志，防止 settle 后毫秒级冲入的同批后续 MCP 工具被挂起拖慢收口。
		const willCutInForSteer = trailingUsers.length > 0;
		const willCutInForToolsReload =
			!willCutInForSteer &&
			needsMidTurnToolsReload &&
			Boolean(ledger.conn.capabilities?.sessionCapabilities?.resume) &&
			hasLocalConversationDb(this.currentConfig, ledger.agySessionId);
		const willCutInForDeferredOutputs =
			!willCutInForSteer &&
			!willCutInForToolsReload &&
			!hasRemainingParkedCalls &&
			pump.deferredMcpOutputs.length > 0;

		if (willCutInForSteer || willCutInForToolsReload || willCutInForDeferredOutputs) {
			ledger.steeringCutInPending = true;
		}

		const settledMcpIds: string[] = [];
		for (const item of settlePayloads) {
			ledger.parkedCalls.delete(item.callId);
			pump.emittedMcpCallIds.delete(item.callId);
			settledMcpIds.push(item.callId);

			item.parked.settle({
				content: item.content,
				isError: item.isError,
			});
		}

		const currentProjectionForMcp = inspectTrafficOptProjectionState(visibleMessages);
		const isMcpProjectionSynced =
			currentProjectionForMcp.projectionDigest === ledger.syncedProjectionDigest;
		const willCutInAny =
			willCutInForSteer || willCutInForToolsReload || willCutInForDeferredOutputs;
		const hasUpstreamDb = this.isLocalSqliteUpstreamLikelyAvailable(ledger.agySessionId);

		if (options?.onResponse && settledMcpIds.length > 0) {
			const responseHeaders: Record<string, string> = {
				"x-acp-session-id": ledger.agySessionId,
				"x-acp-transport": "acp-mcp-result",
				"x-acp-settled-mcp-ids": settledMcpIds.join(","),
				"x-acp-projection-synced": isMcpProjectionSynced ? "1" : "0",
			};
			if (hasDeferredImagesInSettledBatch) {
				responseHeaders["x-acp-mcp-images-deferred"] = String(AGY_MCP_INLINE_IMAGE_SAFE_BYTES);
			}
			if (hasDeferredTextsInSettledBatch) {
				responseHeaders["x-acp-mcp-text-deferred"] = String(AGY_MCP_INLINE_TEXT_SAFE_BYTES);
			}
			if (willCutInAny) {
				responseHeaders["x-acp-mcp-cutin"] = "1";
			}
			if (hasUpstreamDb) {
				responseHeaders["x-acp-upstream-pending"] = "1";
				if (!willCutInAny) {
					pump.awaitingUpstreamTelemetry = true;
				}
			}
			await options.onResponse(
				{
					status: 200,
					headers: responseHeaders,
				},
				model,
			);
		}
		pump.lastStepProjectionSynced = isMcpProjectionSynced;
		pump.lastStepUsedSlicePool = false;

		// 若用户在工具执行期间按 Enter 发送了转向消息（steer）：
		// 先等待刚结算的工具输出落盘至本地会话库，随即在当前工具边界收口后台自动循环，立即在同一热缓存会话上以真实用户身份发送转向消息！
		if (willCutInForSteer) {
			const deferredOutBlocks = buildDeferredMcpOutputPromptBlocks(
				pump.deferredMcpOutputs.splice(0),
				false,
			);
			try {
				await waitForSqliteToolStepsSettled(
					this.currentConfig,
					ledger.agySessionId,
					160,
					options?.signal,
				);
			} finally {
				ledger.steeringCutInPending = false;
			}
			this.abortLedgerTurnNonBlocking(ledger);
			const idleOk = await this.waitForInFlightPrompt(ledger, 2_500, options?.signal);
			if (!idleOk) {
				if (options?.signal?.aborted) {
					writer.fail("aborted", "Request aborted by user");
					return;
				}
				await this.discardWedgedLedger(ledger);
				const cwd = this.activeContext?.cwd ?? process.cwd();
				const isProjectTrusted = this.activeContext?.isProjectTrusted?.() ?? false;
				const mountInfo = this.computeCustomizationMount(fullContextMessages, cwd);
				const restored = await this.bootstrapOrRestoreLedger({
					piSessionKey: ledger.piSessionKey,
					cwd,
					isProjectTrusted,
					visibleMessages,
					hostMcpTools,
					toolsDigest,
					mountedPluginPaths: mountInfo.mountedPluginPaths,
					mountDigest: mountInfo.mountDigest,
					additionalDirectories: mountInfo.additionalDirectories,
					workspaceContextBlock: mountInfo.workspaceContextBlock,
					modelContextWindow: model.contextWindow,
					signal: options?.signal,
				});
				await this.executePromptOnLedger(
					restored.ledger,
					restored.initialPromptBlocks,
					visibleMessages,
					writer,
					model,
					options,
				);
				return;
			}

			await this.flushCutInCancelledUpstreamTelemetry(ledger, model, options);
			if (needsMidTurnToolsReload) {
				await this.reloadLedgerSessionForTools(ledger, hostMcpTools, toolsDigest, options?.signal);
			} else {
				ledger.lastConsumedStepIdx = Math.max(
					ledger.lastConsumedStepIdx,
					await readCurrentMaxSqliteStepIdx(this.currentConfig, ledger.agySessionId),
				);
			}
			this.httpMcpBridge.clearSessionCancelled(ledger.agySessionId);
			const steerTargetBlocks = await this.resolveSafeContinuationBlocksOnLedger(
				ledger,
				[...deferredOutBlocks, ...convertUserMessagesToPromptBlocks(trailingUsers)],
				options?.signal,
			);
			await this.executePromptOnLedger(
				ledger,
				steerTargetBlocks,
				visibleMessages,
				writer,
				model,
				options,
			);
			return;
		}

		// 默认 processPerSession: true（无 SSE 订阅）下工具集动态变化（如 tool_search 解锁新工具）：
		// 在当前工具落盘后通过原地 close + session/resume 重拉 tools/list，使模型当轮立即可见并调用新解锁工具！
		if (willCutInForToolsReload) {
			const deferredOutBlocks = buildDeferredMcpOutputPromptBlocks(
				pump.deferredMcpOutputs.splice(0),
				false,
			);
			try {
				await waitForSqliteToolStepsSettled(
					this.currentConfig,
					ledger.agySessionId,
					160,
					options?.signal,
				);
			} finally {
				ledger.steeringCutInPending = false;
			}
			this.abortLedgerTurnNonBlocking(ledger);
			const idleOk = await this.waitForInFlightPrompt(ledger, 2_500, options?.signal);
			if (idleOk) {
				await this.flushCutInCancelledUpstreamTelemetry(ledger, model, options);
				const reloaded = await this.reloadLedgerSessionForTools(
					ledger,
					hostMcpTools,
					toolsDigest,
					options?.signal,
				);
				if (reloaded) {
					this.httpMcpBridge.clearSessionCancelled(ledger.agySessionId);
					const reloadBlocks = await this.resolveSafeContinuationBlocksOnLedger(
						ledger,
						[
							...deferredOutBlocks,
							{
								type: "text",
								text: "The newly activated tools are now loaded and available. Please continue.",
							},
						],
						options?.signal,
					);
					await this.executePromptOnLedger(
						ledger,
						reloadBlocks,
						visibleMessages,
						writer,
						model,
						options,
					);
					return;
				}
			} else if (options?.signal?.aborted) {
				writer.fail("aborted", "Request aborted by user");
				return;
			}
			// 若原地重载未能收敛，直接重建会话避免悬空
			await this.discardWedgedLedger(ledger);
			const cwd = this.activeContext?.cwd ?? process.cwd();
			const isProjectTrusted = this.activeContext?.isProjectTrusted?.() ?? false;
			const mountInfo = this.computeCustomizationMount(fullContextMessages, cwd);
			const restored = await this.bootstrapOrRestoreLedger({
				piSessionKey: ledger.piSessionKey,
				cwd,
				isProjectTrusted,
				visibleMessages,
				hostMcpTools,
				toolsDigest,
				mountedPluginPaths: mountInfo.mountedPluginPaths,
				mountDigest: mountInfo.mountDigest,
				additionalDirectories: mountInfo.additionalDirectories,
				workspaceContextBlock: mountInfo.workspaceContextBlock,
				modelContextWindow: model.contextWindow,
				signal: options?.signal,
			});
			await this.executePromptOnLedger(
				restored.ledger,
				restored.initialPromptBlocks,
				visibleMessages,
				writer,
				model,
				options,
			);
			return;
		}

		// 宿主 MCP 工具返回 > 9.2KB 文本或 > 9.6KB 图片：在当前工具落盘后收口旧后台循环，在同一热缓存会话上以 session/prompt 完整投递，
		// 彻底规避 agy McpToolConfig.MaxOutputBytes (10KB) 造成的文本腰斩与图片丢弃，同时保持 100% 热前缀缓存！
		if (willCutInForDeferredOutputs) {
			const deferredOutBlocks = buildDeferredMcpOutputPromptBlocks(
				pump.deferredMcpOutputs.splice(0),
				true,
			);
			try {
				await waitForSqliteToolStepsSettled(
					this.currentConfig,
					ledger.agySessionId,
					160,
					options?.signal,
				);
			} finally {
				ledger.steeringCutInPending = false;
			}
			this.abortLedgerTurnNonBlocking(ledger);
			const idleOk = await this.waitForInFlightPrompt(ledger, 2_500, options?.signal);
			if (!idleOk) {
				if (options?.signal?.aborted) {
					writer.fail("aborted", "Request aborted by user");
					return;
				}
				await this.discardWedgedLedger(ledger);
				const cwd = this.activeContext?.cwd ?? process.cwd();
				const isProjectTrusted = this.activeContext?.isProjectTrusted?.() ?? false;
				const mountInfo = this.computeCustomizationMount(fullContextMessages, cwd);
				const restored = await this.bootstrapOrRestoreLedger({
					piSessionKey: ledger.piSessionKey,
					cwd,
					isProjectTrusted,
					visibleMessages,
					hostMcpTools,
					toolsDigest,
					mountedPluginPaths: mountInfo.mountedPluginPaths,
					mountDigest: mountInfo.mountDigest,
					additionalDirectories: mountInfo.additionalDirectories,
					workspaceContextBlock: mountInfo.workspaceContextBlock,
					modelContextWindow: model.contextWindow,
					signal: options?.signal,
				});
				await this.executePromptOnLedger(
					restored.ledger,
					restored.initialPromptBlocks,
					visibleMessages,
					writer,
					model,
					options,
				);
				return;
			}

			await this.flushCutInCancelledUpstreamTelemetry(ledger, model, options);
			ledger.lastConsumedStepIdx = Math.max(
				ledger.lastConsumedStepIdx,
				await readCurrentMaxSqliteStepIdx(this.currentConfig, ledger.agySessionId),
			);
			this.httpMcpBridge.clearSessionCancelled(ledger.agySessionId);
			const safeDeferredBlocks = await this.resolveSafeContinuationBlocksOnLedger(
				ledger,
				deferredOutBlocks,
				options?.signal,
			);
			await this.executePromptOnLedger(
				ledger,
				safeDeferredBlocks,
				visibleMessages,
				writer,
				model,
				options,
			);
			return;
		}

		writer.setResponseMetadata({
			responseId: ledger.agySessionId,
			providerThinkingLevel: ledger.appliedThoughtLevel,
		});
		writer.ensureStarted();

		await this.consumePumpForSingleStep(ledger, pump, writer, model, options);
		if (!ledger.activePump && ledger.parkedCalls.size === 0) {
			this.recordSyncedTranscript(ledger, visibleMessages, writer.message);
		}
	}

	private async bootstrapOrRestoreLedger(params: {
		piSessionKey: string;
		cwd: string;
		isProjectTrusted: boolean;
		visibleMessages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[];
		hostMcpTools: Tool[];
		toolsDigest: string;
		mountedPluginPaths: string[];
		mountDigest: string;
		additionalDirectories: string[];
		workspaceContextBlock?: string;
		modelContextWindow?: number;
		skipAnchorRestore?: boolean;
		signal?: AbortSignal;
	}): Promise<{ ledger: ManagedSessionLedger; initialPromptBlocks: AcpPromptBlock[] }> {
		const conn = await this.processManager.acquire(
			this.currentConfig,
			{ mountedPluginPaths: params.mountedPluginPaths },
			params.signal,
		);
		const useHttpMcp = Boolean(
			this.currentConfig.processPerSession && conn.capabilities?.mcpCapabilities?.http,
		);

		let mcpToken: string | undefined;
		const mcpServers: AcpMcpServerSpec[] = [];

		const ledgerDraft: Partial<ManagedSessionLedger> = {
			parkedCalls: new Map(),
			detachedCallIds: new Set(),
		};

		if (
			this.currentConfig.toolMode === "pi-tools" ||
			params.hostMcpTools.length > 0
		) {
			mcpToken = this.httpMcpBridge.registerSessionBinding({
				tools: params.hostMcpTools,
				onParkedCall: (call) => {
					const fullLedger = ledgerDraft as ManagedSessionLedger;
					if (
						fullLedger.steeringCutInPending ||
						!fullLedger.activePump ||
						fullLedger.activePump.finished
					) {
						if (fullLedger.activePump) {
							fullLedger.activePump.pendingAnnouncedMcpCount = Math.max(
								0,
								fullLedger.activePump.pendingAnnouncedMcpCount - 1,
							);
						}
						call.settle({
							isError: true,
							content: [{ type: "text", text: "Turn cancelled." }],
						});
						return;
					}
					fullLedger.parkedCalls.set(call.callId, call);
					fullLedger.activePump.pendingAnnouncedMcpCount = Math.max(
						0,
						fullLedger.activePump.pendingAnnouncedMcpCount - 1,
					);
					fullLedger.activePump.queue.push({ kind: "mcp_parked", call });
				},
				onRejectedCall: () => {
					const fullLedger = ledgerDraft as ManagedSessionLedger;
					if (fullLedger.activePump) {
						fullLedger.activePump.pendingAnnouncedMcpCount = Math.max(
							0,
							fullLedger.activePump.pendingAnnouncedMcpCount - 1,
						);
					}
				},
				onClientDisconnect: (callId) => {
					const fullLedger = ledgerDraft as ManagedSessionLedger;
					if (fullLedger.activePump?.cancelledByHoldTimeout) {
						fullLedger.detachedCallIds.add(callId);
					}
					fullLedger.parkedCalls.delete(callId);
					fullLedger.activePump?.emittedMcpCallIds.delete(callId);
				},
				onHoldTimeout: async (call) => {
					const fullLedger = ledgerDraft as ManagedSessionLedger;
					fullLedger.detachedCallIds.add(call.callId);
					if (fullLedger.activePump) {
						fullLedger.activePump.cancelledByHoldTimeout = true;
						for (const emittedId of fullLedger.activePump.emittedMcpCallIds) {
							fullLedger.detachedCallIds.add(emittedId);
						}
					}
					for (const parkedId of fullLedger.parkedCalls.keys()) {
						fullLedger.detachedCallIds.add(parkedId);
					}
					if (fullLedger.agySessionId) {
						this.httpMcpBridge.markSessionTurnCancelled(fullLedger.agySessionId);
						fullLedger.conn.notify("session/cancel", { sessionId: fullLedger.agySessionId });
					}
				},
			});
		}

		let boundToLedger = false;
		try {
			mcpServers.push(
				...(await this.buildSessionMcpServersSpec({
					mcpToken,
					useHttpMcp,
					cwd: params.cwd,
					isProjectTrusted: params.isProjectTrusted,
				})),
			);

			// 拆分前序历史与末尾待发送的新增用户消息，尝试沿会话分支查找锚点恢复
			let tailStartIdx = params.visibleMessages.length;
			while (
				tailStartIdx > 0 &&
				params.visibleMessages[tailStartIdx - 1].role === "user"
			) {
				tailStartIdx--;
			}
			const priorHistory = params.visibleMessages.slice(0, tailStartIdx);
			const pendingUserMessages = params.visibleMessages
				.slice(tailStartIdx)
				.filter((m): m is UserMessage => m.role === "user");

			const priorProjection = inspectTrafficOptProjectionState(priorHistory);
			const branchEntries = this.activeContext?.sessionManager?.getBranch?.() ?? [];
			let anchorMatch =
				!params.skipAnchorRestore && priorHistory.length > 0 && pendingUserMessages.length > 0
					? findBranchAnchorForHistory({
							branchEntries,
							priorMessages: priorHistory,
							toolMode: this.currentConfig.toolMode,
							mountDigest: params.mountDigest,
							config: this.currentConfig,
						})
					: ({ kind: "none" } as const);

			// 自愈校验：若历史锚点指向的本地库缺失 trajectory_metadata_blob（以及 pi-tools 模式下的 pi-bridge 规格），
			// 跳过直接恢复/分叉，改由路径 3 通过官方模板重建，防止回退或加载受损裸库。
			if (anchorMatch.kind !== "none" && !anchorMatch.anchor.importedRaw) {
				const requiredAgent =
					this.currentConfig.toolMode === "pi-tools" ? BRIDGE_AGENT_NAME : undefined;
				const metadataValid = await hasValidAgentMetadataBlob(
					this.currentConfig,
					anchorMatch.anchor.agySessionId,
					requiredAgent,
				);
				if (!metadataValid) {
					anchorMatch = { kind: "none" };
				}
			}

			const addDirs =
				params.additionalDirectories.length > 0 ? params.additionalDirectories : undefined;

			let sessionInfo: AcpSessionNewResult | undefined;
			let initialPromptBlocks: AcpPromptBlock[] | undefined;
			let appliedPreloadedTurns: readonly PreloadedSqliteTurn[] | undefined;
			let syncedProjectionDigest = priorProjection.projectionDigest;
			let syncedProjectedCount = priorProjection.archivedCount;

			// 路径 1：精确命中分支末尾锚点且未发生需同步的新一轮归档 GC -> 调用 session/resume 零历史回放开销恢复
			if (
				anchorMatch.kind === "exact" &&
				conn.capabilities?.sessionCapabilities?.resume &&
				!shouldRebuildForProjectionSync(
					anchorMatch.anchor.projectionDigest ?? "",
					anchorMatch.anchor.projectedCount ?? 0,
					priorProjection,
					anchorMatch.anchor.usedTokens,
				)
			) {
				const pendingBlocks = convertUserMessagesToPromptBlocks(pendingUserMessages);
				const pendingPlan = buildPromptBlocksPreloadPlan(pendingBlocks, {
					segmentLabel: "user-message-part",
				});

				// 若本轮单条新提问本身超过单步 64k 安全线，先只读分叉并预注入前序分片，再恢复分叉会话仅发最后一片
				if (
					!params.signal?.aborted &&
					pendingPlan.preloadedTurns.length > 0 &&
					this.currentConfig.enableSqliteFork &&
					anchorMatch.anchor.dbCheckpoint
				) {
					const forkedId = await forkSqliteConversationAtCheckpoint(
						this.currentConfig,
						anchorMatch.anchor.agySessionId,
						anchorMatch.anchor.dbCheckpoint,
					);
					if (forkedId) {
						const appended = await appendPreloadedTurnsToSqliteConversation(
							this.currentConfig,
							forkedId,
							pendingPlan.preloadedTurns,
						);
						if (appended) {
							try {
								sessionInfo = await conn.request<AcpSessionResumeResult>(
									"session/resume",
									{
										sessionId: forkedId,
										cwd: params.cwd,
										mcpServers,
										additionalDirectories: addDirs,
									},
									{ timeoutMs: 25_000, signal: params.signal },
								);
								initialPromptBlocks = pendingPlan.finalPromptBlocks;
								appliedPreloadedTurns = pendingPlan.preloadedTurns;
								syncedProjectionDigest = anchorMatch.anchor.projectionDigest ?? "";
								syncedProjectedCount = anchorMatch.anchor.projectedCount ?? 0;
							} catch (error) {
								sessionInfo = undefined;
								removeEmptyProbeSessionFiles(this.currentConfig, forkedId);
								if (params.signal?.aborted) {
									throw error;
								}
							}
						} else {
							removeEmptyProbeSessionFiles(this.currentConfig, forkedId);
						}
					}
				}

				if (!sessionInfo && !params.signal?.aborted && pendingPlan.preloadedTurns.length === 0) {
					try {
						sessionInfo = await conn.request<AcpSessionResumeResult>(
							"session/resume",
							{
								sessionId: anchorMatch.anchor.agySessionId,
								cwd: params.cwd,
								mcpServers,
								additionalDirectories: addDirs,
							},
							{ timeoutMs: 20_000, signal: params.signal },
						);
						initialPromptBlocks = pendingPlan.finalPromptBlocks;
						syncedProjectionDigest = anchorMatch.anchor.projectionDigest ?? "";
						syncedProjectedCount = anchorMatch.anchor.projectedCount ?? 0;
					} catch (error) {
						sessionInfo = undefined;
						if (params.signal?.aborted) {
							throw error;
						}
					}
				}
			}

			// 路径 2：命中历史中间锚点且锚点前缀未落后于新一轮归档 GC -> 只读 VACUUM INTO 快照分叉截断 + 按需预注入超长增量 + session/resume
			if (
				!sessionInfo &&
				!params.signal?.aborted &&
				anchorMatch.kind === "forkable" &&
				anchorMatch.anchor.dbCheckpoint &&
				conn.capabilities?.sessionCapabilities?.resume
			) {
				const forkPrefixProjection = inspectTrafficOptProjectionState(
					priorHistory.slice(0, anchorMatch.anchor.messageCount),
				);
				const forkStaleByProjection = shouldRebuildForProjectionSync(
					anchorMatch.anchor.projectionDigest ?? "",
					anchorMatch.anchor.projectedCount ?? 0,
					forkPrefixProjection,
					anchorMatch.anchor.usedTokens,
				);
				if (!forkStaleByProjection) {
					const forkedId = await forkSqliteConversationAtCheckpoint(
						this.currentConfig,
						anchorMatch.anchor.agySessionId,
						anchorMatch.anchor.dbCheckpoint,
					);
					if (forkedId) {
						const remainingAfterFork = params.visibleMessages.slice(
							anchorMatch.anchor.messageCount,
						);
						const forkPlan = buildFreshReplayPlan({
							visibleMessages: remainingAfterFork,
							maxContextWindowTokens: params.modelContextWindow,
						});

						let forkPromptBlocks = forkPlan.finalPromptBlocks;
						let forkUsedPreload = false;
						if (forkPlan.preloadedTurns.length > 0) {
							const appended = await appendPreloadedTurnsToSqliteConversation(
								this.currentConfig,
								forkedId,
								forkPlan.preloadedTurns,
							);
							if (appended) {
								forkUsedPreload = true;
							} else {
								forkPromptBlocks = forkPlan.singleStepFallbackBlocks;
							}
						}

						try {
							sessionInfo = await conn.request<AcpSessionResumeResult>(
								"session/resume",
								{
									sessionId: forkedId,
									cwd: params.cwd,
									mcpServers,
									additionalDirectories: addDirs,
								},
								{ timeoutMs: 25_000, signal: params.signal },
							);
							initialPromptBlocks = forkPromptBlocks;
							if (forkUsedPreload) {
								appliedPreloadedTurns = forkPlan.preloadedTurns;
							}
							if (
								forkPrefixProjection.projectionDigest ===
								(anchorMatch.anchor.projectionDigest ?? "")
							) {
								syncedProjectionDigest = priorProjection.projectionDigest;
								syncedProjectedCount = priorProjection.archivedCount;
							} else {
								syncedProjectionDigest = anchorMatch.anchor.projectionDigest ?? "";
								syncedProjectedCount = anchorMatch.anchor.projectedCount ?? 0;
							}
						} catch (error) {
							sessionInfo = undefined;
							removeEmptyProbeSessionFiles(this.currentConfig, forkedId);
							if (params.signal?.aborted) {
								throw error;
							}
						}
					}
				}
			}

			if (params.signal?.aborted) {
				throw new Error("Request aborted by user");
			}

			// 路径 3：新建会话并重放历史（超出单步 64k 安全线时优先经官方 session/new 模板克隆 + 多步预注入 + session/resume 零额外调用恢复，失败则平滑降级为单步安全重放）
			if (!sessionInfo || !initialPromptBlocks) {
				const replayPlan = buildFreshReplayPlan({
					visibleMessages: params.visibleMessages,
					workspaceContextBlock: params.workspaceContextBlock,
					maxContextWindowTokens: params.modelContextWindow,
				});

				if (replayPlan.preloadedTurns.length > 0) {
					const preloadedRes = await this.createPreloadedSessionFromTemplate({
						conn,
						cwd: params.cwd,
						mcpServers,
						additionalDirectories: addDirs,
						preloadedTurns: replayPlan.preloadedTurns,
						signal: params.signal,
					});
					if (preloadedRes) {
						sessionInfo = preloadedRes;
						initialPromptBlocks = replayPlan.finalPromptBlocks;
						appliedPreloadedTurns = replayPlan.preloadedTurns;
					}
				}

				if (!sessionInfo || !initialPromptBlocks) {
					sessionInfo = await conn.request<AcpSessionNewResult>(
						"session/new",
						{
							cwd: params.cwd,
							mcpServers,
							additionalDirectories: addDirs,
						},
						{ timeoutMs: 25_000, signal: params.signal },
					);
					initialPromptBlocks =
						replayPlan.preloadedTurns.length > 0
							? replayPlan.singleStepFallbackBlocks
							: replayPlan.finalPromptBlocks;
				}

				syncedProjectionDigest = priorProjection.projectionDigest;
				syncedProjectedCount = priorProjection.archivedCount;
			}

			conn.trackSession(sessionInfo.sessionId);
			if (mcpToken) {
				this.httpMcpBridge.updateBindingSessionId(mcpToken, sessionInfo.sessionId);
			}

			const tier = sessionInfo._meta?.antigravity?.tier;
			if (tier) {
				this.latestTier = tier;
			}

			const initialMaxStepIdx = await readCurrentMaxSqliteStepIdx(
				this.currentConfig,
				sessionInfo.sessionId,
			);
			const initialMaxGenIdx = await readCurrentMaxSqliteGenIdx(
				this.currentConfig,
				sessionInfo.sessionId,
			);

			const ledger: ManagedSessionLedger = Object.assign(ledgerDraft, {
				piSessionKey: params.piSessionKey,
				agySessionId: sessionInfo.sessionId,
				conn,
				cwd: params.cwd,
				isProjectTrusted: params.isProjectTrusted,
				additionalDirectories: [...params.additionalDirectories],
				useHttpMcp,
				mcpToken,
				hostMcpTools: params.hostMcpTools,
				toolsDigest: params.toolsDigest,
				mountDigest: params.mountDigest,
				toolMode: this.currentConfig.toolMode,
				configOptions: sessionInfo.configOptions ?? [],
				availableModels: sessionInfo.models?.availableModels ?? [],
				pendingPreloadedTurns: appliedPreloadedTurns,
				syncedMessageCount: priorHistory.length,
				syncedTranscriptDigest: computeTranscriptDigest(priorHistory),
				syncedProjectionDigest,
				syncedProjectedCount,
				cachedPrefixTokens: 0,
				lastConsumedStepIdx: initialMaxStepIdx,
				lastReportedUpstreamGenIdx: initialMaxGenIdx,
				tier,
				parkedCalls: ledgerDraft.parkedCalls!,
				detachedCallIds: ledgerDraft.detachedCallIds!,
				hostMcpAnnouncementIds: new Set<string>(),
			});

			this.ledgers.set(params.piSessionKey, ledger);
			this.ledgersByAgyId.set(sessionInfo.sessionId, ledger);
			boundToLedger = true;
			updateAntigravityStatusBar(
				this.activeContext,
				this.currentConfig,
				this.getTelemetrySnapshot(params.piSessionKey),
			);

			return { ledger, initialPromptBlocks };
		} finally {
			if (!boundToLedger && mcpToken) {
				this.httpMcpBridge.unregisterSessionBinding(mcpToken);
			}
		}
	}

	private async syncSessionModelAndMode(
		ledger: ManagedSessionLedger,
		model: Model<Api>,
		options?: SimpleStreamOptions,
	): Promise<void> {
		const resolved = resolveSessionModelSelection(
			model.id,
			options?.reasoning,
			ledger.configOptions,
			ledger.availableModels,
		);

		if (ledger.appliedModelValue !== resolved.configModelValue) {
			try {
				const res = await ledger.conn.request<AcpSetConfigOptionResult>(
					"session/set_config_option",
					{
						sessionId: ledger.agySessionId,
						configId: "model",
						value: resolved.configModelValue,
					},
					{ timeoutMs: 10_000, signal: options?.signal },
				);
				if (res.configOptions) {
					ledger.configOptions = res.configOptions;
				}
				ledger.appliedModelValue = resolved.configModelValue;
				// 切换模型后服务端可能重置 thought_level 为新模型默认值，同步刷新本地缓存以触发精确重对齐
				const refreshedThought = ledger.configOptions.find((o) => o.id === "thought_level");
				ledger.appliedThoughtLevel = refreshedThought?.currentValue;
			} catch {
				// 若特定渠道不支持切换配置项则保持服务端默认选择
			}
		}

		if (resolved.configThoughtLevel && ledger.appliedThoughtLevel !== resolved.configThoughtLevel) {
			// 校验切换模型后最新通告的 thought_level 候选集
			const thoughtOpt = ledger.configOptions.find((o) => o.id === "thought_level");
			const supportedSet = new Set((thoughtOpt?.options ?? []).map((c) => c.value));
			const targetEffort =
				supportedSet.size === 0 || supportedSet.has(resolved.configThoughtLevel)
					? resolved.configThoughtLevel
					: thoughtOpt?.currentValue;

			if (targetEffort) {
				try {
					const res = await ledger.conn.request<AcpSetConfigOptionResult>(
						"session/set_config_option",
						{
							sessionId: ledger.agySessionId,
							configId: "thought_level",
							value: targetEffort,
						},
						{ timeoutMs: 10_000, signal: options?.signal },
					);
					if (res.configOptions) {
						ledger.configOptions = res.configOptions;
					}
					ledger.appliedThoughtLevel = targetEffort;
				} catch {
					ledger.appliedThoughtLevel = resolved.effectiveEffort;
				}
			}
		} else if (resolved.effectiveEffort) {
			ledger.appliedThoughtLevel = resolved.effectiveEffort;
		}

		if (
			ledger.toolMode !== "pi-tools" &&
			ledger.appliedExecMode !== this.currentConfig.agyExecutionMode
		) {
			try {
				const res = await ledger.conn.request<AcpSetConfigOptionResult>(
					"session/set_config_option",
					{
						sessionId: ledger.agySessionId,
						configId: "mode",
						value: this.currentConfig.agyExecutionMode,
					},
					{ timeoutMs: 8_000, signal: options?.signal },
				);
				if (res.configOptions) {
					ledger.configOptions = res.configOptions;
				}
				ledger.appliedExecMode = this.currentConfig.agyExecutionMode;
			} catch {
				// 忽略不支持模式的 Agent
			}
		}
	}

	private startTrackedSessionPrompt(
		ledger: ManagedSessionLedger,
		pump: ActiveTurnPump,
		outboundPayload: { sessionId: string; prompt: AcpPromptBlock[] },
	): void {
		this.httpMcpBridge.clearSessionCancelled(ledger.agySessionId);
		pump.finished = false;

		let trackedRef: Promise<void> | undefined;
		const tracked = ledger.conn
			.request<AcpPromptResponse>("session/prompt", outboundPayload)
			.then((response) => {
				pump.finished = true;
				if (ledger.activePump === pump) {
					this.mirrorBroker.completePendingCallsImplicitly(ledger.agySessionId);
				}
				pump.queue.push({ kind: "prompt_done", response });
			})
			.catch((error) => {
				pump.finished = true;
				if (ledger.activePump === pump) {
					this.mirrorBroker.abortSessionCalls(ledger.agySessionId, "ACP prompt error");
				}
				pump.queue.push({ kind: "prompt_error", error });
			})
			.finally(() => {
				if (ledger.inFlightPrompt === trackedRef) {
					ledger.inFlightPrompt = undefined;
				}
			});
		trackedRef = tracked;
		ledger.inFlightPrompt = tracked;
	}

	private async executePromptOnLedger(
		ledger: ManagedSessionLedger,
		promptBlocks: AcpPromptBlock[],
		visibleMessagesBeforeAssistant: readonly (
			| UserMessage
			| AssistantMessage
			| ToolResultMessage
		)[],
		writer: StepStreamWriter,
		model: Model<Api>,
		options?: SimpleStreamOptions,
	): Promise<void> {
		// Thin-client policy: never make up a prompt (no "Continue." of our own).
		if (promptBlocks.length === 0) {
			throw new ThinClientPolicyError(NO_NEW_PROMPT_REFUSED);
		}
		const idleOk = await this.waitForInFlightPrompt(ledger, 2_500, options?.signal);
		if (options?.signal?.aborted) {
			writer.fail("aborted", "Request aborted by user");
			return;
		}
		if (!idleOk) {
			await this.discardWedgedLedger(ledger);
			writer.fail(
				"error",
				"Previous Antigravity request did not finish in time; session was reset. Please retry.",
			);
			return;
		}

		ledger.lastSelectedModelId = model.id;
		await this.syncSessionModelAndMode(ledger, model, options);
		if (options?.signal?.aborted || writer.isTerminated) {
			if (!writer.isTerminated) {
				writer.fail("aborted", "Request aborted by user");
			}
			return;
		}

		writer.setResponseMetadata({
			responseId: ledger.agySessionId,
			providerThinkingLevel: ledger.appliedThoughtLevel,
		});

		const preloadedTurns = ledger.pendingPreloadedTurns;
		ledger.pendingPreloadedTurns = undefined;
		let outboundPayload: {
			sessionId: string;
			prompt: AcpPromptBlock[];
			preloadedTurns?: readonly PreloadedSqliteTurn[];
		} = {
			sessionId: ledger.agySessionId,
			prompt: promptBlocks,
			...(preloadedTurns && preloadedTurns.length > 0 ? { preloadedTurns } : {}),
		};

		if (options?.onPayload) {
			const replaced = await options.onPayload(outboundPayload, model);
			if (
				replaced &&
				typeof replaced === "object" &&
				"prompt" in (replaced as Record<string, unknown>)
			) {
				outboundPayload = replaced as typeof outboundPayload;
			}
		}

		if (options?.signal?.aborted || writer.isTerminated) {
			if (!writer.isTerminated) {
				writer.fail("aborted", "Request aborted by user");
			}
			return;
		}

		const currentProjection = inspectTrafficOptProjectionState(visibleMessagesBeforeAssistant);
		const isProjectionSynced =
			currentProjection.projectionDigest === ledger.syncedProjectionDigest;
		const willReportUpstream = this.isLocalSqliteUpstreamLikelyAvailable(ledger.agySessionId);

		const pump: ActiveTurnPump = {
			queue: new AsyncEventQueue<PumpQueueItem>(),
			finished: false,
			cancelledByHoldTimeout: false,
			accountedOutputTokens: 0,
			intermediateStepCount: 0,
			hasSqliteGenTelemetry: false,
			pendingAnnouncedMcpCount: 0,
			emittedMcpCallIds: new Set<string>(),
			deferredMcpOutputs: [],
			autoContinuedTurnCount: 0,
			awaitingUpstreamTelemetry: willReportUpstream,
			lastStepProjectionSynced: isProjectionSynced,
			lastStepUsedSlicePool: false,
		};
		ledger.activePump = pump;
		this.startTrackedSessionPrompt(ledger, pump, {
			sessionId: outboundPayload.sessionId,
			prompt: outboundPayload.prompt,
		});

		if (options?.onResponse) {
			const headers: Record<string, string> = {
				"x-acp-session-id": ledger.agySessionId,
				"x-acp-projection-synced": isProjectionSynced ? "1" : "0",
			};
			if (willReportUpstream) {
				headers["x-acp-upstream-pending"] = "1";
			}
			await options.onResponse(
				{
					status: 200,
					headers,
				},
				model,
			);
		}

		writer.ensureStarted();

		await this.consumePumpForSingleStep(ledger, pump, writer, model, options);

		if (!ledger.activePump && ledger.parkedCalls.size === 0) {
			this.recordSyncedTranscript(ledger, visibleMessagesBeforeAssistant, writer.message);
		}
	}

	private async consumePumpForSingleStep(
		ledger: ManagedSessionLedger,
		pump: ActiveTurnPump,
		writer: StepStreamWriter,
		model: Model<Api>,
		options?: SimpleStreamOptions,
	): Promise<void> {
		const signal = options?.signal;

		const abortCurrentTurnSync = () => {
			this.abortLedgerTurnNonBlocking(ledger);
		};

		while (!writer.isTerminated) {
			if (signal?.aborted) {
				abortCurrentTurnSync();
				writer.fail("aborted", "Request aborted by user");
				return;
			}

			let item: PumpQueueItem;
			try {
				item = await pump.queue.shift(signal);
			} catch {
				abortCurrentTurnSync();
				writer.fail("aborted", "Request aborted by user");
				return;
			}

			if (item.kind === "acp_update") {
				const update = item.update;
				if (options?.onProviderStreamEvent) {
					await options.onProviderStreamEvent(update, model);
				}

				if (update.sessionUpdate === "agent_thought_chunk") {
					this.mirrorBroker.completePendingCallsImplicitly(ledger.agySessionId);
					if (update.content.type === "text") {
						writer.appendThinkingDelta(update.content.text);
					}
					continue;
				}

				if (update.sessionUpdate === "agent_message_chunk") {
					this.mirrorBroker.completePendingCallsImplicitly(ledger.agySessionId);
					if (update.content.type === "text") {
						const { quotaError } = writer.appendTextDelta(update.content.text);
						if (quotaError) {
							await this.emitUpstreamTelemetryForStep(ledger, pump, model, options, {
								status: 429,
							});
							abortCurrentTurnSync();
							writer.fail("error", `${QUOTA_EXCEEDED_ERROR}: ${quotaError}`);
							return;
						}
					}
					continue;
				}

				if (update.sessionUpdate === "tool_call") {
					const classified = this.mirrorBroker.registerOrUpdateCall(
						ledger.agySessionId,
						update,
					);
					await writer.appendToolCallStreaming(
						{
							id: update.toolCallId,
							name: classified.mirrorToolName,
							arguments: classified.arguments,
						},
						writer.hasEmittedAnyDelta ? 0 : 2,
					);

					// 短窗口合并同一帧并发到达的额外原生 tool_call
					await new Promise((r) => setTimeout(r, 15));
					while (!signal?.aborted) {
						const nextPeek = pump.queue.peek();
						if (
							nextPeek?.kind === "acp_update" &&
							nextPeek.update.sessionUpdate === "tool_call"
						) {
							const extra = (await pump.queue.shift()) as {
								kind: "acp_update";
								update: Extract<AcpSessionUpdatePayload, { sessionUpdate: "tool_call" }>;
							};
							const extraClassified = this.mirrorBroker.registerOrUpdateCall(
								ledger.agySessionId,
								extra.update,
							);
							writer.appendToolCall({
								id: extra.update.toolCallId,
								name: extraClassified.mirrorToolName,
								arguments: extraClassified.arguments,
							});
						} else {
							break;
						}
					}

					if (signal?.aborted) {
						abortCurrentTurnSync();
						writer.fail("aborted", "Request aborted by user");
						return;
					}

					const mirrorUsage = await this.buildIntermediateStepUsage(ledger, pump, writer);
					await this.emitUpstreamTelemetryForStep(ledger, pump, model, options, {
						status: 200,
					});
					writer.finishWithToolUse(mirrorUsage);
					return;
				}

				continue;
			}

			if (item.kind === "mcp_parked") {
				pump.emittedMcpCallIds.add(item.call.callId);
				await writer.appendToolCallStreaming(
					{
						id: item.call.callId,
						name: item.call.toolName,
						arguments: item.call.arguments,
					},
					writer.hasEmittedAnyDelta ? 0 : 2,
				);

				// 聚合同一推理步并发触发的其余 MCP 工具调用（若已有 ACP 前置宣告仍在 loopback 传输途中则短窗口收齐）
				const batchDeadline = Date.now() + 180;
				while (!signal?.aborted) {
					if (pump.queue.peek()?.kind === "mcp_parked") {
						const nextItem = (await pump.queue.shift()) as {
							kind: "mcp_parked";
							call: ParkedToolCall;
						};
						pump.emittedMcpCallIds.add(nextItem.call.callId);
						writer.appendToolCall({
							id: nextItem.call.callId,
							name: nextItem.call.toolName,
							arguments: nextItem.call.arguments,
						});
						continue;
					}

					const waitWindowMs = 10;
					if (pump.pendingAnnouncedMcpCount <= 0) {
						// 无额外已宣告在途请求时严格仅做 1 次 10ms 微批探测即收口
						await new Promise((r) => setTimeout(r, waitWindowMs));
						while (pump.queue.peek()?.kind === "mcp_parked") {
							const nextItem = (await pump.queue.shift()) as {
								kind: "mcp_parked";
								call: ParkedToolCall;
							};
							pump.emittedMcpCallIds.add(nextItem.call.callId);
							writer.appendToolCall({
								id: nextItem.call.callId,
								name: nextItem.call.toolName,
								arguments: nextItem.call.arguments,
							});
						}
						break;
					}

					if (Date.now() >= batchDeadline) {
						pump.pendingAnnouncedMcpCount = 0;
						break;
					}
					await new Promise((r) => setTimeout(r, waitWindowMs));
				}

				if (signal?.aborted) {
					abortCurrentTurnSync();
					writer.fail("aborted", "Request aborted by user");
					return;
				}

				const mcpUsage = await this.buildIntermediateStepUsage(ledger, pump, writer);
				await this.emitUpstreamTelemetryForStep(ledger, pump, model, options, {
					status: 200,
				});
				writer.finishWithToolUse(mcpUsage);
				return;
			}

			if (item.kind === "prompt_done") {
				this.mirrorBroker.completePendingCallsImplicitly(ledger.agySessionId);

				if (ledger.windowSize) {
					recordObservedContextWindow(model.id, ledger.windowSize);
					model.contextWindow = ledger.windowSize;
				}

				if (item.response.stopReason === "cancelled" && signal?.aborted) {
					ledger.activePump = undefined;
					writer.fail("aborted", "Request aborted");
					return;
				}
				if (item.response.stopReason === "refusal") {
					await this.emitUpstreamTelemetryForStep(ledger, pump, model, options, {
						status: 400,
					});
					ledger.activePump = undefined;
					writer.fail("error", "Model refused the request");
					return;
				}

				// 当单次连续工具循环触及 agy 单轮最大生成次数限制（max_turn_requests）时，在同一热会话上自动无感续接
				if (
					ledger.toolMode === "pi-tools" &&
					item.response.stopReason === "max_turn_requests" &&
					!signal?.aborted &&
					pump.autoContinuedTurnCount < MAX_AUTO_CONTINUED_TURN_REQUESTS
				) {
					pump.autoContinuedTurnCount++;
					if (this.isLocalSqliteUpstreamLikelyAvailable(ledger.agySessionId)) {
						pump.awaitingUpstreamTelemetry = true;
					}
					this.startTrackedSessionPrompt(ledger, pump, {
						sessionId: ledger.agySessionId,
						prompt: [{ type: "text", text: "Continue from where you left off." }],
					});
					continue;
				}

				ledger.activePump = undefined;

				if (
					item.response.stopReason === "max_turn_requests" &&
					!writer.message.content.some((b) => b.type === "text" && b.text.trim().length > 0)
				) {
					writer.appendTextDelta(
						"[Reached maximum consecutive steps for this turn. Send a message to continue.]",
					);
				}

				const calibratedUsage = await this.buildFinalStepUsage(
					ledger,
					pump,
					writer,
					item.response.usage,
				);
				await this.emitUpstreamTelemetryForStep(ledger, pump, model, options, {
					status: 200,
				});
				const { quotaError } = writer.finishTurn(
					item.response.stopReason,
					calibratedUsage,
				);
				if (quotaError) {
					writer.fail("error", `${QUOTA_EXCEEDED_ERROR}: ${quotaError}`);
				}
				return;
			}

			if (item.kind === "prompt_error") {
				const errMsg =
					item.error instanceof Error ? item.error.message : String(item.error);
				const statusMatch = /\b([45]\d\d)\b/.exec(errMsg);
				if (!signal?.aborted) {
					await this.emitUpstreamTelemetryForStep(ledger, pump, model, options, {
						status: statusMatch ? Number(statusMatch[1]) : 500,
					});
				}
				this.mirrorBroker.abortSessionCalls(ledger.agySessionId, "ACP prompt error");
				ledger.activePump = undefined;
				writer.fail(signal?.aborted ? "aborted" : "error", errMsg);
				return;
			}
		}
	}

	/**
	 * 工具边界切入（延迟大图、steer、动态重载）触发 `session/cancel` 并等待前序在途请求收敛后，
	 * 若 `agy` 已在 20ms 落盘窗口内抢跑发起了 1 次被取消的上游生成，提前按其自身真实快照独立结算并推进水位，
	 * 防止随后的切入多模态请求因 `newGenCount > 1` 而把新大图误重计到前序被取消代次中。
	 */
	private async flushCutInCancelledUpstreamTelemetry(
		ledger: ManagedSessionLedger,
		model: Model<Api>,
		options: SimpleStreamOptions | undefined,
	): Promise<void> {
		if (!hasLocalConversationDb(this.currentConfig, ledger.agySessionId)) {
			return;
		}
		const query = await readLatestSqliteUpstreamRequestSince(
			this.currentConfig,
			ledger.agySessionId,
			ledger.lastReportedUpstreamGenIdx,
			[],
		);
		if (query.newGenCount <= 0) {
			return;
		}
		ledger.lastReportedUpstreamGenIdx = Math.max(
			ledger.lastReportedUpstreamGenIdx,
			query.maxGenIdx,
		);
		if (query.latest && options?.onResponse) {
			await options.onResponse(
				{
					status: 499,
					headers: {
						"x-acp-session-id": ledger.agySessionId,
						"x-acp-transport": "acp-upstream",
						"x-acp-upstream-detached": "1",
						"x-acp-upstream-gen-count": String(Math.max(1, query.newGenCount)),
						"x-acp-upstream-snapshot": JSON.stringify(query.latest),
					},
				},
				model,
			);
		}
	}

	private isLocalSqliteUpstreamLikelyAvailable(agySessionId: string): boolean {
		if (!agySessionId) return false;
		if (hasLocalConversationDb(this.currentConfig, agySessionId)) return true;
		try {
			return fs.existsSync(resolveAgyConversationsDir(this.currentConfig));
		} catch {
			return false;
		}
	}

	/**
	 * 在当前推理步完成后，从只读 SQLite `gen_metadata` 提取 `agy` 实际发往远端云端的全量请求分类统计并通过 `options.onResponse` 上报。
	 * - 若本步产生了新上游生成：发射 `x-acp-transport: acp-upstream` 携带精确全量统计与图片清单；
	 * - 若本步仅复用同一次生成的顺序工具切片（未新发外网请求）：发射 `x-acp-transport: acp-upstream-reused` 防止重复计费；
	 * - 若本地库不可用或无快照且曾通告 `x-acp-upstream-pending: 1`：发射 `x-acp-transport: acp-upstream-unavailable` 让观测扩展平滑回退至本地载荷计量。
	 */
	private async emitUpstreamTelemetryForStep(
		ledger: ManagedSessionLedger,
		pump: ActiveTurnPump,
		model: Model<Api>,
		options: SimpleStreamOptions | undefined,
		params: { status: number },
	): Promise<void> {
		if (!options?.onResponse) return;
		const wasAwaiting = pump.awaitingUpstreamTelemetry;
		pump.awaitingUpstreamTelemetry = false;

		const hasDb = hasLocalConversationDb(this.currentConfig, ledger.agySessionId);
		if (!hasDb && !wasAwaiting) {
			return;
		}

		const projectionHeader = pump.lastStepProjectionSynced ? "1" : "0";
		const retryDelays = pump.lastStepUsedSlicePool
			? []
			: pump.hasSqliteGenTelemetry
				? [15]
				: [20, 40];
		const query = hasDb
			? await readLatestSqliteUpstreamRequestSince(
					this.currentConfig,
					ledger.agySessionId,
					ledger.lastReportedUpstreamGenIdx,
					retryDelays,
				)
			: { maxGenIdx: ledger.lastReportedUpstreamGenIdx, newGenCount: 0 };

		if (query.latest) {
			ledger.lastReportedUpstreamGenIdx = Math.max(
				ledger.lastReportedUpstreamGenIdx,
				query.maxGenIdx,
			);
			await options.onResponse(
				{
					status: params.status,
					headers: {
						"x-acp-session-id": ledger.agySessionId,
						"x-acp-transport": "acp-upstream",
						"x-acp-projection-synced": projectionHeader,
						"x-acp-upstream-gen-count": String(Math.max(1, query.newGenCount)),
						"x-acp-upstream-snapshot": JSON.stringify(query.latest),
					},
				},
				model,
			);
			return;
		}

		if (query.newGenCount === 0 && pump.lastStepUsedSlicePool) {
			await options.onResponse(
				{
					status: params.status,
					headers: {
						"x-acp-session-id": ledger.agySessionId,
						"x-acp-transport": "acp-upstream-reused",
						"x-acp-projection-synced": projectionHeader,
					},
				},
				model,
			);
			return;
		}

		if (wasAwaiting) {
			await options.onResponse(
				{
					status: params.status,
					headers: {
						"x-acp-session-id": ledger.agySessionId,
						"x-acp-transport": "acp-upstream-unavailable",
						"x-acp-projection-synced": projectionHeader,
					},
				},
				model,
			);
		}
	}

	private drainPendingSlicePool(ledger: ManagedSessionLedger): {
		input: number;
		cacheRead: number;
		cacheWrite: number;
		output: number;
		windowTotal: number;
	} {
		const pool = ledger.pendingGenSlicePool;
		ledger.pendingGenSlicePool = undefined;
		if (!pool) {
			return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, windowTotal: 0 };
		}
		return {
			input: pool.input,
			cacheRead: pool.cacheRead,
			cacheWrite: pool.cacheWrite,
			output: pool.output,
			windowTotal: pool.windowTotal,
		};
	}

	/**
	 * 为多步工具调用循环中的单个中间 `toolUse` 步构建精确归因 `Usage`：
	 * 1. 优先从会话只读 SQLite `steps.metadata` 与 `step_payload`（`step_type = 15`）提取当前最新一次生成的上游明细与工具总数（非切片路径带短 WAL 重试，避免大 WAL 锁竞争误落回退）；
	 * 2. 若单次模型生成包含多个顺序执行的工具调用，按整数守恒池向后续子步预留等比例切片（单切片 `<= 1000`、总预留控制 `<= 1000`），保持缓存命中率稳定、累计守恒且降低对 Pi `cache-stats` 的干扰；
	 * 3. 在无本地库的环境下仅依据真实观测到的上游命中率（含 `0%` 未命中）平滑回退，绝不凭空伪造命中率。
	 */
	private async buildIntermediateStepUsage(
		ledger: ManagedSessionLedger,
		pump: ActiveTurnPump,
		writer: StepStreamWriter,
	): Promise<Usage> {
		const hasPendingSlices =
			ledger.pendingGenSlicePool !== undefined &&
			ledger.pendingGenSlicePool.remainingSlices > 0;
		const dbGens = hasPendingSlices
			? await readSqliteGenerationUsagesSince(
					this.currentConfig,
					ledger.agySessionId,
					ledger.lastConsumedStepIdx,
				)
			: await readSqliteGenerationUsagesSinceWithRetry(
					this.currentConfig,
					ledger.agySessionId,
					ledger.lastConsumedStepIdx,
					[20, 40],
				);

		const liveWindowUsed =
			typeof ledger.usedTokens === "number" && ledger.usedTokens > 0
				? Math.floor(ledger.usedTokens)
				: 0;

		if (dbGens.length > 0) {
			// 新生成已落盘，丢弃上一生成未耗尽的旧切片池，绝不跨生成混算污染当次缓存命中率
			ledger.pendingGenSlicePool = undefined;
			pump.hasSqliteGenTelemetry = true;
			pump.intermediateStepCount++;
			if (liveWindowUsed > 0) {
				pump.lastAccountedWindowUsed = liveWindowUsed;
			}

			// 始终以最新一条真实生成作为本步归因，避免多行叠加混算导致虚假均值命中率
			const lastGen = dbGens[dbGens.length - 1];
			ledger.lastConsumedStepIdx = lastGen.stepIdx;

			const genInput = lastGen.inputTokens;
			const genOutput = lastGen.outputTokens;
			const genCacheWrite = lastGen.cacheWriteTokens;
			const genCacheRead = lastGen.cacheReadTokens;
			const hasThought = lastGen.thoughtTokens !== undefined;
			const thoughtSum = lastGen.thoughtTokens ?? 0;

			const genPromptSum = genInput + genCacheRead + genCacheWrite;
			if (genPromptSum > 0) {
				ledger.lastObservedCacheRatio = Math.min(1, Math.max(0, genCacheRead / genPromptSum));
			}

			const latestGenWindowTotal = genPromptSum + genOutput;
			const effectiveWindow = liveWindowUsed > 0 ? liveWindowUsed : latestGenWindowTotal;
			pump.accountedOutputTokens += genOutput;
			ledger.cachedPrefixTokens = Math.max(ledger.cachedPrefixTokens, effectiveWindow);

			const emittedToolCount = Math.max(
				1,
				writer.message.content.filter((b) => b.type === "toolCall").length,
			);
			const plannedTools = lastGen.plannedToolCalls ?? 1;
			const remainingSlices = Math.max(0, plannedTools - emittedToolCount);

			if (remainingSlices > 0 && genPromptSum >= (remainingSlices + 1) * 20) {
				// 尽量将全部预留切片总扣减控制在 <= 1000（低于 Pi cache-stats 的 1024 噪声门限），
				// 且单切片保持在 [100, 1000] 内兼顾状态栏显示精度与不自触发假未命中告警
				const targetPerSlice = Math.min(
					1_000,
					Math.max(100, Math.floor(1_000 / remainingSlices)),
				);
				const sliceBudget = Math.min(
					targetPerSlice,
					Math.floor(genPromptSum / (remainingSlices + 1)),
				);
				const ratioCr = genPromptSum > 0 ? genCacheRead / genPromptSum : 0;
				const ratioCw = genPromptSum > 0 ? genCacheWrite / genPromptSum : 0;
				const perCr = Math.round(sliceBudget * ratioCr);
				const perCw = Math.min(sliceBudget - perCr, Math.round(sliceBudget * ratioCw));
				const perIn = Math.max(0, sliceBudget - perCr - perCw);

				const resCr = Math.min(genCacheRead, remainingSlices * perCr);
				const resCw = Math.min(genCacheWrite, remainingSlices * perCw);
				const resIn = Math.min(genInput, remainingSlices * perIn);
				// 严格保证第 1 步 output >= reasoning，仅在扣除思考 Token 仍有余量时才向后续切片预留 output
				const minStepOut = Math.max(1, hasThought ? thoughtSum : 1);
				const resOut = Math.min(remainingSlices, Math.max(0, genOutput - minStepOut));

				ledger.pendingGenSlicePool = {
					remainingSlices,
					input: resIn,
					cacheRead: resCr,
					cacheWrite: resCw,
					output: resOut,
					windowTotal: effectiveWindow,
				};

				const stepOut = Math.max(1, genOutput - resOut);
				return {
					input: genInput - resIn,
					output: stepOut,
					cacheRead: genCacheRead - resCr,
					cacheWrite: genCacheWrite - resCw,
					reasoning: hasThought ? Math.min(stepOut, thoughtSum) : undefined,
					totalTokens: effectiveWindow,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}

			const finalStepOut = Math.max(1, genOutput);
			return {
				input: genInput,
				output: finalStepOut,
				cacheRead: genCacheRead,
				cacheWrite: genCacheWrite,
				reasoning: hasThought ? Math.min(finalStepOut, thoughtSum) : undefined,
				totalTokens: effectiveWindow,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}

		// 同一次模型生成拆出第 2..N 个工具调用：优先从整数守恒池弹出等比例切片，保持命中率稳定显示且累计值 100% 守恒
		if (
			pump.hasSqliteGenTelemetry ||
			(liveWindowUsed > 0 && pump.lastAccountedWindowUsed === liveWindowUsed)
		) {
			pump.lastStepUsedSlicePool = true;
			const pool = ledger.pendingGenSlicePool;
			if (pool && pool.remainingSlices > 0) {
				const k = pool.remainingSlices;
				const takeIn = Math.round(pool.input / k);
				const takeCr = Math.round(pool.cacheRead / k);
				const takeCw = Math.round(pool.cacheWrite / k);
				const takeOut = Math.round(pool.output / k);
				pool.input -= takeIn;
				pool.cacheRead -= takeCr;
				pool.cacheWrite -= takeCw;
				pool.output -= takeOut;
				pool.remainingSlices -= 1;
				const win = liveWindowUsed > 0 ? liveWindowUsed : pool.windowTotal;
				if (pool.remainingSlices <= 0) {
					ledger.pendingGenSlicePool = undefined;
				}
				return {
					input: takeIn,
					output: takeOut,
					cacheRead: takeCr,
					cacheWrite: takeCw,
					totalTokens: win,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}

			// 切片池耗尽或无本地库回退路径下的同次生成拆分步：若会话已有真实缓存观测值（含 0%），返回极小整数比例样本维持 UI 显示稳定
			if (ledger.lastObservedCacheRatio !== undefined) {
				const win = liveWindowUsed > 0 ? liveWindowUsed : ledger.cachedPrefixTokens;
				const cr =
					ledger.lastObservedCacheRatio > 0
						? Math.max(1, Math.min(100, Math.round(100 * ledger.lastObservedCacheRatio)))
						: 0;
				return {
					input: 100 - cr,
					output: 0,
					cacheRead: cr,
					cacheWrite: 0,
					totalTokens: win,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}

			return createZeroUsage();
		}

		pump.intermediateStepCount++;
		if (liveWindowUsed > 0) {
			pump.lastAccountedWindowUsed = liveWindowUsed;
		}

		const output = Math.max(1, Math.round(writer.estimatedOutputTokens));
		const thought =
			writer.estimatedThoughtTokens > 0
				? Math.min(output, Math.round(writer.estimatedThoughtTokens))
				: undefined;
		pump.accountedOutputTokens += output;

		if (liveWindowUsed === 0 && ledger.cachedPrefixTokens === 0) {
			return {
				input: 0,
				output,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: thought,
				totalTokens: output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}

		const prevCachedPrefix = ledger.cachedPrefixTokens;
		const stepTotal = Math.max(output + 1, liveWindowUsed || prevCachedPrefix + output);
		const promptTokens = Math.max(1, stepTotal - output);
		// 仅依据已真实观测到的上游缓存命中率折算（含 0% 未命中）；尚未获得任何上游缓存遥测时绝不硬编码伪造命中率
		const cacheRead =
			ledger.lastObservedCacheRatio !== undefined
				? Math.min(promptTokens, Math.round(promptTokens * ledger.lastObservedCacheRatio))
				: 0;
		const input = Math.max(0, promptTokens - cacheRead);
		const totalTokens = input + cacheRead + output;
		ledger.cachedPrefixTokens = Math.max(prevCachedPrefix, totalTokens);

		return {
			input,
			output,
			cacheRead,
			cacheWrite: 0,
			reasoning: thought,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	/**
	 * 为最终 `stop` 步校准 `Usage`：
	 * 1. 优先读取本地 SQLite `steps.metadata` 中末步真实生成明细（精确匹配上游单步命中率与真实 `output`，含 `0%` 未命中且不混入跨生成旧切片）；
	 * 2. 回退路径下：单步轮次或无 SQLite 环境才从 `acpUsage` 更新观测比率，多步 SQLite WAL 延迟回退时保留精确单步观测比率且绝不将整轮累计 `output` 余量倒灌至最后一条消息。
	 */
	private async buildFinalStepUsage(
		ledger: ManagedSessionLedger,
		pump: ActiveTurnPump,
		writer: StepStreamWriter,
		acpUsage?: AcpPromptUsage,
	): Promise<Usage> {
		const raw = convertAcpUsageToPiUsage(acpUsage);
		const rawPromptTotal = raw.input + raw.cacheRead + raw.cacheWrite;

		const liveWindowUsed =
			typeof ledger.usedTokens === "number" && ledger.usedTokens > 0
				? Math.floor(ledger.usedTokens)
				: undefined;

		const dbGens = await readSqliteGenerationUsagesSinceWithRetry(
			this.currentConfig,
			ledger.agySessionId,
			ledger.lastConsumedStepIdx,
		);

		if (dbGens.length > 0) {
			// 新生成已落盘，丢弃上一生成未耗尽的旧切片池并取最新一条真实生成，确保末步命中率与输出 100% 纯净
			ledger.pendingGenSlicePool = undefined;
			pump.hasSqliteGenTelemetry = true;
			const lastGen = dbGens[dbGens.length - 1];
			ledger.lastConsumedStepIdx = lastGen.stepIdx;

			const promptSum =
				lastGen.inputTokens + lastGen.cacheReadTokens + lastGen.cacheWriteTokens;
			if (promptSum > 0) {
				ledger.lastObservedCacheRatio = Math.min(
					1,
					Math.max(0, lastGen.cacheReadTokens / promptSum),
				);
			}
			const latestGenWindowTotal = promptSum + lastGen.outputTokens;
			const effectiveWindow = liveWindowUsed ?? latestGenWindowTotal;
			ledger.cachedPrefixTokens = effectiveWindow;

			const hasThought = lastGen.thoughtTokens !== undefined;
			return {
				input: lastGen.inputTokens,
				output: lastGen.outputTokens,
				cacheRead: lastGen.cacheReadTokens,
				cacheWrite: lastGen.cacheWriteTokens,
				reasoning: hasThought
					? Math.min(lastGen.outputTokens, lastGen.thoughtTokens!)
					: undefined,
				totalTokens: effectiveWindow,
				cost: raw.cost,
			};
		}

		if (pump.hasSqliteGenTelemetry) {
			const carry = this.drainPendingSlicePool(ledger);
			if (carry.input + carry.cacheRead + carry.cacheWrite + carry.output > 0) {
				return {
					input: carry.input,
					output: carry.output,
					cacheRead: carry.cacheRead,
					cacheWrite: carry.cacheWrite,
					totalTokens: liveWindowUsed ?? carry.windowTotal,
					cost: raw.cost,
				};
			}
			// 若末步 SQLite WAL 延迟落盘或遇到锁冲突导致 dbGens 为空，回退至下方末步估算与缓存命中率对齐，
			// 绝不直接返回全零 Usage 导致末步 output 与状态栏缓存命中率消失。
			if (
				writer.estimatedOutputTokens === 0 &&
				raw.output === 0 &&
				ledger.lastObservedCacheRatio === undefined
			) {
				return createZeroUsage();
			}
		}

		// 仅在单步轮次或无 SQLite 遥测时才从整轮汇总 acpUsage 更新观测比率（含 0%），避免多步累计均值污染 SQLite 单步基准
		if (
			rawPromptTotal > 0 &&
			(pump.intermediateStepCount === 0 || !pump.hasSqliteGenTelemetry)
		) {
			ledger.lastObservedCacheRatio = Math.min(1, Math.max(0, raw.cacheRead / rawPromptTotal));
		}

		const cacheRatio = ledger.lastObservedCacheRatio ?? 0;

		// 情况 A：单步无中间工具调用
		if (pump.intermediateStepCount === 0) {
			const effectiveOutput =
				raw.output > 0 ? raw.output : Math.max(0, Math.round(writer.estimatedOutputTokens));
			if (liveWindowUsed !== undefined && raw.totalTokens > liveWindowUsed * 1.05) {
				const cappedOutput = Math.min(effectiveOutput, liveWindowUsed);
				const promptBudget = Math.max(0, liveWindowUsed - cappedOutput);
				const cacheRead = Math.min(promptBudget, Math.round(promptBudget * cacheRatio));
				const input = Math.max(0, promptBudget - cacheRead);
				ledger.cachedPrefixTokens = liveWindowUsed;
				return {
					input,
					output: cappedOutput,
					cacheRead,
					cacheWrite: 0,
					reasoning: raw.reasoning !== undefined ? Math.min(raw.reasoning, cappedOutput) : undefined,
					totalTokens: input + cacheRead + cappedOutput,
					cost: raw.cost,
				};
			}

			const finalSingle: Usage =
				raw.output === effectiveOutput
					? raw
					: {
							...raw,
							output: effectiveOutput,
							totalTokens: rawPromptTotal + effectiveOutput,
						};
			ledger.cachedPrefixTokens = liveWindowUsed ?? finalSingle.totalTokens;
			return finalSingle;
		}

		// 情况 B：无本地库时的多步终态回退，仅按末步自身估算输出记账，不倒灌整轮累计余量
		const estOut = Math.round(writer.estimatedOutputTokens);
		const output =
			raw.output > 0
				? Math.min(raw.output, Math.max(estOut > 0 ? 1 : 0, estOut))
				: Math.max(estOut > 0 ? 1 : 0, estOut);
		const thought =
			writer.estimatedThoughtTokens > 0
				? Math.min(output, Math.round(writer.estimatedThoughtTokens))
				: undefined;

		const targetTotal =
			liveWindowUsed !== undefined
				? Math.max(output, liveWindowUsed)
				: Math.max(ledger.cachedPrefixTokens, output);
		const promptTokens = Math.max(0, targetTotal - output);
		const cacheRead = Math.min(promptTokens, Math.round(promptTokens * cacheRatio));
		const input = Math.max(0, promptTokens - cacheRead);
		const totalTokens = input + cacheRead + output;
		ledger.cachedPrefixTokens = totalTokens;

		return {
			input,
			output,
			cacheRead,
			cacheWrite: 0,
			reasoning: thought,
			totalTokens,
			cost: raw.cost,
		};
	}

	private recordSyncedTranscript(
		ledger: ManagedSessionLedger,
		priorMessages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
		finalAssistantMessage: AssistantMessage,
	): void {
		if (
			finalAssistantMessage.stopReason === "error" ||
			finalAssistantMessage.stopReason === "aborted"
		) {
			return;
		}
		const full = [...priorMessages, finalAssistantMessage];
		ledger.syncedMessageCount = full.length;
		ledger.syncedTranscriptDigest = computeTranscriptDigest(full);
	}

	/** 执行用完即关的无状态单轮辅助请求（用于 `/compact` 摘要等，绝不修改系统提示词且不干扰主会话） */
	private async runEphemeralAuxiliaryTurn(
		writer: StepStreamWriter,
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): Promise<void> {
		const cwd = this.activeContext?.cwd ?? process.cwd();
		const conn = await this.processManager.acquire(
			this.currentConfig,
			{
				userAgentName: undefined,
				disableBuiltinTools: true,
				excludeDefaultComponents: true,
				inheritCustomizations: false,
				inheritMcp: false,
				mountedPluginPaths: [],
				includeDefaultCustomizations: false,
			},
			options?.signal,
		);

		const visible = extractVisibleMessages(context.messages);
		const auxInstructions = extractAuxiliaryTaskInstructions(context);
		const auxPlan = buildFreshReplayPlan({
			visibleMessages: visible,
			workspaceContextBlock: auxInstructions
				? `<task_instructions>\n${auxInstructions}\n</task_instructions>`
				: undefined,
			maxContextWindowTokens: model.contextWindow,
		});

		let sessionRes: AcpSessionNewResult | undefined;
		let promptBlocks: AcpPromptBlock[] = auxPlan.finalPromptBlocks;
		let usedAuxPreload = false;

		if (auxPlan.preloadedTurns.length > 0) {
			sessionRes = await this.createPreloadedSessionFromTemplate({
				conn,
				cwd,
				mcpServers: [],
				preloadedTurns: auxPlan.preloadedTurns,
				signal: options?.signal,
			});
			if (sessionRes) {
				usedAuxPreload = true;
			}
		}

		if (!sessionRes) {
			sessionRes = await conn.request<AcpSessionNewResult>(
				"session/new",
				{
					cwd,
					mcpServers: [],
				},
				{ timeoutMs: 20_000, signal: options?.signal },
			);
			if (auxPlan.preloadedTurns.length > 0) {
				promptBlocks = auxPlan.singleStepFallbackBlocks;
			}
		}

		const tempSessionId = sessionRes.sessionId;
		const resolved = resolveSessionModelSelection(
			model.id,
			options?.reasoning,
			sessionRes.configOptions ?? [],
			sessionRes.models?.availableModels ?? [],
		);

		let tempSessionCleaned = false;
		const cleanupTempSession = async () => {
			if (tempSessionCleaned) return;
			tempSessionCleaned = true;
			await conn.closeSessionSafe(tempSessionId);
			removeEmptyProbeSessionFiles(this.currentConfig, tempSessionId);
		};

		try {
			const modelRes = await conn
				.request<AcpSetConfigOptionResult>(
					"session/set_config_option",
					{
						sessionId: tempSessionId,
						configId: "model",
						value: resolved.configModelValue,
					},
					{ timeoutMs: 8_000, signal: options?.signal },
				)
				.catch(() => undefined);

			if (resolved.configThoughtLevel) {
				const latestOpts = modelRes?.configOptions ?? sessionRes.configOptions ?? [];
				const thoughtOpt = latestOpts.find((o) => o.id === "thought_level");
				const supported = new Set((thoughtOpt?.options ?? []).map((c) => c.value));
				if (supported.size === 0 || supported.has(resolved.configThoughtLevel)) {
					await conn
						.request(
							"session/set_config_option",
							{
								sessionId: tempSessionId,
								configId: "thought_level",
								value: resolved.configThoughtLevel,
							},
							{ timeoutMs: 8_000, signal: options?.signal },
						)
						.catch(() => {});
				}
			}

			let detectedQuotaErr: string | undefined;
			const unsubscribe = this.registerAuxiliaryUpdateListener(tempSessionId, (update) => {
				if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
					writer.appendThinkingDelta(update.content.text);
				} else if (
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text"
				) {
					const { quotaError } = writer.appendTextDelta(update.content.text);
					if (quotaError) {
						detectedQuotaErr = quotaError;
					}
				}
			});

			try {
				const onAuxAbort = () => {
					conn.notify("session/cancel", { sessionId: tempSessionId });
				};
				options?.signal?.addEventListener("abort", onAuxAbort, { once: true });
				try {
					let auxOutboundPayload: {
						sessionId: string;
						prompt: AcpPromptBlock[];
						preloadedTurns?: readonly PreloadedSqliteTurn[];
					} = {
						sessionId: tempSessionId,
						prompt: promptBlocks,
						...(usedAuxPreload && auxPlan.preloadedTurns.length > 0
							? { preloadedTurns: auxPlan.preloadedTurns }
							: {}),
					};
					if (options?.onPayload) {
						const replaced = await options.onPayload(auxOutboundPayload, model);
						if (
							replaced &&
							typeof replaced === "object" &&
							"prompt" in (replaced as Record<string, unknown>)
						) {
							auxOutboundPayload = replaced as typeof auxOutboundPayload;
						}
					}
					if (options?.signal?.aborted || writer.isTerminated) {
						if (!writer.isTerminated) {
							writer.fail("aborted", "Request aborted by user");
						}
						return;
					}
					const auxWillReportUpstream =
						this.isLocalSqliteUpstreamLikelyAvailable(tempSessionId);
					if (options?.onResponse) {
						const auxHeaders: Record<string, string> = {
							"x-acp-session-id": tempSessionId,
							"x-acp-auxiliary": "1",
						};
						if (auxWillReportUpstream) {
							auxHeaders["x-acp-upstream-pending"] = "1";
						}
						await options.onResponse(
							{
								status: 200,
								headers: auxHeaders,
							},
							model,
						);
					}
					writer.ensureStarted();
					let promptRes: AcpPromptResponse;
					try {
						promptRes = await conn.request<AcpPromptResponse>(
							"session/prompt",
							{
								sessionId: auxOutboundPayload.sessionId,
								prompt: auxOutboundPayload.prompt,
							},
							{ signal: options?.signal },
						);
					} catch (auxError) {
						if (options?.onResponse && auxWillReportUpstream) {
							const auxErrMsg =
								auxError instanceof Error ? auxError.message : String(auxError);
							const statusMatch = /\b([45]\d\d)\b/.exec(auxErrMsg);
							const auxStatus = statusMatch ? Number(statusMatch[1]) : 500;
							const auxQuery = await readLatestSqliteUpstreamRequestSince(
								this.currentConfig,
								tempSessionId,
								-1,
								[],
							);
							await options.onResponse(
								{
									status: auxStatus,
									headers: auxQuery.latest
										? {
												"x-acp-session-id": tempSessionId,
												"x-acp-auxiliary": "1",
												"x-acp-transport": "acp-upstream",
												"x-acp-upstream-gen-count": String(Math.max(1, auxQuery.newGenCount)),
												"x-acp-upstream-snapshot": JSON.stringify(auxQuery.latest),
											}
										: {
												"x-acp-session-id": tempSessionId,
												"x-acp-auxiliary": "1",
												"x-acp-transport": "acp-upstream-unavailable",
											},
								},
								model,
							);
						}
						throw auxError;
					}
					if (options?.onResponse && auxWillReportUpstream) {
						const auxStatus = detectedQuotaErr
							? 429
							: promptRes.stopReason === "refusal"
								? 400
								: 200;
						const auxQuery = await readLatestSqliteUpstreamRequestSince(
							this.currentConfig,
							tempSessionId,
							-1,
							[20, 40],
						);
						if (auxQuery.latest) {
							await options.onResponse(
								{
									status: auxStatus,
									headers: {
										"x-acp-session-id": tempSessionId,
										"x-acp-auxiliary": "1",
										"x-acp-transport": "acp-upstream",
										"x-acp-upstream-gen-count": String(Math.max(1, auxQuery.newGenCount)),
										"x-acp-upstream-snapshot": JSON.stringify(auxQuery.latest),
									},
								},
								model,
							);
						} else {
							await options.onResponse(
								{
									status: auxStatus,
									headers: {
										"x-acp-session-id": tempSessionId,
										"x-acp-auxiliary": "1",
										"x-acp-transport": "acp-upstream-unavailable",
									},
								},
								model,
							);
						}
					}
					await cleanupTempSession();
					if (detectedQuotaErr) {
						writer.fail("error", `${QUOTA_EXCEEDED_ERROR}: ${detectedQuotaErr}`);
						return;
					}
					if (promptRes.stopReason === "cancelled") {
						writer.fail("aborted", "Request aborted");
						return;
					}
					if (promptRes.stopReason === "refusal") {
						writer.fail("error", "Model refused the request");
						return;
					}
					const { quotaError } = writer.finishTurn(promptRes.stopReason, promptRes.usage);
					if (quotaError) {
						writer.fail("error", `${QUOTA_EXCEEDED_ERROR}: ${quotaError}`);
					}
				} finally {
					options?.signal?.removeEventListener("abort", onAuxAbort);
				}
			} finally {
				unsubscribe();
			}
		} finally {
			await cleanupTempSession();
		}
	}

	private async teardownLedger(ledger: ManagedSessionLedger): Promise<void> {
		this.ledgers.delete(ledger.piSessionKey);
		this.ledgersByAgyId.delete(ledger.agySessionId);

		for (const [, parked] of ledger.parkedCalls) {
			parked.settle({
				isError: true,
				content: [{ type: "text", text: "Session closed" }],
			});
		}
		ledger.parkedCalls.clear();
		ledger.detachedCallIds.clear();
		ledger.activePump = undefined;
		ledger.inFlightPrompt = undefined;

		if (ledger.mcpToken) {
			this.httpMcpBridge.unregisterSessionBinding(ledger.mcpToken);
		}
		this.mirrorBroker.abortSessionCalls(ledger.agySessionId, "Session closed");
		await ledger.conn.closeSessionSafe(ledger.agySessionId);
	}
}
