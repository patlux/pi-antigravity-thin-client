import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enforceThinClientPolicy } from "./thin-client-policy.ts";

/** 工具系统主控模式 */
export type ToolMode = "pi-tools" | "agy-tools" | "hybrid";

/** 三态布尔配置：显式开启、显式关闭或跟随当前工具模式默认值 */
export type AutoBoolean = boolean | "auto";

/** 模式 A / Hybrid 下桥接 Pi MCP 的传输策略 */
export type PiMcpBridgeStrategy = "via-host" | "direct-config";

/** AGY 原生执行权限策略（对应 ACP configId="mode"） */
export type AgyExecutionMode = "default" | "accept-edits" | "plan" | "auto";

/** 公开配置文件与内存态完整配置结构 */
export interface BridgeConfig {
	/** 工具系统主控模式 */
	toolMode: ToolMode;
	/** 是否将 Pi 的 MCP 工具与说明桥接给 AGY */
	bridgePiMcp: AutoBoolean;
	/** 是否将 Pi 的 Skills 列表与目录桥接给 AGY */
	bridgePiSkills: AutoBoolean;
	/** 是否将 Pi 的 AGENTS.md / CLAUDE.md 上下文规则桥接给 AGY */
	bridgePiAgentsMd: AutoBoolean;
	/** 在 agy-tools / hybrid 模式下桥接 Pi MCP 的实现方式 */
	piMcpBridgeStrategy: PiMcpBridgeStrategy;
	/** 是否允许 AGY 继承其自身的全局与工作区 Customizations */
	agyInheritCustomizations: AutoBoolean;
	/** 是否允许 AGY 继承其自身的 mcp_config.json */
	agyInheritMcp: AutoBoolean;
	/** 是否将本机 AGY 的通用 Skills 反向发现并注册到 Pi */
	shareAgySkillsToPi: boolean;
	/** AGY 原生执行模式 */
	agyExecutionMode: AgyExecutionMode;
	/** 在 agy-tools / hybrid 模式下可选指定的自定义 Agent 名称 */
	agyCustomAgent?: string;
	/** 是否启用 --process-per-session 以开启原生 HTTP MCP 隔离进程 */
	processPerSession: boolean;
	/** 是否启用基于 node:sqlite 的会话只读快照分叉加速 */
	enableSqliteFork: boolean;
	/** 是否启用 AGY 终端沙箱 (--sandbox) */
	sandbox: boolean;
	/** MCP 工具调用预取消剥离阈值（毫秒，需小于 AGY 180000ms 硬上限） */
	mcpHoldLimitMs: number;
	/**
	 * Fork: minutes without activity after which the agy process of a Pi session stops
	 * (src/session/idle-release.ts); 0 keeps it running. The next typed prompt continues
	 * the same conversation.
	 */
	idleReleaseMinutes: number;
	/** 自定义 agy 可执行文件路径 */
	agyBin?: string;
	/** 自定义 Gemini 根目录（默认 ~/.gemini） */
	geminiDir: string;
	/** 应用数据子目录名（默认 antigravity-cli） */
	appDataDirName: string;
}

/** 根据当前模式计算完毕的确定性运行时开关 */
export interface EffectiveBridgeFlags {
	toolMode: ToolMode;
	bridgePiMcp: boolean;
	bridgePiSkills: boolean;
	bridgePiAgentsMd: boolean;
	agyInheritCustomizations: boolean;
	agyInheritMcp: boolean;
}

/** 默认公开配置（默认启用 pi-tools 纯净模式，提供一致的 Pi 原生工具体验） */
export const DEFAULT_BRIDGE_CONFIG: Readonly<BridgeConfig> = {
	toolMode: "pi-tools",
	bridgePiMcp: "auto",
	bridgePiSkills: "auto",
	bridgePiAgentsMd: "auto",
	piMcpBridgeStrategy: "via-host",
	agyInheritCustomizations: "auto",
	agyInheritMcp: "auto",
	shareAgySkillsToPi: false,
	agyExecutionMode: "default",
	processPerSession: true,
	enableSqliteFork: true,
	sandbox: false,
	mcpHoldLimitMs: 165_000,
	idleReleaseMinutes: 30,
	geminiDir: path.join(os.homedir(), ".gemini"),
	appDataDirName: "antigravity-cli",
};

const VALID_TOOL_MODES = new Set<ToolMode>(["pi-tools", "agy-tools", "hybrid"]);
const VALID_STRATEGIES = new Set<PiMcpBridgeStrategy>(["via-host", "direct-config"]);
const VALID_EXEC_MODES = new Set<AgyExecutionMode>(["default", "accept-edits", "plan", "auto"]);

/** 解析 Pi 全局 Agent 配置目录（遵循 PI_CODING_AGENT_DIR 覆盖约定） */
export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const custom = env.PI_CODING_AGENT_DIR?.trim();
	if (custom) {
		return expandHomeDir(custom);
	}
	return path.join(os.homedir(), ".pi", "agent");
}

