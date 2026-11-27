import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { BridgeConfig } from "../config.ts";
import { resolveEffectiveFlags } from "../config.ts";
import { buildAgySpawnSpec, type ResolvedBinary, resolveAgyBinary } from "./binary-resolver.ts";
import {
	type AcpElicitationCreateParams,
	type AcpElicitationCreateResult,
	type AcpInitializeResult,
	type AcpRequestPermissionParams,
	type AcpRequestPermissionResult,
	type AcpSessionUpdateNotification,
	type JsonRpcErrorObject,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
	NdjsonLineParser,
} from "./protocol.ts";

function readPackageVersion(): string {
	try {
		const raw = fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
			return parsed.version.trim();
		}
	} catch {
		// 忽略读取异常，回退默认版本号
	}
	return "0.1.10";
}

export const BRIDGE_AGENT_NAME = "pi-bridge";
// Thin-client fork: report this package honestly, not the upstream name.
export const CLIENT_INFO_NAME = "pi-antigravity-thin-client";
export const CLIENT_INFO_VERSION = readPackageVersion();
/** Allow up to 90s for cold ~1 GB PyInstaller runtime extraction before failing initialize. */
export const INITIALIZE_TIMEOUT_MS = 90_000;
const SAFE_SESSION_ID_RE = /^[\w-]+$/;

export class AcpRpcError extends Error {
	readonly code: number;
	readonly data?: unknown;

	constructor(err: JsonRpcErrorObject) {
		super(err.message || `ACP RPC error (${err.code})`);
		this.name = "AcpRpcError";
		this.code = err.code;
		this.data = err.data;
	}
}

/** 单个 `agy acp` 进程的配置特征描述 */
export interface AcpProcessProfile {
	/** 用户显式指定的原生自定义 Agent 名称 */
	userAgentName?: string;
	/** 是否清空内置工具以由宿主 MCP 工具主控（对应 pi-tools 模式） */
	disableBuiltinTools: boolean;
	/** 是否排除 AGY 内置默认系统组件以保持纯净底座（对应 pi-tools 模式） */
	excludeDefaultComponents: boolean;
	/** 是否继承 AGY 自身的全局与工作区 Customizations */
	inheritCustomizations: boolean;
	/** 是否继承 AGY 自身的 mcp_config.json */
	inheritMcp: boolean;
	/** 通过官方 Plugin 机制挂载的外部 Customization 插件目录列表 */
	mountedPluginPaths: string[];
	/** 是否包含 AGY 内置默认 Customizations */
	includeDefaultCustomizations: boolean;
	/** 是否开启每会话独立 Worker 进程（支持 HTTP MCP） */
	processPerSession: boolean;
	/** 是否启用终端沙箱 */
	sandbox: boolean;
	/** 自定义 Gemini 目录 */
	geminiDir: string;
	/** 应用数据目录名 */
	appDataDirName: string;
}

export interface AcpServerHandlers {
	onSessionUpdate?: (notification: AcpSessionUpdateNotification) => void;
	onRequestPermission?: (
		params: AcpRequestPermissionParams,
	) => Promise<AcpRequestPermissionResult>;
	onElicitationCreate?: (
		params: AcpElicitationCreateParams,
	) => Promise<AcpElicitationCreateResult>;
}

interface PendingRpc {
	method: string;
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	timer?: ReturnType<typeof setTimeout>;
	cleanupAbort?: () => void;
}

/** 读取用户在 `<geminiDir>/config/agents/` 中显式配置的自定义 Agent 文件（若存在），以便在附加挂载插件时完整保留其定义 */
function readUserCustomAgentFile(
	geminiDir: string,
	userAgentName: string,
): { frontmatterLines: string[]; body: string } | undefined {
	const candidates = [
		path.join(geminiDir, "config", "agents", userAgentName, "agent.md"),
		path.join(geminiDir, "config", "agents", `${userAgentName}.md`),
	];
	for (const candidate of candidates) {
		try {
			if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
			const raw = fs.readFileSync(candidate, "utf8");
			const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
			if (fmMatch) {
				const lines = fmMatch[1].split(/\r?\n/);
				return { frontmatterLines: lines, body: fmMatch[2] };
			}
			return { frontmatterLines: [], body: raw };
		} catch {
			// 读取失败则继续检查下一候选路径
		}
	}
	return undefined;
}

