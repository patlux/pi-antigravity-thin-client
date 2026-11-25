import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import {
	type BuiltinProvider,
	getBuiltinModels,
	getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;
import type { AcpProcessManager } from "../acp/process-manager.ts";
import type {
	AcpAvailableModel,
	AcpConfigOption,
	AcpSessionNewResult,
	AcpTierInfo,
} from "../acp/protocol.ts";
import {
	type BridgeConfig,
	resolveAgyConversationsDir,
	resolveModelCachePath,
} from "../config.ts";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_API_ID = "antigravity-acp";
export const ANTIGRAVITY_BASE_URL = "acp://antigravity-cli";

const EFFORT_SUFFIXES = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortSuffix = (typeof EFFORT_SUFFIXES)[number];

const EFFORT_ORDER: readonly EffortSuffix[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const ZERO_MODEL_COST: ChatModelConfig["cost"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

/** 从 Pi 内置官方目录查找参考定价时的 Provider 优先级（优先官方直连定价，规避区域溢价与批量折扣条目） */
const PRICING_PROVIDER_PRIORITY: readonly string[] = [
	"google",
	"anthropic",
	"google-vertex",
	"openai",
	"radius",
	"groq",
	"together",
	"openrouter",
];

let cachedBuiltinCostIndex: Map<string, ChatModelConfig["cost"]> | undefined;

function cloneModelCost(cost: ChatModelConfig["cost"]): ChatModelConfig["cost"] {
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
		...(cost.tiers && cost.tiers.length > 0
			? { tiers: cost.tiers.map((tier) => ({ ...tier })) }
			: {}),
	};
}

function hasNonZeroModelCost(cost: ChatModelConfig["cost"] | undefined): boolean {
	if (!cost) return false;
	return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
}

function getBuiltinCostIndex(): Map<string, ChatModelConfig["cost"]> {
	if (cachedBuiltinCostIndex) {
		return cachedBuiltinCostIndex;
	}
	const index = new Map<string, ChatModelConfig["cost"]>();
	try {
		const availableProviders = new Set<string>(getBuiltinProviders());
		for (const provider of PRICING_PROVIDER_PRIORITY) {
			if (!availableProviders.has(provider)) continue;
			const models = getBuiltinModels(provider as BuiltinProvider);
			for (const m of models) {
				const rawId = m.id.toLowerCase();
				if (rawId.includes(":batch") || rawId.endsWith("-batch")) continue;
				if (!hasNonZeroModelCost(m.cost)) continue;
				if (!index.has(rawId)) {
					index.set(rawId, m.cost);
				}
				const slashIdx = rawId.lastIndexOf("/");
				if (slashIdx !== -1 && slashIdx < rawId.length - 1) {
					const bareId = rawId.slice(slashIdx + 1);
					if (!index.has(bareId)) {
						index.set(bareId, m.cost);
					}
				}
			}
		}
	} catch {
		// 若上游 pi-ai 目录结构变化则安全回退至零费用，绝不阻塞模型注册
	}
	cachedBuiltinCostIndex = index;
	return index;
}

function buildPricingLookupCandidates(modelId: string, displayName?: string): string[] {
	const candidates: string[] = [];
	const push = (id: string) => {
		const normalized = id.trim().toLowerCase();
		if (normalized && !candidates.includes(normalized)) {
			candidates.push(normalized);
		}
	};

	const raw = modelId.trim().toLowerCase();
	const bases: string[] = [raw];

	// 去除 -thinking 尾缀（如 claude-opus-4-6-thinking -> claude-opus-4-6）
	if (raw.endsWith("-thinking") && raw.length > "-thinking".length) {
		bases.push(raw.slice(0, -"-thinking".length));
	}
	// 去除固定单档位后缀（如 gpt-oss-120b-medium -> gpt-oss-120b）
	const effortSplit = splitEffortSuffix(raw);
	if (effortSplit) {
		bases.push(effortSplit.baseId);
	}

	for (const base of bases) {
		push(base);
		// 点号/连字符版本互转（如 claude-sonnet-4.6 <-> claude-sonnet-4-6）
		const dashedVer = base.replace(/(\d)\.(\d)/g, "$1-$2");
		const dottedVer = base.replace(/-(\d+)-(\d+)(?=$|-)/g, "-$1.$2");
		push(dashedVer);
		push(dottedVer);
		if (!base.endsWith("-preview")) {
			push(`${base}-preview`);
		}
	}

	// Antigravity Orchestrator 封装项按底层对应代号匹配 Gemini 4 同级参考定价
	if (raw.includes("orchestrator")) {
		const hint = `${raw} ${(displayName ?? "").toLowerCase()}`;
		const flavorMatch = hint.match(/\b(neon|carbon|argon|hydrogen)\b/);
		if (flavorMatch) {
			push(`gemini-4-${flavorMatch[1]}`);
		} else {
			push("gemini-4-carbon");
		}
	}

	return candidates;
}

/**
 * 从 Pi 内置模型目录动态解析 Antigravity 模型对应的官方参考定价（美元/百万 Token，含缓存读写与阶梯价）。
 * 订阅制账号在 Pi 状态栏中会自动附加 `(sub)` 标记，并支持 `/model`、`/usage` 与缓存浪费统计展示。
 */
export function resolveBuiltinModelCost(
	modelId: string,
	displayName?: string,
): ChatModelConfig["cost"] {
	const index = getBuiltinCostIndex();
	for (const key of buildPricingLookupCandidates(modelId, displayName)) {
		const matched = index.get(key);
		if (matched) {
			return cloneModelCost(matched);
		}
	}
	return cloneModelCost(ZERO_MODEL_COST);
}

export interface DiscoveredCatalogSnapshot {
	version: 1;
	updatedAt: number;
	tier?: AcpTierInfo;
	models: ChatModelConfig[];
	modelEfforts: Record<string, EffortSuffix[]>;
}

/** 运行时从 usage_update.size 动态观测到的真实窗口上限表 */
const runtimeObservedWindows = new Map<string, number>();

/** 更新某模型在当前账号下实时回报的真实有效上下文窗口 */
export function recordObservedContextWindow(modelId: string, size: number | undefined): boolean {
	if (typeof size !== "number" || !Number.isFinite(size) || size < 16_000) {
		return false;
	}
	const rounded = Math.floor(size);
	if (runtimeObservedWindows.get(modelId) === rounded) {
		return false;
	}
	runtimeObservedWindows.set(modelId, rounded);
	return true;
}

export function getObservedContextWindow(modelId: string): number | undefined {
	return runtimeObservedWindows.get(modelId);
}

/** 按模型家族推断默认上下文窗口与最大输出 Token 规格 */
export function inferModelSpecs(modelId: string): {
	contextWindow: number;
	maxTokens: number;
	supportsImage: boolean;
} {
	const observed = runtimeObservedWindows.get(modelId);
	const lower = modelId.toLowerCase();

	if (lower.includes("gpt-oss")) {
		return {
			contextWindow: observed ?? 131_072,
			maxTokens: 16_384,
			supportsImage: false,
		};
	}
	if (lower.includes("claude-")) {
		return {
			contextWindow: observed ?? 1_000_000,
			maxTokens: 64_000,
			supportsImage: true,
		};
	}
	if (
		lower.includes("gemini-4-") ||
		lower.includes("gemini-3") ||
		lower.includes("orchestrator")
	) {
		return {
			contextWindow: observed ?? 1_048_576,
			maxTokens: 65_536,
			supportsImage: true,
		};
	}
	return {
		contextWindow: observed ?? 256_000,
		maxTokens: 32_768,
		supportsImage: true,
	};
}

/** 根据该模型实际支持的档位集合构建 Pi 原生 ThinkingLevelMap */
export function buildThinkingLevelMap(supportedEfforts: readonly string[]): ThinkingLevelMap {
	const allowed = new Set(supportedEfforts.map((e) => e.toLowerCase()));
	const map: ThinkingLevelMap = {
		minimal: allowed.has("minimal") ? "minimal" : null,
		low: allowed.has("low") ? "low" : null,
		medium: allowed.has("medium") ? "medium" : null,
		high: allowed.has("high") ? "high" : null,
		xhigh: allowed.has("xhigh") ? "xhigh" : null,
		max: allowed.has("max") ? "max" : null,
	};
	return map;
}

function splitEffortSuffix(
	modelId: string,
): { baseId: string; effort: EffortSuffix } | undefined {
	for (const suffix of EFFORT_SUFFIXES) {
		const token = `-${suffix}`;
		if (modelId.endsWith(token) && modelId.length > token.length) {
			return {
				baseId: modelId.slice(0, -token.length),
				effort: suffix,
			};
		}
	}
	return undefined;
}

function stripTrailingEffortDisplayLabel(displayName: string): string {
	return displayName.replace(/\s*\((Minimal|Low|Medium|High|XHigh|Extra|Max)\)\s*$/i, "").trim();
}

function makeChatModelConfig(
	id: string,
	name: string,
	efforts: EffortSuffix[],
): ChatModelConfig {
	const specs = inferModelSpecs(id);
	const hasReasoning = efforts.length > 0;
	return {
		type: "chat",
		id,
		name,
		api: ANTIGRAVITY_API_ID,
		baseUrl: ANTIGRAVITY_BASE_URL,
		reasoning: hasReasoning,
		thinkingLevelMap: hasReasoning ? buildThinkingLevelMap(efforts) : undefined,
		input: specs.supportsImage ? ["text", "image"] : ["text"],
		cost: resolveBuiltinModelCost(id, name),
		contextWindow: specs.contextWindow,
		maxTokens: specs.maxTokens,
	};
}

/**
 * 双轨聚合算法：融合 `models.availableModels`（展开后缀列表）与 `configOptions[id="model"]`（裸选择器项），
 * 生成清爽无重复的 Pi 模型目录及每个模型精确的 Thinking 档位集合。
 */
export function aggregateAcpModels(
	availableModels: readonly AcpAvailableModel[] = [],
	configOptions: readonly AcpConfigOption[] = [],
): {
	models: ChatModelConfig[];
	modelEfforts: Record<string, EffortSuffix[]>;
} {
	const modelConfigOpt = configOptions.find((opt) => opt.id === "model");
	const configIds = new Set<string>(
		(modelConfigOpt?.options ?? []).map((choice) => choice.value),
	);
	const configDisplayNames = new Map<string, string>(
		(modelConfigOpt?.options ?? []).map((choice) => [choice.value, choice.name]),
	);

	// 统计去掉档位后缀后的候选家族变体
	const groupedByBase = new Map<
		string,
		Array<{ raw: AcpAvailableModel; effort: EffortSuffix }>
	>();
	for (const item of availableModels) {
		const split = splitEffortSuffix(item.modelId);
		if (!split) continue;
		const list = groupedByBase.get(split.baseId) ?? [];
		list.push({ raw: item, effort: split.effort });
		groupedByBase.set(split.baseId, list);
	}

	const models: ChatModelConfig[] = [];
	const modelEfforts: Record<string, EffortSuffix[]> = {};
	const emittedIds = new Set<string>();

	const registerEntry = (id: string, name: string, rawEfforts: Iterable<EffortSuffix>) => {
		if (emittedIds.has(id)) return;
		emittedIds.add(id);
		const set = new Set(rawEfforts);
		const ordered = EFFORT_ORDER.filter((e) => set.has(e));
		modelEfforts[id] = ordered;
		models.push(makeChatModelConfig(id, name, ordered));
	};

	// 优先遵循 configOptions[id="model"] 的官方顺序
	if (modelConfigOpt?.options && modelConfigOpt.options.length > 0) {
		for (const choice of modelConfigOpt.options) {
			const id = choice.value;
			const variants = groupedByBase.get(id);
			if (variants && variants.length > 0) {
				registerEntry(
					id,
					choice.name || stripTrailingEffortDisplayLabel(variants[0].raw.name),
					variants.map((v) => v.effort),
				);
				continue;
			}

			// 固定单档位模型（例如 gpt-oss-120b-medium 或 gemini-pro-orchestrator）
			const selfSplit = splitEffortSuffix(id);
			if (selfSplit && !configIds.has(selfSplit.baseId)) {
				registerEntry(id, choice.name || id, [selfSplit.effort]);
			} else {
				// 若该裸模型在 availableModels 中无展开变体，检查当前默认 thought_level 选项
				const currentThoughtOpt = configOptions.find((opt) => opt.id === "thought_level");
				const fallbackEfforts =
					modelConfigOpt.currentValue === id && currentThoughtOpt?.options
						? currentThoughtOpt.options
								.map((o) => o.value as EffortSuffix)
								.filter((v): v is EffortSuffix =>
									(EFFORT_SUFFIXES as readonly string[]).includes(v),
								)
						: [];
				registerEntry(id, choice.name || id, fallbackEfforts);
			}
		}
	}

	// 补充仅出现在 availableModels 中的条目（兼容仅返回后缀 ID 的渠道）
	for (const item of availableModels) {
		if (emittedIds.has(item.modelId)) continue;
		const split = splitEffortSuffix(item.modelId);
		if (split) {
			const siblings = groupedByBase.get(split.baseId) ?? [];
			const shouldAggregate = configIds.has(split.baseId) || siblings.length >= 2;
			if (shouldAggregate) {
				if (!emittedIds.has(split.baseId)) {
					const displayName =
						configDisplayNames.get(split.baseId) ||
						stripTrailingEffortDisplayLabel(item.name) ||
						split.baseId;
					registerEntry(
						split.baseId,
						displayName,
						siblings.map((s) => s.effort),
					);
				}
				continue;
			}
			registerEntry(item.modelId, item.name || item.modelId, [split.effort]);
		} else {
			registerEntry(item.modelId, item.name || item.modelId, []);
		}
	}

	return { models, modelEfforts };
}

/** 离线首次启动时的保守种子模型目录 */
export function getSeedModels(): ChatModelConfig[] {
	return [
		makeChatModelConfig("gemini-4-neon", "Gemini 4 Neon", ["low", "medium", "high", "xhigh"]),
		makeChatModelConfig("gemini-4-carbon", "Gemini 4 Carbon", ["low", "medium", "high"]),
		makeChatModelConfig("gemini-3.8-flash", "Gemini 3.8 Flash", ["low", "medium", "high"]),
		makeChatModelConfig("claude-sonnet-5-5", "Claude Sonnet 5.5", ["low", "medium", "high"]),
		makeChatModelConfig("claude-opus-5-5", "Claude Opus 5.5", ["low", "medium", "high"]),
	];
}

/** 读取磁盘缓存的模型探测快照 */
export function readCachedCatalog(env: NodeJS.ProcessEnv = process.env): DiscoveredCatalogSnapshot | undefined {
	try {
		const cachePath = resolveModelCachePath(env);
		if (!fs.existsSync(cachePath)) return undefined;
		const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as DiscoveredCatalogSnapshot;
		if (raw?.version === 1 && Array.isArray(raw.models) && raw.models.length > 0) {
			// 应用最新观测到的窗口校准，并为旧版零费用缓存自动补全 Pi 内置目录参考定价
			const calibrated = raw.models.map((m) => ({
				...m,
				cost: hasNonZeroModelCost(m.cost) ? m.cost : resolveBuiltinModelCost(m.id, m.name),
				contextWindow: getObservedContextWindow(m.id) ?? m.contextWindow,
			}));
			return { ...raw, models: calibrated };
		}
	} catch {
		// 忽略损坏缓存
	}
	return undefined;
}

/** 将最新探测到的模型快照持久化至缓存目录 */
export function writeCachedCatalog(
	snapshot: DiscoveredCatalogSnapshot,
	env: NodeJS.ProcessEnv = process.env,
): void {
	try {
		const cachePath = resolveModelCachePath(env);
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
	} catch {
		// 忽略只读文件系统异常
	}
}

const CATALOG_FRESH_TTL_MS = 15_000;
const liveProbeStateByCachePath = new Map<
	string,
	{
		inFlight?: Promise<DiscoveredCatalogSnapshot>;
		lastSnapshot?: DiscoveredCatalogSnapshot;
		lastAt: number;
	}
>();

function raceCatalogProbeWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		return Promise.reject(signal.reason ?? new Error("Model discovery cancelled"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(signal.reason ?? new Error("Model discovery cancelled"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

/**
 * 清理指定会话（如零消息探针或分叉失败副本）的 SQLite 数据库文件。
 * 支持延时异步重试，兼容 Windows 下 `agy acp --worker` 退出前短暂持有文件句柄的场景。
 */
export function removeEmptyProbeSessionFiles(config: BridgeConfig, sessionId: string): void {
	if (!sessionId) return;
	const convDir = resolveAgyConversationsDir(config);
	const tryRemove = (): boolean => {
		let allGone = true;
		for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal"]) {
			const target = path.join(convDir, `${sessionId}${suffix}`);
			try {
				if (fs.existsSync(target)) {
					fs.unlinkSync(target);
				}
			} catch {
				allGone = false;
			}
		}
		return allGone;
	};

	if (!tryRemove()) {
		setTimeout(() => {
			if (!tryRemove()) {
				setTimeout(() => {
					tryRemove();
				}, 1_200).unref();
			}
		}, 600).unref();
	}
}

export interface ProbeCatalogOptions {
	signal?: AbortSignal;
	force?: boolean;
	/** 可选环境变量覆盖（主要用于隔离模型缓存写入目录，避免测试覆写用户全局缓存） */
	env?: NodeJS.ProcessEnv;
}

/**
 * 在线零配额探测当前账号可用的 AGY 模型与订阅层级。
 * 内置 Singleflight 并发合并与短时新鲜度缓存，彻底杜绝并发刷新产生多个孤儿 worker 与空数据库文件。
 */
export async function probeLiveAntigravityCatalog(
	processManager: AcpProcessManager,
	config: BridgeConfig,
	cwd: string,
	signalOrOptions?: AbortSignal | ProbeCatalogOptions,
): Promise<DiscoveredCatalogSnapshot> {
	const opts: ProbeCatalogOptions =
		signalOrOptions && "aborted" in signalOrOptions
			? { signal: signalOrOptions }
			: (signalOrOptions ?? {});

	if (opts.signal?.aborted) {
		throw opts.signal.reason ?? new Error("Model discovery cancelled");
	}

	const cacheKey = resolveModelCachePath(opts.env);
	let state = liveProbeStateByCachePath.get(cacheKey);
	if (
		!opts.force &&
		state?.lastSnapshot &&
		Date.now() - state.lastAt < CATALOG_FRESH_TTL_MS
	) {
		return state.lastSnapshot;
	}

	if (!state) {
		state = { lastAt: 0 };
		liveProbeStateByCachePath.set(cacheKey, state);
	}

	let inFlight = state.inFlight;
	if (!inFlight) {
		const targetState = state;
		inFlight = (async () => {
			const conn = await processManager.acquire(config, undefined);
			const sessionRes = await conn.request<AcpSessionNewResult>(
				"session/new",
				{
					cwd,
					mcpServers: [],
				},
				{ timeoutMs: 20_000 },
			);

			try {
				const { models, modelEfforts } = aggregateAcpModels(
					sessionRes.models?.availableModels ?? [],
					sessionRes.configOptions ?? [],
				);
				const snapshot: DiscoveredCatalogSnapshot = {
					version: 1,
					updatedAt: Date.now(),
					tier: sessionRes._meta?.antigravity?.tier,
					models: models.length > 0 ? models : getSeedModels(),
					modelEfforts,
				};
				writeCachedCatalog(snapshot, opts.env);
				targetState.lastSnapshot = snapshot;
				targetState.lastAt = Date.now();
				return snapshot;
			} finally {
				if (sessionRes.sessionId) {
					await conn.closeSessionSafe(sessionRes.sessionId);
					removeEmptyProbeSessionFiles(config, sessionRes.sessionId);
				}
			}
		})().finally(() => {
			targetState.inFlight = undefined;
		});
		targetState.inFlight = inFlight;
	}

	return raceCatalogProbeWithSignal(inFlight, opts.signal);
}

export interface ResolvedModelSelection {
	/** 传给 configId="model" 的目标模型值 */
	configModelValue: string;
	/** 若使用裸模型 ID + thought_level，则需要同步设定的档位值 */
	configThoughtLevel?: string;
	/** 记录至 AssistantMessage.providerThinkingLevel 的实际生效档位 */
	effectiveEffort?: string;
}

/**
 * 根据用户在 Pi 中选择的模型 ID 与推理档位（`options.reasoning`），
 * 结合当前 ACP 会话实际通告的 `configOptions` 与 `availableModels` 计算精确下发指令。
 */
export function resolveSessionModelSelection(
	requestedModelId: string,
	requestedReasoning: ThinkingLevel | undefined,
	configOptions: readonly AcpConfigOption[] = [],
	availableModels: readonly AcpAvailableModel[] = [],
): ResolvedModelSelection {
	const modelOpt = configOptions.find((o) => o.id === "model");
	const configValues = new Set((modelOpt?.options ?? []).map((c) => c.value));
	const availableIds = new Set(availableModels.map((m) => m.modelId));

	// 收集该模型可用的后缀变体
	const variantEfforts: EffortSuffix[] = [];
	for (const suffix of EFFORT_ORDER) {
		if (availableIds.has(`${requestedModelId}-${suffix}`)) {
			variantEfforts.push(suffix);
		}
	}

	const pickBestEffort = (candidates: readonly string[]): string | undefined => {
		if (candidates.length === 0) return undefined;
		if (requestedReasoning && candidates.includes(requestedReasoning)) {
			return requestedReasoning;
		}
		if (!requestedReasoning) {
			// 用户在 Pi 设为 off 时回退至最低可用档位或默认档位
			if (candidates.includes("low")) return "low";
			return candidates[0];
		}
		// 按档位邻近度就近回退
		const targetIdx = EFFORT_ORDER.indexOf(requestedReasoning as EffortSuffix);
		if (targetIdx !== -1) {
			for (let i = targetIdx; i >= 0; i--) {
				if (candidates.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
			}
			for (let i = targetIdx + 1; i < EFFORT_ORDER.length; i++) {
				if (candidates.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
			}
		}
		return candidates[0];
	};

	// 路径 1：configOptions 包含裸模型 ID（标准双阶段下发）
	if (configValues.has(requestedModelId)) {
		const selfSuffix = splitEffortSuffix(requestedModelId);
		if (selfSuffix && variantEfforts.length === 0) {
			return {
				configModelValue: requestedModelId,
				effectiveEffort: selfSuffix.effort,
			};
		}
		const chosenEffort = pickBestEffort(variantEfforts);
		return {
			configModelValue: requestedModelId,
			configThoughtLevel: chosenEffort ?? requestedReasoning,
			effectiveEffort: chosenEffort ?? requestedReasoning,
		};
	}

	// 路径 2：服务端仅通告后缀展开模型 ID（回退为 ${modelId}-${effort}）
	const chosenEffort = pickBestEffort(variantEfforts) ?? requestedReasoning;
	if (chosenEffort) {
		const suffixed = `${requestedModelId}-${chosenEffort}`;
		if (configValues.has(suffixed) || availableIds.has(suffixed) || configValues.size === 0) {
			return {
				configModelValue: suffixed,
				effectiveEffort: chosenEffort,
			};
		}
	}

	return {
		configModelValue: requestedModelId,
		configThoughtLevel: requestedReasoning,
		effectiveEffort: requestedReasoning,
	};
}