/** 解析用户主目录前缀 `~` */
export function expandHomeDir(inputPath: string): string {
	const trimmed = inputPath.trim();
	if (trimmed === "~") {
		return os.homedir();
	}
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return path.join(os.homedir(), trimmed.slice(2));
	}
	return path.resolve(trimmed);
}

/** 解析三态布尔值（支持 boolean 及字符串 "true"/"false"/"on"/"off"/"1"/"0"/"auto"） */
export function parseAutoBoolean(value: unknown, fallback: AutoBoolean): AutoBoolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "auto") return "auto";
		if (normalized === "true" || normalized === "on" || normalized === "1") return true;
		if (normalized === "false" || normalized === "off" || normalized === "0") return false;
	}
	return fallback;
}

function parseStrictBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "on" || normalized === "1") return true;
		if (normalized === "false" || normalized === "off" || normalized === "0") return false;
	}
	return fallback;
}

/** Whole minutes from 0 (never stop) to one day; anything else keeps `fallback`. */
function parseIdleReleaseMinutes(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return fallback;
	}
	return Math.min(24 * 60, Math.floor(value));
}

function readJsonFileSafe(filePath: string): Record<string, unknown> | undefined {
	try {
		if (!fs.existsSync(filePath)) {
			return undefined;
		}
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// 忽略损坏或不可读的配置文件，保持回退默认值稳定可用
	}
	return undefined;
}

function applyRawConfigObject(base: BridgeConfig, raw: Record<string, unknown>): BridgeConfig {
	const next: BridgeConfig = { ...base };

	if (typeof raw.toolMode === "string" && VALID_TOOL_MODES.has(raw.toolMode as ToolMode)) {
		next.toolMode = raw.toolMode as ToolMode;
	}
	next.bridgePiMcp = parseAutoBoolean(raw.bridgePiMcp, next.bridgePiMcp);
	next.bridgePiSkills = parseAutoBoolean(raw.bridgePiSkills, next.bridgePiSkills);
	next.bridgePiAgentsMd = parseAutoBoolean(raw.bridgePiAgentsMd, next.bridgePiAgentsMd);

	if (
		typeof raw.piMcpBridgeStrategy === "string" &&
		VALID_STRATEGIES.has(raw.piMcpBridgeStrategy as PiMcpBridgeStrategy)
	) {
		next.piMcpBridgeStrategy = raw.piMcpBridgeStrategy as PiMcpBridgeStrategy;
	}

	next.agyInheritCustomizations = parseAutoBoolean(
		raw.agyInheritCustomizations,
		next.agyInheritCustomizations,
	);
	next.agyInheritMcp = parseAutoBoolean(raw.agyInheritMcp, next.agyInheritMcp);
	next.shareAgySkillsToPi = parseStrictBoolean(raw.shareAgySkillsToPi, next.shareAgySkillsToPi);

	if (
		typeof raw.agyExecutionMode === "string" &&
		VALID_EXEC_MODES.has(raw.agyExecutionMode as AgyExecutionMode)
	) {
		next.agyExecutionMode = raw.agyExecutionMode as AgyExecutionMode;
	}

	if (typeof raw.agyCustomAgent === "string" && raw.agyCustomAgent.trim().length > 0) {
		next.agyCustomAgent = raw.agyCustomAgent.trim();
	}

	next.processPerSession = parseStrictBoolean(raw.processPerSession, next.processPerSession);
	next.enableSqliteFork = parseStrictBoolean(raw.enableSqliteFork, next.enableSqliteFork);
	next.sandbox = parseStrictBoolean(raw.sandbox, next.sandbox);

	if (typeof raw.mcpHoldLimitMs === "number" && Number.isFinite(raw.mcpHoldLimitMs)) {
		// 限制在 5 秒至 175 秒之间，确保早于 AGY 180 秒硬超时触发安全剥离
		next.mcpHoldLimitMs = Math.max(5_000, Math.min(175_000, Math.floor(raw.mcpHoldLimitMs)));
	}
	next.idleReleaseMinutes = parseIdleReleaseMinutes(raw.idleReleaseMinutes, next.idleReleaseMinutes);

	if (typeof raw.agyBin === "string" && raw.agyBin.trim().length > 0) {
		next.agyBin = expandHomeDir(raw.agyBin);
	}
	if (typeof raw.geminiDir === "string" && raw.geminiDir.trim().length > 0) {
		next.geminiDir = expandHomeDir(raw.geminiDir);
	}
	if (typeof raw.appDataDirName === "string" && raw.appDataDirName.trim().length > 0) {
		next.appDataDirName = raw.appDataDirName.trim();
	}

	return next;
}

export interface LoadBridgeConfigOptions {
	cwd?: string;
	isProjectTrusted?: boolean;
	env?: NodeJS.ProcessEnv;
}