/** 从已有 YAML frontmatter 行中剔除指定顶层键（含多行列表值）以便安全合并挂载覆盖项 */
function stripYamlTopLevelKeys(lines: readonly string[], keysToRemove: ReadonlySet<string>): string[] {
	const kept: string[] = [];
	let skippingBlock = false;
	for (const line of lines) {
		const isTopLevel = line.length > 0 && !/^\s/.test(line) && !line.startsWith("#");
		if (isTopLevel) {
			const colonIdx = line.indexOf(":");
			const key = colonIdx !== -1 ? line.slice(0, colonIdx).trim() : "";
			if (keysToRemove.has(key)) {
				skippingBlock = true;
				continue;
			}
			skippingBlock = false;
		}
		if (!skippingBlock) {
			kept.push(line);
		}
	}
	return kept;
}

/**
 * 判断该进程配置是否需要生成纯 YAML Frontmatter 的轻量挂载 Agent 文件。
 * Markdown 正文严格保持为空（仅在合并用户显式指定的 `agyCustomAgent` 时原样保留用户自定义文件内容），绝不覆写或注入任何系统提示词。
 */
function resolveManagedAgentMaterialization(
	profile: AcpProcessProfile,
): { effectiveAgentName?: string; managedAgentDir?: string } {
	if (
		profile.userAgentName &&
		!profile.disableBuiltinTools &&
		!profile.excludeDefaultComponents &&
		profile.inheritCustomizations &&
		profile.inheritMcp &&
		profile.mountedPluginPaths.length === 0
	) {
		return { effectiveAgentName: profile.userAgentName };
	}

	const needsManagedAgent =
		profile.disableBuiltinTools ||
		profile.excludeDefaultComponents ||
		!profile.inheritCustomizations ||
		!profile.inheritMcp ||
		profile.mountedPluginPaths.length > 0;

	if (!needsManagedAgent) {
		return { effectiveAgentName: profile.userAgentName };
	}

	const userCustomAgent =
		profile.userAgentName && !profile.disableBuiltinTools
			? readUserCustomAgentFile(profile.geminiDir, profile.userAgentName)
			: undefined;

	const specHash = crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				userAgentName: profile.userAgentName ?? "",
				userAgentBodyHash: userCustomAgent
					? crypto
							.createHash("sha256")
							.update(userCustomAgent.frontmatterLines.join("\n") + "\n---\n" + userCustomAgent.body)
							.digest("hex")
							.slice(0, 12)
					: "",
				disableBuiltinTools: profile.disableBuiltinTools,
				excludeDefaultComponents: profile.excludeDefaultComponents,
				inheritCustomizations: profile.inheritCustomizations,
				inheritMcp: profile.inheritMcp,
				mountedPluginPaths: profile.mountedPluginPaths,
				agentSchemaRev: 2,
			}),
		)
		.digest("hex")
		.slice(0, 10);

	const agentName =
		!profile.userAgentName &&
		profile.disableBuiltinTools &&
		profile.excludeDefaultComponents &&
		!profile.inheritCustomizations &&
		!profile.inheritMcp &&
		profile.mountedPluginPaths.length === 0
			? BRIDGE_AGENT_NAME
			: `${BRIDGE_AGENT_NAME}-${specHash}`;

	const agentDir = path.join(profile.geminiDir, "config", "agents", agentName);
	const agentFile = path.join(agentDir, "agent.md");

	let desired: string;
	if (userCustomAgent) {
		const keysToReplace = new Set<string>(["name"]);
		if (!profile.inheritCustomizations) keysToReplace.add("inheritCustomizations");
		if (!profile.inheritMcp) keysToReplace.add("inheritMcp");
		if (profile.mountedPluginPaths.length > 0) keysToReplace.add("plugins");

		const mergedLines = [
			"---",
			`name: ${agentName}`,
			...stripYamlTopLevelKeys(userCustomAgent.frontmatterLines, keysToReplace),
		];
		if (!profile.inheritCustomizations) {
			mergedLines.push("inheritCustomizations: false");
		}
		if (!profile.inheritMcp) {
			mergedLines.push("inheritMcp: false");
		}
		if (profile.mountedPluginPaths.length > 0) {
			mergedLines.push("plugins:");
			for (const pluginPath of profile.mountedPluginPaths) {
				mergedLines.push(`  - ${JSON.stringify(pluginPath)}`);
			}
		}
		mergedLines.push("---");
		desired = userCustomAgent.body
			? `${mergedLines.join("\n")}\n${userCustomAgent.body}`
			: `${mergedLines.join("\n")}\n`;
	} else {
		const yamlLines: string[] = [
			"---",
			`name: ${agentName}`,
			"description: Configuration and customization mount profile for Pi Antigravity Bridge.",
			"mainAgent: true",
			"subagent: false",
		];

		if (profile.disableBuiltinTools) {
			yamlLines.push(
				"tools: []",
				"disabledTools:",
				"  - list_resources",
				"  - read_resource",
				"  - manage_task",
			);
		}
		if (profile.excludeDefaultComponents) {
			yamlLines.push("excludeDefaultComponents: true");
		}
		if (!profile.inheritCustomizations) {
			yamlLines.push("inheritCustomizations: false");
		}
		if (!profile.inheritMcp) {
			yamlLines.push("inheritMcp: false");
		}
		if (profile.mountedPluginPaths.length > 0) {
			yamlLines.push("plugins:");
			for (const pluginPath of profile.mountedPluginPaths) {
				yamlLines.push(`  - ${JSON.stringify(pluginPath)}`);
			}
		}
		yamlLines.push("---", "");
		desired = yamlLines.join("\n");
	}
	if (agentName === BRIDGE_AGENT_NAME) {
		try {
			const bundledAssetPath = path.resolve(
				path.dirname(fileURLToPath(import.meta.url)),
				"..",
				"..",
				"assets",
				"agents",
				"pi-bridge.md",
			);
			if (fs.existsSync(bundledAssetPath)) {
				desired = fs.readFileSync(bundledAssetPath, "utf8");
			}
		} catch {
			// 回退内存生成的同构 YAML
		}
	}

	const agentsRoot = path.join(profile.geminiDir, "config", "agents");
	try {
		if (!fs.existsSync(agentFile) || fs.readFileSync(agentFile, "utf8") !== desired) {
			fs.mkdirSync(agentDir, { recursive: true });
			fs.writeFileSync(agentFile, desired, "utf8");
		} else {
			// 刷新目录修改时间供惰性 LRU 保留近期活跃配置
			const now = new Date();
			fs.utimesSync(agentDir, now, now);
		}
		pruneOldManagedAgentDirs(agentsRoot, agentName);
	} catch {
		// 目录只读时忽略写入异常
	}

	return {
		effectiveAgentName: agentName,
		managedAgentDir: agentName === BRIDGE_AGENT_NAME ? undefined : agentDir,
	};
}