/**
 * 加载完整桥接配置。
 * 优先级：公开环境变量 > 受信项目配置 (.pi/antigravity.json) > 用户全局配置 (~/.pi/agent/antigravity.json) > 默认值。
 */
export function loadBridgeConfig(options: LoadBridgeConfigOptions = {}): BridgeConfig {
	const env = options.env ?? process.env;
	const piAgentDir = resolvePiAgentDir(env);
	let config: BridgeConfig = {
		...DEFAULT_BRIDGE_CONFIG,
		geminiDir: path.join(os.homedir(), ".gemini"),
	};

	const globalConfigPath = path.join(piAgentDir, "antigravity.json");
	const globalRaw = readJsonFileSafe(globalConfigPath);
	if (globalRaw) {
		config = applyRawConfigObject(config, globalRaw);
	}

	if (options.isProjectTrusted && options.cwd) {
		const projectConfigPath = path.join(options.cwd, ".pi", "antigravity.json");
		const projectRaw = readJsonFileSafe(projectConfigPath);
		if (projectRaw) {
			config = applyRawConfigObject(config, projectRaw);
		}
	}

	// 应用公开环境变量覆盖
	if (env.PI_AGY_BIN?.trim()) {
		config.agyBin = expandHomeDir(env.PI_AGY_BIN);
	}
	if (env.PI_AGY_IDLE_RELEASE_MINUTES?.trim()) {
		config.idleReleaseMinutes = parseIdleReleaseMinutes(
			Number(env.PI_AGY_IDLE_RELEASE_MINUTES),
			config.idleReleaseMinutes,
		);
	}
	if (env.PI_AGY_GEMINI_DIR?.trim()) {
		config.geminiDir = expandHomeDir(env.PI_AGY_GEMINI_DIR);
	}
	const envMode = env.PI_AGY_TOOL_MODE?.trim() as ToolMode | undefined;
	if (envMode && VALID_TOOL_MODES.has(envMode)) {
		config.toolMode = envMode;
	}
	if (env.PI_AGY_BRIDGE_MCP !== undefined) {
		config.bridgePiMcp = parseAutoBoolean(env.PI_AGY_BRIDGE_MCP, config.bridgePiMcp);
	}
	if (env.PI_AGY_BRIDGE_SKILLS !== undefined) {
		config.bridgePiSkills = parseAutoBoolean(env.PI_AGY_BRIDGE_SKILLS, config.bridgePiSkills);
	}
	if (env.PI_AGY_BRIDGE_AGENTS_MD !== undefined) {
		config.bridgePiAgentsMd = parseAutoBoolean(
			env.PI_AGY_BRIDGE_AGENTS_MD,
			config.bridgePiAgentsMd,
		);
	}

	return enforceThinClientPolicy(config);
}

/** 将用户对配置的持久化修改写回全局配置文件 `~/.pi/agent/antigravity.json` */
export function saveGlobalBridgeConfigPatch(
	patch: Partial<BridgeConfig>,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const piAgentDir = resolvePiAgentDir(env);
	const filePath = path.join(piAgentDir, "antigravity.json");
	const existing = readJsonFileSafe(filePath) ?? {};
	const merged = { ...existing, ...patch };
	fs.mkdirSync(piAgentDir, { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

/** 根据当前 `toolMode` 计算 `"auto"` 选项的实际生效布尔值 */
export function resolveEffectiveFlags(rawConfig: BridgeConfig): EffectiveBridgeFlags {
	const config = enforceThinClientPolicy(rawConfig);
	const isPiTools = config.toolMode === "pi-tools";
	return {
		toolMode: config.toolMode,
		bridgePiMcp: config.bridgePiMcp === "auto" ? isPiTools : config.bridgePiMcp,
		bridgePiSkills: config.bridgePiSkills === "auto" ? isPiTools : config.bridgePiSkills,
		bridgePiAgentsMd: config.bridgePiAgentsMd === "auto" ? isPiTools : config.bridgePiAgentsMd,
		agyInheritCustomizations:
			config.agyInheritCustomizations === "auto" ? !isPiTools : config.agyInheritCustomizations,
		agyInheritMcp: config.agyInheritMcp === "auto" ? !isPiTools : config.agyInheritMcp,
	};
}

/** 获取 AGY 应用数据目录（默认 `~/.gemini/antigravity-cli`） */
export function resolveAgyAppDataDir(config: BridgeConfig): string {
	return path.join(config.geminiDir, config.appDataDirName);
}

/** 获取 AGY 会话 SQLite 存储目录（默认 `~/.gemini/antigravity-cli/conversations`） */
export function resolveAgyConversationsDir(config: BridgeConfig): string {
	return path.join(resolveAgyAppDataDir(config), "conversations");
}

/** 获取模型探测本地缓存文件路径（`~/.pi/agent/cache/antigravity-models.json`） */
export function resolveModelCachePath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(resolvePiAgentDir(env), "cache", "antigravity-models.json");
}