function pruneOldManagedAgentDirs(agentsRoot: string, activeName: string, maxHashedDirs = 16): void {
	try {
		if (!fs.existsSync(agentsRoot)) return;
		const prefix = `${BRIDGE_AGENT_NAME}-`;
		const entries = fs
			.readdirSync(agentsRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory() && e.name.startsWith(prefix) && e.name !== activeName)
			.map((e) => {
				const full = path.join(agentsRoot, e.name);
				let mtimeMs = 0;
				try {
					mtimeMs = fs.statSync(full).mtimeMs;
				} catch {
					// 忽略
				}
				return { full, mtimeMs };
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs);

		for (let i = maxHashedDirs; i < entries.length; i++) {
			try {
				fs.rmSync(entries[i].full, { recursive: true, force: true });
			} catch {
				// 忽略
			}
		}
	} catch {
		// 忽略
	}
}

export function buildAgyChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = { ...env };
	const existing = env.NO_PROXY || env.no_proxy || "";
	const entries = existing
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	for (const host of ["127.0.0.1", "localhost", "::1"]) {
		if (!entries.includes(host)) {
			entries.push(host);
		}
	}
	const joined = entries.join(",");
	result.NO_PROXY = joined;
	result.no_proxy = joined;
	// agy requires "true" (not "1") to suppress CLI self-updates during ACP runs.
	const hasDisableAutoUpdate = Object.keys(result).some(
		(key) => key.toUpperCase() === "AGY_CLI_DISABLE_AUTO_UPDATE" && result[key] !== undefined,
	);
	if (!hasDisableAutoUpdate) {
		result.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
	}
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isElicitationCreateParams(value: unknown): value is AcpElicitationCreateParams {
	return isRecord(value);
}

function racePromiseWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		return Promise.reject(signal.reason ?? new Error("Request cancelled"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(signal.reason ?? new Error("Request cancelled"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(val) => {
				signal.removeEventListener("abort", onAbort);
				resolve(val);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

function scheduleOrphanedSessionDbCleanup(
	geminiDir: string,
	appDataDirName: string,
	sessionId: string,
): void {
	if (!SAFE_SESSION_ID_RE.test(sessionId)) return;
	const appDataDir = path.join(geminiDir, appDataDirName || "antigravity-cli");
	const convDir = path.join(appDataDir, "conversations");
	const brainDir = path.join(appDataDir, "brain", sessionId);
	const annotationFile = path.join(appDataDir, "annotations", `${sessionId}.pbtxt`);
	const tryUnlink = () => {
		for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
			try {
				fs.rmSync(path.join(convDir, `${sessionId}${suffix}`), { force: true });
			} catch {
				// Windows worker may briefly hold file handles before exit; delayed retries cover it
			}
		}
		try {
			fs.rmSync(brainDir, { recursive: true, force: true });
		} catch {
			// Retry on delayed sweep
		}
		try {
			fs.rmSync(annotationFile, { force: true });
		} catch {
			// Retry on delayed sweep
		}
	};
	tryUnlink();
	setTimeout(tryUnlink, 700).unref();
	setTimeout(tryUnlink, 1_800).unref();
}

/** 封装单个已握手 `agy acp` 子进程连接 */
export class AcpClientConnection {
	readonly binary: ResolvedBinary;
	readonly profile: AcpProcessProfile;
	private readonly proc: ChildProcessWithoutNullStreams;
	private readonly managedAgentDir?: string;
	private readonly pending = new Map<JsonRpcId, PendingRpc>();
	/** 记录调用方提前 abort 或超时的 `session/new` / `session/resume` 请求，在后端迟到回包时立即关闭孤儿 worker */
	private readonly orphanedSessionOpenRpcs = new Map<JsonRpcId, string>();
	private readonly activeSessions = new Set<string>();
	private readonly stderrTail: string[] = [];
	private nextRpcId = 1;
	private closed = false;
	private initPromise?: Promise<AcpInitializeResult>;
	private initResult?: AcpInitializeResult;
	private handlers: AcpServerHandlers;

	constructor(
		binary: ResolvedBinary,
		profile: AcpProcessProfile,
		handlers: AcpServerHandlers = {},
		env: NodeJS.ProcessEnv = process.env,
	) {
		this.binary = binary;
		this.profile = profile;
		this.handlers = handlers;

		const { effectiveAgentName, managedAgentDir } =
			resolveManagedAgentMaterialization(profile);
		this.managedAgentDir = managedAgentDir;

		const args: string[] = ["acp", "--disable-telemetry"];
		if (profile.processPerSession) {
			args.push("--process-per-session");
		}
		if (effectiveAgentName) {
			args.push("--agent", effectiveAgentName);
		}
		if (!profile.includeDefaultCustomizations) {
			args.push("--include-default-customizations=false");
		}
		if (profile.sandbox) {
			args.push("--sandbox");
		}
		if (profile.geminiDir) {
			args.push("--gemini-dir", profile.geminiDir);
		}
		if (profile.appDataDirName && profile.appDataDirName !== "antigravity-cli") {
			args.push("--app-data-dir", profile.appDataDirName);
		}

		const spawnSpec = buildAgySpawnSpec(binary, args, env);

		this.proc = spawn(spawnSpec.command, spawnSpec.args, {
			env: buildAgyChildEnv(env),
			stdio: ["pipe", "pipe", "pipe"],
			windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
			detached: process.platform !== "win32",
			windowsHide: true,
		});

		this.proc.stdin.on("error", () => {
			// 子进程意外退出时忽略底层管道异步 EPIPE，交由 proc close/error 统一拒绝在途请求
		});

		const stdoutDecoder = new StringDecoder("utf8");
		const parser = new NdjsonLineParser((msg) => this.handleIncomingMessage(msg));

		this.proc.stdout.on("data", (chunk: Buffer) => {
			parser.push(stdoutDecoder.write(chunk));
		});
		this.proc.stdout.on("end", () => {
			const rem = stdoutDecoder.end();
			if (rem) parser.push(rem);
			parser.flush();
		});

		const stderrDecoder = new StringDecoder("utf8");
		this.proc.stderr.on("data", (chunk: Buffer) => {
			const text = stderrDecoder.write(chunk);
			for (const line of text.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed.length > 0) {
					this.stderrTail.push(trimmed);
					if (this.stderrTail.length > 20) {
						this.stderrTail.shift();
					}
				}
			}
		});

		this.proc.on("error", (err) => {
			this.failAllPending(err);
		});
		this.proc.on("close", (code, signal) => {
			this.closed = true;
			const tail = this.stderrTail.length > 0 ? `: ${this.stderrTail.slice(-3).join(" | ")}` : "";
			this.failAllPending(
				new Error(`Antigravity ACP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})${tail}`),
			);
		});
	}

	get isAlive(): boolean {
		return !this.closed && this.proc.exitCode === null && !this.proc.killed;
	}

	/** Fork: an RPC is waiting for agy, or a session on this process is still open. */
	get hasOpenWork(): boolean {
		return this.pending.size > 0 || this.activeSessions.size > 0 || this.orphanedSessionOpenRpcs.size > 0;
	}

	get capabilities(): AcpInitializeResult["agentCapabilities"] | undefined {
		return this.initResult?.agentCapabilities;
	}

	get initializeInfo(): AcpInitializeResult | undefined {
		return this.initResult;
	}

	setHandlers(handlers: AcpServerHandlers): void {
		this.handlers = handlers;
	}

	trackSession(sessionId: string): void {
		this.activeSessions.add(sessionId);
	}

	untrackSession(sessionId: string): void {
		this.activeSessions.delete(sessionId);
	}

	async ensureInitialized(signal?: AbortSignal): Promise<AcpInitializeResult> {
		if (this.initResult) {
			return this.initResult;
		}
		if (signal?.aborted) {
			throw signal.reason ?? new Error("Request cancelled");
		}
		if (!this.initPromise) {
			this.initPromise = this.request<AcpInitializeResult>(
				"initialize",
				{
					protocolVersion: 1,
					clientCapabilities: {
						elicitation: { form: {}, url: {} },
					},
					clientInfo: {
						name: CLIENT_INFO_NAME,
						version: CLIENT_INFO_VERSION,
					},
				},
				{ timeoutMs: INITIALIZE_TIMEOUT_MS },
			)
				.then((res) => {
					this.initResult = res;
					return res;
				})
				.catch((err) => {
					this.initPromise = undefined;
					throw err;
				});
		}
		return racePromiseWithSignal(this.initPromise, signal);
	}

	request<TResult = unknown>(
		method: string,
		params?: unknown,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<TResult> {
		if (!this.isAlive) {
			return Promise.reject(new Error("Antigravity ACP process is not running"));
		}
		if (options.signal?.aborted) {
			return Promise.reject(options.signal.reason ?? new Error("Request cancelled"));
		}

		const id = this.nextRpcId++;
		const tracksSessionOpen = method === "session/new" || method === "session/resume";

		return new Promise<TResult>((resolve, reject) => {
			const entry: PendingRpc = {
				method,
				resolve: (v) => resolve(v as TResult),
				reject,
			};

			if (options.timeoutMs && options.timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					this.pending.delete(id);
					if (tracksSessionOpen) {
						this.orphanedSessionOpenRpcs.set(id, method);
					}
					entry.cleanupAbort?.();
					reject(new Error(`ACP request ${method} timed out (${options.timeoutMs} ms)`));
				}, options.timeoutMs);
			}

			if (options.signal) {
				const onAbort = () => {
					if (!this.pending.has(id)) return;
					this.pending.delete(id);
					if (tracksSessionOpen) {
						this.orphanedSessionOpenRpcs.set(id, method);
					}
					if (entry.timer) clearTimeout(entry.timer);
					reject(options.signal?.reason ?? new Error(`ACP request ${method} aborted`));
				};
				options.signal.addEventListener("abort", onAbort, { once: true });
				entry.cleanupAbort = () => options.signal?.removeEventListener("abort", onAbort);
			}

			this.pending.set(id, entry);
			this.writeJson({
				jsonrpc: "2.0",
				id,
				method,
				params,
			});
		});
	}

	notify(method: string, params?: unknown): void {
		if (!this.isAlive) return;
		this.writeJson({
			jsonrpc: "2.0",
			method,
			params,
		});
	}

	async closeSessionSafe(sessionId: string): Promise<void> {
		this.activeSessions.delete(sessionId);
		if (!this.isAlive) return;
		try {
			await this.request("session/close", { sessionId }, { timeoutMs: 3_000 });
		} catch {
			// 会话已关闭或进程退出时静默忽略
		}
	}

	/** 优雅关闭连接、清理临时挂载 Agent 描述并在超时后回收跨平台子进程树 */
	async dispose(): Promise<void> {
		if (this.closed) {
			return;
		}
		const sessions = Array.from(this.activeSessions);
		this.activeSessions.clear();

		for (const sessionId of sessions) {
			await this.closeSessionSafe(sessionId);
		}

		if (this.isAlive) {
			const exitedGracefully = await new Promise<boolean>((resolve) => {
				let settled = false;
				let killTimer: ReturnType<typeof setTimeout> | undefined;
				const finish = (graceful: boolean) => {
					if (settled) return;
					settled = true;
					if (killTimer) {
						clearTimeout(killTimer);
						killTimer = undefined;
					}
					resolve(graceful);
				};

				this.proc.once("close", () => finish(true));
				try {
					this.proc.stdin.end();
				} catch {
					// 忽略管道关闭异常
				}

				killTimer = setTimeout(() => {
					if (!settled) {
						finish(false);
					}
				}, 1_500);
				killTimer.unref();
			});

			if (!exitedGracefully && this.proc.exitCode === null) {
				await this.forceKillProcessTree();
			}
		}

		this.closed = true;
		try {
			this.proc.stdin.destroy();
			this.proc.stdout.destroy();
			this.proc.stderr.destroy();
			this.proc.unref();
		} catch {
			// 忽略流释放异常
		}
		// 保留确定性哈希目录 pi-bridge-<hash>，避免并发运行的多个 Pi 进程误删彼此正在使用的配置目录
		void this.managedAgentDir;
	}

	private async forceKillProcessTree(): Promise<void> {
		const pid = this.proc.pid;
		if (!pid) return;

		if (process.platform === "win32") {
			try {
				spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
					windowsHide: true,
					stdio: "ignore",
					timeout: 3_000,
				});
			} catch {
				try {
					this.proc.kill();
				} catch {
					// 忽略已退出进程
				}
			}
			return;
		}

		const sendPosixGroupOrPid = (sig: NodeJS.Signals) => {
			try {
				process.kill(-pid, sig);
			} catch {
				try {
					this.proc.kill(sig);
				} catch {
					// 忽略已退出进程
				}
			}
		};

		sendPosixGroupOrPid("SIGTERM");
		if (this.proc.exitCode !== null) {
			return;
		}

		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				this.proc.off("close", finish);
				resolve();
			};
			const timer = setTimeout(() => {
				if (this.proc.exitCode === null) {
					sendPosixGroupOrPid("SIGKILL");
				}
				finish();
			}, 500);
			this.proc.once("close", finish);
		});
	}

	private writeJson(payload: unknown): void {
		try {
			if (this.closed || this.proc.stdin.destroyed || !this.proc.stdin.writable) {
				this.failAllPending(new Error("Antigravity ACP stdin is not writable"));
				return;
			}
			this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
		} catch (error) {
			this.failAllPending(error);
		}
	}

	private handleIncomingMessage(msg: JsonRpcMessage): void {
		if ("id" in msg && ("result" in msg || "error" in msg) && !("method" in msg)) {
			if (msg.id === null) return;
			const entry = this.pending.get(msg.id);
			if (!entry) {
				// 回收调用方已被 abort/timeout 放弃但后端仍创建成功的孤儿会话，防止泄漏 agy acp --worker 子进程与空 .db
				const orphanedMethod = this.orphanedSessionOpenRpcs.get(msg.id);
				if (orphanedMethod) {
					this.orphanedSessionOpenRpcs.delete(msg.id);
					if ("result" in msg && msg.result && typeof msg.result === "object") {
						const sid = (msg.result as { sessionId?: unknown }).sessionId;
						if (typeof sid === "string" && sid.length > 0) {
							void this.closeSessionSafe(sid).finally(() => {
								if (orphanedMethod === "session/new") {
									scheduleOrphanedSessionDbCleanup(
										this.profile.geminiDir,
										this.profile.appDataDirName,
										sid,
									);
								}
							});
						}
					}
				}
				return;
			}
			this.pending.delete(msg.id);
			if (entry.timer) clearTimeout(entry.timer);
			entry.cleanupAbort?.();
			if ("error" in msg) {
				entry.reject(new AcpRpcError(msg.error));
			} else {
				entry.resolve(msg.result);
			}
			return;
		}

		if ("id" in msg && "method" in msg) {
			void this.handleServerRequest(msg as JsonRpcRequest);
			return;
		}

		if ("method" in msg && !("id" in msg)) {
			if (msg.method === "session/update" && msg.params) {
				this.handlers.onSessionUpdate?.(msg.params as AcpSessionUpdateNotification);
			}
		}
	}

	private async handleServerRequest(req: JsonRpcRequest): Promise<void> {
		try {
			if (req.method === "session/request_permission") {
				if (!this.handlers.onRequestPermission) {
					this.writeJson({
						jsonrpc: "2.0",
						id: req.id,
						result: { outcome: { outcome: "cancelled" } } satisfies AcpRequestPermissionResult,
					});
					return;
				}
				const result = await this.handlers.onRequestPermission(
					req.params as AcpRequestPermissionParams,
				);
				this.writeJson({ jsonrpc: "2.0", id: req.id, result });
				return;
			}

			const isLegacyElicitation =
				req.method === "session/elicitation" || req.method === "_session/elicitation";
			if (req.method === "elicitation/create" || isLegacyElicitation) {
				if (!this.handlers.onElicitationCreate) {
					this.writeJson({
						jsonrpc: "2.0",
						id: req.id,
						error: { code: -32601, message: "Elicitation handler unavailable" },
					});
					return;
				}
				if (!isElicitationCreateParams(req.params)) {
					this.writeJson({
						jsonrpc: "2.0",
						id: req.id,
						error: { code: -32602, message: "Invalid elicitation params" },
					});
					return;
				}
				const params: AcpElicitationCreateParams =
					typeof req.params.message === "string"
						? req.params
						: { ...req.params, message: "" };
				const result = await this.handlers.onElicitationCreate(params);
				this.writeJson({
					jsonrpc: "2.0",
					id: req.id,
					result: isLegacyElicitation ? { action: result } : result,
				});
				return;
			}

			this.writeJson({
				jsonrpc: "2.0",
				id: req.id,
				error: { code: -32601, message: `Unsupported client method: ${req.method}` },
			});
		} catch (error) {
			this.writeJson({
				jsonrpc: "2.0",
				id: req.id,
				error: {
					code: -32603,
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private failAllPending(error: unknown): void {
		for (const [, entry] of this.pending) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.cleanupAbort?.();
			entry.reject(error);
		}
		this.pending.clear();
	}
}

function buildProfileKey(profile: AcpProcessProfile): string {
	return JSON.stringify([
		profile.userAgentName ?? "",
		profile.disableBuiltinTools,
		profile.excludeDefaultComponents,
		profile.inheritCustomizations,
		profile.inheritMcp,
		profile.mountedPluginPaths,
		profile.includeDefaultCustomizations,
		profile.processPerSession,
		profile.sandbox,
		profile.geminiDir,
		profile.appDataDirName,
	]);
}

/** 根据桥接配置与原生挂载清单构造目标 ACP 子进程 Profile */
export function resolveProcessProfileForConfig(
	config: BridgeConfig,
	mountedPluginPaths: readonly string[] = [],
): AcpProcessProfile {
	const flags = resolveEffectiveFlags(config);
	const isPiTools = flags.toolMode === "pi-tools";

	return {
		userAgentName: isPiTools ? undefined : config.agyCustomAgent,
		disableBuiltinTools: isPiTools,
		excludeDefaultComponents: isPiTools,
		inheritCustomizations: flags.agyInheritCustomizations,
		inheritMcp: flags.agyInheritMcp,
		mountedPluginPaths: [...mountedPluginPaths],
		includeDefaultCustomizations: flags.agyInheritCustomizations,
		processPerSession: config.processPerSession,
		sandbox: config.sandbox,
		geminiDir: config.geminiDir,
		appDataDirName: config.appDataDirName,
	};
}

/** 管理不同 Profile 的常驻 `agy acp` 进程池与统一释放 */
export class AcpProcessManager {
	private readonly pool = new Map<string, AcpClientConnection>();
	private readonly initializing = new Map<string, Promise<AcpClientConnection>>();
	private readonly initializingConns = new Set<AcpClientConnection>();
	/** Fork: when `acquire` last handed out each pooled process (src/session/idle-release.ts). */
	private readonly lastAcquiredAtMs = new Map<AcpClientConnection, number>();
	private sharedHandlers: AcpServerHandlers = {};
	private disposeEpoch = 0;

	setHandlers(handlers: AcpServerHandlers): void {
		this.sharedHandlers = handlers;
		for (const conn of this.pool.values()) {
			conn.setHandlers(handlers);
		}
		for (const conn of this.initializingConns) {
			conn.setHandlers(handlers);
		}
	}

	resolveBinary(config: BridgeConfig): ResolvedBinary {
		const binary = resolveAgyBinary({
			configuredBin: config.agyBin,
			geminiDir: config.geminiDir,
		});
		if (!binary) {
			throw new Error(
				"Antigravity CLI (agy) not found. Install agy and put it on PATH, or set PI_AGY_BIN.",
			);
		}
		return binary;
	}

	async acquire(
		config: BridgeConfig,
		profileOverride?: Partial<AcpProcessProfile>,
		signal?: AbortSignal,
	): Promise<AcpClientConnection> {
		if (signal?.aborted) {
			throw signal.reason ?? new Error("Request cancelled");
		}

		const baseProfile = resolveProcessProfileForConfig(config);
		const profile: AcpProcessProfile = { ...baseProfile, ...profileOverride };
		const key = buildProfileKey(profile);

		const existing = this.pool.get(key);
		if (existing?.isAlive) {
			this.lastAcquiredAtMs.set(existing, Date.now());
			await existing.ensureInitialized(signal);
			return existing;
		}

		let initTask = this.initializing.get(key);
		if (!initTask) {
			const epochAtStart = this.disposeEpoch;
			initTask = (async () => {
				const binary = this.resolveBinary(config);
				const conn = new AcpClientConnection(binary, profile, this.sharedHandlers);
				this.initializingConns.add(conn);
				try {
					await conn.ensureInitialized();
					if (this.disposeEpoch !== epochAtStart) {
						await conn.dispose();
						throw new Error("Antigravity ACP process pool is closed");
					}
					this.pool.set(key, conn);
					this.lastAcquiredAtMs.set(conn, Date.now());
					return conn;
				} catch (error) {
					await conn.dispose();
					throw error;
				} finally {
					this.initializingConns.delete(conn);
					if (this.initializing.get(key) === initTask) {
						this.initializing.delete(key);
					}
				}
			})();
			this.initializing.set(key, initTask);
		}

		return racePromiseWithSignal(initTask, signal);
	}

	/** 从连接池驱逐并强制销毁已卡死或状态异常的单个子进程连接 */
	async evict(target: AcpClientConnection): Promise<void> {
		for (const [key, conn] of this.pool.entries()) {
			if (conn === target) {
				this.pool.delete(key);
			}
		}
		this.initializingConns.delete(target);
		this.lastAcquiredAtMs.delete(target);
		await target.dispose();
	}

	/**
	 * Fork: stops pooled processes that nobody uses: not `inUse`, no open RPC or session,
	 * and not handed out by `acquire` for `idleMs`. Returns how many it stopped.
	 */
	async releaseIdle(
		inUse: (conn: AcpClientConnection) => boolean,
		idleMs: number,
		nowMs: number = Date.now(),
	): Promise<number> {
		const idle: AcpClientConnection[] = [];
		for (const conn of this.pool.values()) {
			const acquiredAt = this.lastAcquiredAtMs.get(conn) ?? 0;
			if (!inUse(conn) && !conn.hasOpenWork && nowMs - acquiredAt >= idleMs) {
				idle.push(conn);
			}
		}
		for (const conn of idle) {
			await this.evict(conn);
		}
		return idle.length;
	}

	async disposeAll(): Promise<void> {
		this.disposeEpoch++;
		const connections = new Set<AcpClientConnection>([
			...this.pool.values(),
			...this.initializingConns.values(),
		]);
		this.pool.clear();
		this.initializing.clear();
		this.initializingConns.clear();
		this.lastAcquiredAtMs.clear();
		await Promise.allSettled(Array.from(connections, (conn) => conn.dispose()));
	}
}
