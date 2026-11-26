import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type BridgeConfig,
	type ToolMode,
	resolveAgyConversationsDir,
} from "../config.ts";
import { computeTranscriptDigest, type PreloadedSqliteTurn } from "./reconcile.ts";

export const AGY_SESSION_ANCHOR_CUSTOM_TYPE = "antigravity-acp-state";

export interface SqliteDbCheckpoint {
	steps: number;
	generations: number;
	executions: number;
	fingerprint: string;
}

export interface AgySessionAnchor {
	version: 1;
	/** 关联的 AGY ACP 会话 UUID */
	agySessionId: string;
	/** 创建该锚点时的工具主控模式 */
	toolMode: ToolMode;
	/** 模型可见对话消息序列的 SHA-256 摘要 */
	transcriptDigest: string;
	/** 模型可见消息总数 */
	messageCount: number;
	/** 原生挂载插件（AGENTS.md / Skills）状态 SHA-256 摘要 */
	mountDigest: string;
	/** 暴露给宿主的 MCP 工具表指纹 */
	toolsDigest: string;
	/** 是否为通过 `/agy sessions` 刚导入尚未经历首轮请求对齐的原始会话锚点 */
	importedRaw?: boolean;
	/** 可选：该 AGY 会话实际承载的 `pi-traffic-optimization` 归档投影指纹 */
	projectionDigest?: string;
	/** 可选：该 AGY 会话实际承载的 `pi-traffic-optimization` 归档占位符总数 */
	projectedCount?: number;
	/** 可选：该锚点落盘时后端已使用的上下文 token 水位（供恢复时评估是否因归档投影重建） */
	usedTokens?: number;
	/** 可选的本地 SQLite 会话数据库检查点水位 */
	dbCheckpoint?: SqliteDbCheckpoint;
}

export type AnchorMatchResult =
	| {
			kind: "exact";
			anchor: AgySessionAnchor;
	  }
	| {
			kind: "forkable";
			anchor: AgySessionAnchor;
	  }
	| {
			kind: "none";
	  };

export function hasLocalConversationDb(config: BridgeConfig, agySessionId: string): boolean {
	if (!agySessionId) return false;
	const dbPath = path.join(resolveAgyConversationsDir(config), `${agySessionId}.db`);
	return fs.existsSync(dbPath);
}

function isOnlyFailedOrAbortedTurns(
	delta: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
): boolean {
	if (delta.length === 0) return false;
	const last = delta[delta.length - 1];
	if (
		last.role !== "assistant" ||
		(last.stopReason !== "aborted" && last.stopReason !== "error")
	) {
		return false;
	}
	for (const message of delta) {
		if (message.role === "toolResult") return false;
		if (
			message.role === "assistant" &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error"
		) {
			return false;
		}
	}
	return true;
}

/**
 * 沿当前会话树分支（`sessionManager.getBranch()`）回溯匹配最优历史锚点。
 *
 * `priorMessages` 为本轮新增用户输入之前的历史可见消息序列：
 * - 若某个锚点的 `messageCount === priorMessages.length` 且摘要、工具模式与系统提示词一致，可直接走 `session/resume`；
 * - 若锚点之后仅包含无工具结果的失败/中止轮次（例如策略拒绝或启动失败），且前缀摘要一致，同样按 `exact` 交由后续 SQLite 校验判断是否可直接 `session/resume`；
 * - 若锚点命中更早的 `priorMessages.slice(0, k)` 前缀且具备 `dbCheckpoint`，可尝试只读 SQLite 快照分叉恢复。
 */
export function findBranchAnchorForHistory(options: {
	branchEntries: readonly SessionEntry[];
	priorMessages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[];
	toolMode: ToolMode;
	mountDigest: string;
	config: BridgeConfig;
}): AnchorMatchResult {
	const { branchEntries, priorMessages, toolMode, mountDigest, config } = options;
	if (branchEntries.length === 0) {
		return { kind: "none" };
	}

	const fullPriorDigest = computeTranscriptDigest(priorMessages);
	let bestForkCandidate: AgySessionAnchor | undefined;

	// 从分支叶子向根节点逆序查找最近的合法锚点
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i];
		if (entry.type !== "custom") continue;
		const custom = entry as CustomEntry<AgySessionAnchor>;
		if (custom.customType !== AGY_SESSION_ANCHOR_CUSTOM_TYPE || !custom.data) continue;

		const anchor = custom.data;
		if (anchor.version !== 1 || !anchor.agySessionId) continue;
		if (anchor.toolMode !== toolMode) continue;
		if (!anchor.importedRaw && anchor.mountDigest !== mountDigest) continue;
		if (!hasLocalConversationDb(config, anchor.agySessionId)) continue;

		if (
			anchor.messageCount === priorMessages.length &&
			anchor.transcriptDigest === fullPriorDigest
		) {
			return { kind: "exact", anchor };
		}

		if (anchor.messageCount > 0 && anchor.messageCount < priorMessages.length) {
			const delta = priorMessages.slice(anchor.messageCount);
			if (isOnlyFailedOrAbortedTurns(delta)) {
				const sliceDigest = computeTranscriptDigest(priorMessages.slice(0, anchor.messageCount));
				if (sliceDigest === anchor.transcriptDigest) {
					return { kind: "exact", anchor };
				}
			} else if (!bestForkCandidate && config.enableSqliteFork && anchor.dbCheckpoint) {
				const sliceDigest = computeTranscriptDigest(priorMessages.slice(0, anchor.messageCount));
				if (sliceDigest === anchor.transcriptDigest) {
					bestForkCandidate = anchor;
				}
			}
		}
	}

	if (bestForkCandidate) {
		return { kind: "forkable", anchor: bestForkCandidate };
	}

	return { kind: "none" };
}

type NodeSqliteModule = typeof import("node:sqlite");
let cachedSqliteMod: NodeSqliteModule | null | undefined;

async function loadNodeSqlite(): Promise<NodeSqliteModule | undefined> {
	if (cachedSqliteMod !== undefined) {
		return cachedSqliteMod ?? undefined;
	}
	try {
		cachedSqliteMod = await import("node:sqlite");
		return cachedSqliteMod;
	} catch {
		cachedSqliteMod = null;
		return undefined;
	}
}

/** 打开 SQLite 连接并设置 `busy_timeout`，缓解 Windows WAL 并发读写下的瞬时 `SQLITE_BUSY` 锁冲突 */
function openSqliteWithTimeout(
	sqlite: NodeSqliteModule,
	dbPath: string,
	readOnly: boolean,
	busyTimeoutMs = 1_500,
): import("node:sqlite").DatabaseSync {
	const db = readOnly
		? new sqlite.DatabaseSync(dbPath, { readOnly: true })
		: new sqlite.DatabaseSync(dbPath);
	try {
		db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
	} catch {
		// 忽略只读连接或特殊环境下 PRAGMA 不可用异常
	}
	return db;
}

const REQUIRED_TABLES = [
	"trajectory_meta",
	"steps",
	"gen_metadata",
	"executor_metadata",
	"parent_references",
] as const;

function computeStepsPrefixFingerprint(
	db: import("node:sqlite").DatabaseSync,
	limitSteps: number,
): string {
	const rows = db
		.prepare(
			"SELECT idx, step_type, status, COALESCE(length(step_payload), 0) AS plen FROM steps WHERE idx < ? ORDER BY idx ASC",
		)
		.all(limitSteps) as Array<{ idx: number; step_type: number; status: number; plen: number }>;

	const hash = crypto.createHash("sha256");
	for (const row of rows) {
		hash.update(`${row.idx}:${row.step_type}:${row.status}:${row.plen};`);
	}
	return hash.digest("hex").slice(0, 32);
}

function verifyRequiredTables(db: import("node:sqlite").DatabaseSync): boolean {
	const rows = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
		.all() as Array<{ name: string }>;
	const names = new Set(rows.map((r) => r.name));
	return REQUIRED_TABLES.every((req) => names.has(req));
}

/** 新会话返回成功时，只读检查已落地的轨迹库是否缺少必需表。 */
export async function hasIncompleteSqliteConversationSchema(
	config: BridgeConfig,
	agySessionId: string,
): Promise<boolean> {
	if (!hasLocalConversationDb(config, agySessionId)) return false;
	const sqlite = await loadNodeSqlite();
	if (!sqlite) return false;
	const dbPath = path.join(resolveAgyConversationsDir(config), `${agySessionId}.db`);
	let db: import("node:sqlite").DatabaseSync | undefined;
	try {
		db = openSqliteWithTimeout(sqlite, dbPath, true, 0);
		return !verifyRequiredTables(db);
	} catch {
		return false;
	} finally {
		db?.close();
	}
}

export interface SqliteGenerationUsage {
	stepIdx: number;
	inputTokens: number;
	outputTokens: number;
	cacheWriteTokens: number;
	cacheReadTokens: number;
	thoughtTokens?: number;
	/** 该次 `PLANNER_RESPONSE` 内含的工具调用总数（用于多工具分步执行时的精确守恒分摊） */
	plannedToolCalls?: number;
}

export interface SqliteUpstreamImageSnapshot {
	image_hash: string;
	mime_type: string;
	decoded_bytes: number;
	base64_bytes: number;
	image_payload_bytes: number;
	source_type: string;
	tool_name: string;
}

export interface SqliteUpstreamToolResultSnapshot {
	tool_name: string;
	text_bytes: number;
	image_bytes: number;
}

/**
 * 从 `agy` 本地只读 SQLite `gen_metadata` 最新代次还原的完整上游发包分类统计。
 * 反映 `agy` 实际向远端模型接口发送的全量上下文（含历史消息、工具声明、内联图片与不透明思考签名）。
 */
export interface SqliteUpstreamRequestSnapshot {
	genIdx: number;
	total_payload_bytes: number;
	json_payload_bytes: number;
	system_bytes: number;
	user_text_bytes: number;
	assistant_text_bytes: number;
	tool_call_bytes: number;
	tool_result_bytes: number;
	image_payload_bytes: number;
	image_decoded_bytes: number;
	tool_schema_bytes: number;
	opaque_reasoning_bytes: number;
	other_bytes: number;
	text_content_utf8_bytes: number;
	image_count: number;
	images: SqliteUpstreamImageSnapshot[];
	results: SqliteUpstreamToolResultSnapshot[];
}

export interface SqliteUpstreamQueryResult {
	snapshots: SqliteUpstreamRequestSnapshot[];
	maxGenIdx: number;
}

function readProtobufVarint(buf: Uint8Array, offset: number): [number, number] | undefined {
	let result = 0;
	let shift = 0;
	let pos = offset;
	while (pos < buf.length) {
		const byte = buf[pos++];
		result += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) {
			return [result, pos];
		}
		shift += 7;
		if (shift > 53) return undefined;
	}
	return undefined;
}

/**
 * 解析 AGY `steps.metadata`（`step_type = 15` 即 `PLANNER_RESPONSE`）字段 9 中的上游 API 真实单步 Token 明细。
 * 体积仅约 390 字节，在 Gemini 与 Claude 模型上均统一编码：
 * - field 2: uncached inputTokens
 * - field 3: total outputTokens（含思考，等于 field 9 + field 10）
 * - field 4: cachedWriteTokens（可选）
 * - field 5: cachedReadTokens（可选）
 * - field 9: thoughtTokens（思考 Token，可选）
 * - field 10: responseTokens（正文与工具调用 Token，可选）
 */
export function parseStepMetadataGenerationUsage(
	metadata: Uint8Array,
	stepIdx: number,
): SqliteGenerationUsage | undefined {
	let pos = 0;
	while (pos < metadata.length) {
		const tagRes = readProtobufVarint(metadata, pos);
		if (!tagRes) return undefined;
		const [tag, nextPos] = tagRes;
		pos = nextPos;
		const fieldNo = Math.floor(tag / 8);
		const wireType = tag & 7;
		if (fieldNo <= 0) return undefined;

		if (wireType === 0) {
			const valRes = readProtobufVarint(metadata, pos);
			if (!valRes) return undefined;
			pos = valRes[1];
		} else if (wireType === 2) {
			const lenRes = readProtobufVarint(metadata, pos);
			if (!lenRes) return undefined;
			const [len, subStart] = lenRes;
			const subEnd = subStart + len;
			if (subEnd > metadata.length) return undefined;
			if (fieldNo === 9) {
				const sub = metadata.subarray(subStart, subEnd);
				let k = 0;
				const fields = new Map<number, number>();
				while (k < sub.length) {
					const innerTag = readProtobufVarint(sub, k);
					if (!innerTag) break;
					k = innerTag[1];
					const innerFn = Math.floor(innerTag[0] / 8);
					const innerWt = innerTag[0] & 7;
					if (innerWt === 0) {
						const v = readProtobufVarint(sub, k);
						if (!v) break;
						k = v[1];
						fields.set(innerFn, v[0]);
					} else if (innerWt === 2) {
						const l = readProtobufVarint(sub, k);
						if (!l || l[1] + l[0] > sub.length) break;
						k = l[1] + l[0];
					} else if (innerWt === 5) {
						k += 4;
					} else if (innerWt === 1) {
						k += 8;
					} else {
						break;
					}
				}
				const inputTokens = fields.get(2) ?? 0;
				const rawOutput = fields.get(3) ?? 0;
				const cacheWriteTokens = fields.get(4) ?? 0;
				const cacheReadTokens = fields.get(5) ?? 0;
				const thoughtTokens = fields.get(9);
				const responseTokens = fields.get(10);
				const splitOutput = (thoughtTokens ?? 0) + (responseTokens ?? 0);
				if (inputTokens + rawOutput + cacheWriteTokens + cacheReadTokens + splitOutput > 0) {
					return {
						stepIdx,
						inputTokens,
						outputTokens: Math.max(rawOutput, splitOutput),
						cacheWriteTokens,
						cacheReadTokens,
						thoughtTokens,
					};
				}
			}
			pos = subEnd;
		} else if (wireType === 5) {
			pos += 4;
		} else if (wireType === 1) {
			pos += 8;
		} else {
			return undefined;
		}
	}
	return undefined;
}

/**
 * 解析 `steps.step_payload`（`step_type = 15`）字段 20（`PlannerResponse`）中子字段 7（`repeated ToolCall`）的数量。
 * 在 Gemini 与 Claude 模型上均统一编码，用于在单次生成拆出多个顺序工具步时按整数守恒分摊 Token，避免后续子步出现 0 提示词导致 UI 缓存命中率消失。
 */
export function parseStepPayloadPlannedToolCount(stepPayload: Uint8Array): number {
	let pos = 0;
	while (pos < stepPayload.length) {
		const tagRes = readProtobufVarint(stepPayload, pos);
		if (!tagRes) return 0;
		pos = tagRes[1];
		const fieldNo = Math.floor(tagRes[0] / 8);
		const wireType = tagRes[0] & 7;
		if (fieldNo <= 0) return 0;

		if (wireType === 0) {
			const v = readProtobufVarint(stepPayload, pos);
			if (!v) return 0;
			pos = v[1];
		} else if (wireType === 2) {
			const lenRes = readProtobufVarint(stepPayload, pos);
			if (!lenRes) return 0;
			const [len, subStart] = lenRes;
			const subEnd = subStart + len;
			if (subEnd > stepPayload.length) return 0;
			if (fieldNo === 20) {
				const sub = stepPayload.subarray(subStart, subEnd);
				let k = 0;
				let count = 0;
				while (k < sub.length) {
					const innerTag = readProtobufVarint(sub, k);
					if (!innerTag) break;
					k = innerTag[1];
					const innerFn = Math.floor(innerTag[0] / 8);
					const innerWt = innerTag[0] & 7;
					if (innerWt === 0) {
						const v = readProtobufVarint(sub, k);
						if (!v) break;
						k = v[1];
					} else if (innerWt === 2) {
						const l = readProtobufVarint(sub, k);
						if (!l || l[1] + l[0] > sub.length) break;
						if (innerFn === 7) {
							count++;
						}
						k = l[1] + l[0];
					} else if (innerWt === 5) {
						k += 4;
					} else if (innerWt === 1) {
						k += 8;
					} else {
						break;
					}
				}
				return count;
			}
			pos = subEnd;
		} else if (wireType === 5) {
			pos += 4;
		} else if (wireType === 1) {
			pos += 8;
		} else {
			return 0;
		}
	}
	return 0;
}

/** 读取指定会话当前 `steps` 表的最大 `idx`（新建会话尚无记录时返回 `-1`），用于在 `session/resume` 时定位起始水位 */
export async function readCurrentMaxSqliteStepIdx(
	config: BridgeConfig,
	agySessionId: string,
): Promise<number> {
	if (!agySessionId) return -1;
	const dbPath = path.join(resolveAgyConversationsDir(config), `${agySessionId}.db`);
	if (!fs.existsSync(dbPath)) return -1;
	const sqlite = await loadNodeSqlite();
	if (!sqlite) return -1;

	let db: import("node:sqlite").DatabaseSync | undefined;
	try {
		db = openSqliteWithTimeout(sqlite, dbPath, true);
		const row = db
			.prepare("SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM steps")
			.get() as { maxIdx: number } | undefined;
		return typeof row?.maxIdx === "number" ? row.maxIdx : -1;
	} catch {
		return -1;
	} finally {
		try {
			db?.close();
		} catch {
			// 忽略
		}
	}
}

/**
 * 以只读方式读取指定水位之后新产生的全部 `PLANNER_RESPONSE`（`step_type = 15`）逐次生成统计。
 * 若本地库不存在或跨版本字段变化则返回空数组，由调用方平滑回退至 ACP 窗口统计。
 */
export async function readSqliteGenerationUsagesSince(
	config: BridgeConfig,
	agySessionId: string,
	afterStepIdx: number,
): Promise<SqliteGenerationUsage[]> {
	if (!agySessionId) return [];
	const dbPath = path.join(resolveAgyConversationsDir(config), `${agySessionId}.db`);
	if (!fs.existsSync(dbPath)) return [];
	const sqlite = await loadNodeSqlite();
	if (!sqlite) return [];

	let db: import("node:sqlite").DatabaseSync | undefined;
	try {
		db = openSqliteWithTimeout(sqlite, dbPath, true);
		const rows = db
			.prepare(
				"SELECT idx, metadata, step_payload FROM steps WHERE step_type = 15 AND status NOT IN (4, 5, 6, 7, 8, 12) AND idx > ? AND metadata IS NOT NULL ORDER BY idx ASC",
			)
			.all(afterStepIdx) as Array<{
			idx: number;
			metadata: Uint8Array;
			step_payload?: Uint8Array | null;
		}>;

		const parsed: SqliteGenerationUsage[] = [];
		for (const row of rows) {
			if (row.metadata && row.metadata.byteLength > 0) {
				const u = parseStepMetadataGenerationUsage(row.metadata, row.idx);
				if (u) {
					if (row.step_payload && row.step_payload.byteLength > 0) {
						const toolCount = parseStepPayloadPlannedToolCount(row.step_payload);
						if (toolCount > 0) {
							u.plannedToolCalls = toolCount;
						}
					}
					parsed.push(u);
				}
			}
		}
		return parsed;
	} catch {
		return [];
	} finally {
		try {
			db?.close();
		} catch {
			// 忽略
		}
	}
}

/**
 * 在末步 `prompt_done` 到达时带短退避重试读取最新 SQLite `PLANNER_RESPONSE` 统计，
 * 兜底应对 `agy` WAL 异步落盘略晚于 JSON-RPC 回包的边界竞态。
 */
export async function readSqliteGenerationUsagesSinceWithRetry(
	config: BridgeConfig,
	agySessionId: string,
	afterStepIdx: number,
	retryDelaysMs: readonly number[] = [25, 50],
): Promise<SqliteGenerationUsage[]> {
	const first = await readSqliteGenerationUsagesSince(config, agySessionId, afterStepIdx);
	if (first.length > 0 || !hasLocalConversationDb(config, agySessionId)) {
		return first;
	}
	for (const delay of retryDelaysMs) {
		await new Promise((r) => setTimeout(r, delay));
		const next = await readSqliteGenerationUsagesSince(config, agySessionId, afterStepIdx);
		if (next.length > 0) {
			return next;
		}
	}
	return [];
}

interface RawProtobufField {
	field: number;
	wire: number;
	val?: number;
	sub?: Uint8Array;
}

/** 支持完整 64 位（含负数 10 字节）varint 解析，防止 `ChatRequest` 中负整型枚举或偏移量截断扫描 */
function readProtobufVarint64(buf: Uint8Array, offset: number): [bigint, number] | undefined {
	let result = 0n;
	let shift = 0n;
	let pos = offset;
	while (pos < buf.length && shift <= 63n) {
		const byte = buf[pos++];
		result |= BigInt(byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) {
			return [result, pos];
		}
		shift += 7n;
	}
	return undefined;
}

function parseRawProtobufFields(buf: Uint8Array): RawProtobufField[] {
	const fields: RawProtobufField[] = [];
	let pos = 0;
	while (pos < buf.length) {
		const tagRes = readProtobufVarint64(buf, pos);
		if (!tagRes) break;
		const [tagBig, afterTag] = tagRes;
		pos = afterTag;
		const field = Number(tagBig >> 3n);
		const wire = Number(tagBig & 7n);
		if (field <= 0) break;

		if (wire === 0) {
			const valRes = readProtobufVarint64(buf, pos);
			if (!valRes) break;
			pos = valRes[1];
			fields.push({ field, wire, val: Number(valRes[0]) });
		} else if (wire === 2) {
			const lenRes = readProtobufVarint64(buf, pos);
			if (!lenRes) break;
			const len = Number(lenRes[0]);
			const start = lenRes[1];
			if (!Number.isSafeInteger(len) || len < 0 || start + len > buf.length) break;
			fields.push({ field, wire, sub: buf.subarray(start, start + len) });
			pos = start + len;
		} else if (wire === 1) {
			if (pos + 8 > buf.length) break;
			fields.push({ field, wire });
			pos += 8;
		} else if (wire === 5) {
			if (pos + 4 > buf.length) break;
			fields.push({ field, wire });
			pos += 4;
		} else {
			break;
		}
	}
	return fields;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function encodedJsonStringBytes(text: string): number {
	return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

function isReadLikeToolName(name: string): boolean {
	return name === "read" || name === "agy_read";
}

function stripHostMcpPrefix(rawName: string): string {
	return rawName.replace(/^mcp_pi_tools_/, "");
}

const IMAGE_HASH_CACHE_MAX = 128;
const imageSha256Cache = new Map<string, string>();

function computeCachedImageSha256(rawSub: Uint8Array): string {
	const len = rawSub.byteLength;
	if (len < 4_096) {
		return crypto.createHash("sha256").update(rawSub).digest("hex");
	}
	const mid = Math.floor(len / 2);
	const headHex = Buffer.from(rawSub.subarray(0, 48)).toString("hex");
	const midHex = Buffer.from(rawSub.subarray(mid - 24, mid + 24)).toString("hex");
	const tailHex = Buffer.from(rawSub.subarray(len - 48, len)).toString("hex");
	const cacheKey = `${len}:${headHex}:${midHex}:${tailHex}`;
	const cached = imageSha256Cache.get(cacheKey);
	if (cached !== undefined) {
		imageSha256Cache.delete(cacheKey);
		imageSha256Cache.set(cacheKey, cached);
		return cached;
	}
	const computed = crypto.createHash("sha256").update(rawSub).digest("hex");
	if (imageSha256Cache.size >= IMAGE_HASH_CACHE_MAX) {
		const oldest = imageSha256Cache.keys().next().value;
		if (oldest !== undefined) {
			imageSha256Cache.delete(oldest);
		}
	}
	imageSha256Cache.set(cacheKey, computed);
	return computed;
}

/**
 * 解析 AGY 本地 SQLite `gen_metadata.data`（最新代次 `field 1` 即完整 `ChatRequest` protobuf），
 * 还原发往上游云端 `streamGenerateContent` 的全量 JSON 请求体积与内容分类（支持 `pi-tools` / `agy-tools` / `hybrid` 及 Gemini/Claude 全模型）。
 * 若该条记录已被 `agy` 裁剪为仅剩摘要元数据（无 `field 2` 消息体），返回 `undefined`。
 */
export function parseGenMetadataUpstreamRequest(
	data: Uint8Array,
	genIdx: number,
): SqliteUpstreamRequestSnapshot | undefined {
	if (!data || data.byteLength === 0) return undefined;
	const topFields = parseRawProtobufFields(data);
	const chatReqField = topFields.find((f) => f.field === 1 && f.sub && f.sub.byteLength > 0);
	if (!chatReqField?.sub) return undefined;

	const reqFields = parseRawProtobufFields(chatReqField.sub);
	const hasMessages = reqFields.some((f) => f.field === 2 && f.sub && f.sub.byteLength > 0);
	if (!hasMessages) return undefined;

	let system_bytes = 0;
	let user_text_bytes = 0;
	let assistant_text_bytes = 0;
	let tool_call_bytes = 0;
	let tool_result_bytes = 0;
	let image_payload_bytes = 0;
	let image_decoded_bytes = 0;
	let tool_schema_bytes = 0;
	let opaque_reasoning_bytes = 0;
	// 顶层 CCPA JSON 外壳（model/project/requestId/generationConfig 等基础字段）
	let other_bytes = 256;
	let text_content_utf8_bytes = 0;

	const callIdToTool = new Map<string, string>();
	const images: SqliteUpstreamImageSnapshot[] = [];
	const toolResultTotals = new Map<string, SqliteUpstreamToolResultSnapshot>();

	const recordToolResultBytes = (
		toolName: string,
		textDelta: number,
		imageDelta: number,
	): SqliteUpstreamToolResultSnapshot => {
		const normalized = toolName || "unknown";
		let entry = toolResultTotals.get(normalized);
		if (!entry) {
			entry = { tool_name: normalized, text_bytes: 0, image_bytes: 0 };
			toolResultTotals.set(normalized, entry);
		}
		entry.text_bytes += textDelta;
		entry.image_bytes += imageDelta;
		return entry;
	};

	const analyzeEmbeddedAssistantText = (chunk: string): void => {
		const callRe = /<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/g;
		let cursor = 0;
		let match: RegExpExecArray | null;
		while ((match = callRe.exec(chunk)) !== null) {
			if (match.index > cursor) {
				const seg = chunk.slice(cursor, match.index);
				assistant_text_bytes += encodedJsonStringBytes(seg);
				text_content_utf8_bytes += Buffer.byteLength(seg, "utf8");
			}
			const callChunk = match[0];
			tool_call_bytes += encodedJsonStringBytes(callChunk);
			text_content_utf8_bytes += Buffer.byteLength(callChunk, "utf8");
			cursor = match.index + callChunk.length;
		}
		if (cursor < chunk.length) {
			const tail = chunk.slice(cursor);
			assistant_text_bytes += encodedJsonStringBytes(tail);
			text_content_utf8_bytes += Buffer.byteLength(tail, "utf8");
		}
	};

	const analyzeEmbeddedUserText = (text: string): string => {
		const unwrapped = text
			.replace(/^\s*<USER_REQUEST>\s*/i, "")
			.replace(/\s*<\/USER_REQUEST>[\s\S]*$/i, "");
		const totalEncoded = encodedJsonStringBytes(text);
		const unwrappedEncoded = encodedJsonStringBytes(unwrapped);
		if (totalEncoded > unwrappedEncoded) {
			other_bytes += totalEncoded - unwrappedEncoded;
		}

		const blockRe =
			/(<(?:workspace_context|task_instructions)>[\s\S]*?<\/(?:workspace_context|task_instructions)>)|(<tool_result\b([^>]*)>[\s\S]*?<\/tool_result>)|(<assistant\b[^>]*>[\s\S]*?<\/assistant>)/g;
		let cursor = 0;
		let match: RegExpExecArray | null;
		let trailingTool = "";

		while ((match = blockRe.exec(unwrapped)) !== null) {
			if (match.index > cursor) {
				const gap = unwrapped.slice(cursor, match.index);
				user_text_bytes += encodedJsonStringBytes(gap);
				text_content_utf8_bytes += Buffer.byteLength(gap, "utf8");
				if (gap.trim().length > 0) trailingTool = "";
			}
			const chunk = match[0];
			if (match[1] !== undefined) {
				system_bytes += encodedJsonStringBytes(chunk);
				text_content_utf8_bytes += Buffer.byteLength(chunk, "utf8");
				trailingTool = "";
			} else if (match[2] !== undefined) {
				const nameMatch = /\btool="([^"]+)"/.exec(match[3] ?? "");
				trailingTool = nameMatch?.[1] ?? "unknown";
				const enc = encodedJsonStringBytes(chunk);
				tool_result_bytes += enc;
				text_content_utf8_bytes += Buffer.byteLength(chunk, "utf8");
				recordToolResultBytes(trailingTool, enc, 0);
			} else {
				analyzeEmbeddedAssistantText(chunk);
				trailingTool = "";
			}
			cursor = match.index + chunk.length;
		}

		if (cursor < unwrapped.length) {
			const tail = unwrapped.slice(cursor);
			user_text_bytes += encodedJsonStringBytes(tail);
			text_content_utf8_bytes += Buffer.byteLength(tail, "utf8");
			if (
				tail.trim().length > 0 &&
				!/Please (?:inspect the attached tool result|continue using the tool output)/i.test(tail)
			) {
				trailingTool = "";
			}
		}
		return trailingTool;
	};

	let lastMessageFieldIdx = -1;
	for (let i = reqFields.length - 1; i >= 0; i--) {
		if (reqFields[i].field === 2 && reqFields[i].sub && reqFields[i].sub!.byteLength > 0) {
			lastMessageFieldIdx = i;
			break;
		}
	}

	for (let fieldIdx = 0; fieldIdx < reqFields.length; fieldIdx++) {
		const field = reqFields[fieldIdx];
		if (field.field === 1 && field.sub && field.sub.byteLength > 0) {
			// agy-tools / hybrid 模式下的原生系统提示词（如 <identity>...）
			const sysText = utf8Decoder.decode(field.sub);
			system_bytes += encodedJsonStringBytes(sysText);
			text_content_utf8_bytes += field.sub.byteLength;
			other_bytes += 36;
		} else if (field.field === 16 && field.sub && field.sub.byteLength > 0) {
			// 挂载的附加系统规则块（如 user_rules），提取子字段中的文本计入 system_bytes
			const ruleFields = parseRawProtobufFields(field.sub);
			for (const rf of ruleFields) {
				if (rf.sub && rf.sub.byteLength > 0) {
					const ruleText = utf8Decoder.decode(rf.sub);
					system_bytes += encodedJsonStringBytes(ruleText);
					text_content_utf8_bytes += rf.sub.byteLength;
				}
			}
			other_bytes += 24;
		} else if (field.field === 8 && field.sub && field.sub.byteLength > 0) {
			// ChatToolDefinition: f1=name, f2=description, f3=parametersSchemaJson
			const tf = parseRawProtobufFields(field.sub);
			const nameSub = tf.find((t) => t.field === 1)?.sub;
			const descSub = tf.find((t) => t.field === 2)?.sub;
			const schemaSub = tf.find((t) => t.field === 3)?.sub;
			const name = nameSub ? utf8Decoder.decode(nameSub) : "";
			const description = descSub ? utf8Decoder.decode(descSub) : "";
			const schemaBytes = schemaSub ? schemaSub.byteLength : 2;
			tool_schema_bytes +=
				Buffer.byteLength(JSON.stringify({ name, description }), "utf8") + schemaBytes + 18;
		} else if (field.field === 2 && field.sub && field.sub.byteLength > 0) {
			// ChatMessagePrompt
			const msgFields = parseRawProtobufFields(field.sub);
			const role = msgFields.find((m) => m.field === 2)?.val;
			// agy 在生成结束落盘 gen_metadata 时会将本轮刚产出的 assistant 输出追加为末尾 role=2 消息，
			// 该条消息尚未作为本轮输入发往云端（将在下一轮作为历史输入上传），须从本轮上传统计中排除。
			if (fieldIdx === lastMessageFieldIdx && role === 2) {
				continue;
			}
			other_bytes += 32;
			const callIdSub = msgFields.find((m) => m.field === 7)?.sub;
			const roleToolCallId = callIdSub ? utf8Decoder.decode(callIdSub) : "";
			let trailingTool = "";

			for (const mf of msgFields) {
				if (mf.field === 3 && mf.sub && mf.sub.byteLength > 0) {
					const text = utf8Decoder.decode(mf.sub);
					other_bytes += 12;
					if (role === 1) {
						trailingTool = analyzeEmbeddedUserText(text);
					} else if (role === 2) {
						assistant_text_bytes += encodedJsonStringBytes(text);
						text_content_utf8_bytes += mf.sub.byteLength;
					} else if (role === 4) {
						const enc = encodedJsonStringBytes(text);
						tool_result_bytes += enc;
						text_content_utf8_bytes += mf.sub.byteLength;
						const toolName = callIdToTool.get(roleToolCallId) ?? "unknown";
						recordToolResultBytes(toolName, enc, 0);
					} else {
						system_bytes += encodedJsonStringBytes(text);
						text_content_utf8_bytes += mf.sub.byteLength;
					}
				} else if (mf.field === 6 && mf.sub && mf.sub.byteLength > 0) {
					// ToolCall: f1=callId, f2=name, f3=argsJson, f7=thoughtSignature
					const tcf = parseRawProtobufFields(mf.sub);
					const tcIdSub = tcf.find((t) => t.field === 1)?.sub;
					const tcNameSub = tcf.find((t) => t.field === 2)?.sub;
					const tcArgsSub = tcf.find((t) => t.field === 3)?.sub;
					const tcSigSub = tcf.find((t) => t.field === 7)?.sub;
					const tcId = tcIdSub ? utf8Decoder.decode(tcIdSub) : "";
					const rawName = tcNameSub ? utf8Decoder.decode(tcNameSub) : "";
					const cleanName = stripHostMcpPrefix(rawName);
					if (tcId) callIdToTool.set(tcId, cleanName);
					const argsBytes = tcArgsSub ? tcArgsSub.byteLength : 2;
					tool_call_bytes +=
						Buffer.byteLength(JSON.stringify({ id: tcId, name: rawName }), "utf8") +
						argsBytes +
						12;
					other_bytes += 24;
					if (tcSigSub && tcSigSub.byteLength > 0) {
						const sigB64 = Math.ceil(tcSigSub.byteLength / 3) * 4;
						opaque_reasoning_bytes += sigB64;
						other_bytes += sigB64 + 24;
					}
				} else if (mf.field === 11 && mf.sub && mf.sub.byteLength > 0) {
					const thinkingText = utf8Decoder.decode(mf.sub);
					assistant_text_bytes += encodedJsonStringBytes(thinkingText);
					text_content_utf8_bytes += mf.sub.byteLength;
					other_bytes += 26;
				} else if (mf.field === 19 && mf.sub && mf.sub.byteLength > 0) {
					// Media: f1=mimeType, f2=rawImageBytes
					const mediaFields = parseRawProtobufFields(mf.sub);
					const mimeSub = mediaFields.find((m) => m.field === 1)?.sub;
					const rawSub = mediaFields.find((m) => m.field === 2)?.sub;
					const mimeType = mimeSub ? utf8Decoder.decode(mimeSub) : "";
					if (rawSub && rawSub.byteLength > 0 && mimeType.startsWith("image/")) {
						const decodedBytes = rawSub.byteLength;
						const base64Bytes = Math.ceil(decodedBytes / 3) * 4;
						const imageHash = computeCachedImageSha256(rawSub);
						let toolName = "";
						let sourceType = "user image";
						if (role === 4) {
							toolName = callIdToTool.get(roleToolCallId) ?? "unknown";
							sourceType = isReadLikeToolName(toolName)
								? "toolResult/read image"
								: "toolResult/other";
							recordToolResultBytes(toolName, 0, base64Bytes);
						} else if (role === 1 && trailingTool) {
							toolName = trailingTool;
							sourceType = isReadLikeToolName(toolName)
								? "toolResult/read image"
								: "toolResult/other";
							recordToolResultBytes(toolName, 0, base64Bytes);
						}
						image_payload_bytes += base64Bytes;
						image_decoded_bytes += decodedBytes;
						other_bytes += 48 + Buffer.byteLength(mimeType, "utf8");
						images.push({
							image_hash: imageHash,
							mime_type: mimeType,
							decoded_bytes: decodedBytes,
							base64_bytes: base64Bytes,
							image_payload_bytes: base64Bytes,
							source_type: sourceType,
							tool_name: toolName,
						});
					}
				} else if (mf.field === 20 && mf.sub && mf.sub.byteLength > 0) {
					const sigB64 = Math.ceil(mf.sub.byteLength / 3) * 4;
					opaque_reasoning_bytes += sigB64;
					other_bytes += sigB64 + 24;
				}
			}
		}
	}

	const total_payload_bytes =
		system_bytes +
		user_text_bytes +
		assistant_text_bytes +
		tool_call_bytes +
		tool_result_bytes +
		image_payload_bytes +
		tool_schema_bytes +
		other_bytes;

	const results = Array.from(toolResultTotals.values())
		.sort((a, b) => b.text_bytes + b.image_bytes - (a.text_bytes + a.image_bytes))
		.slice(0, 32);

	return {
		genIdx,
		total_payload_bytes,
		json_payload_bytes: total_payload_bytes,
		system_bytes,
		user_text_bytes,
		assistant_text_bytes,
		tool_call_bytes,
		tool_result_bytes,
		image_payload_bytes,
		image_decoded_bytes,
		tool_schema_bytes,
		opaque_reasoning_bytes,
		other_bytes,
		text_content_utf8_bytes,
		image_count: images.length,
		images,
		results,
	};
}

/** 读取指定会话当前 `gen_metadata` 表的最大 `idx`（新建会话尚无记录时返回 `-1`） */
export async function readCurrentMaxSqliteGenIdx(
	config: BridgeConfig,
	agySessionId: string,
): Promise<number> {
	if (!agySessionId) return -1;
	const dbPath = path.join(resolveAgyConversationsDir(config), `${agySessionId}.db`);
	if (!fs.existsSync(dbPath)) return -1;
	const sqlite = await loadNodeSqlite();
	if (!sqlite) return -1;

	let db: import("node:sqlite").DatabaseSync | undefined;
	try {
		db = openSqliteWithTimeout(sqlite, dbPath, true);
		const row = db
			.prepare("SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM gen_metadata")
			.get() as { maxIdx: number } | undefined;
		return typeof row?.maxIdx === "number" ? row.maxIdx : -1;
	} catch {
		return -1;
	} finally {
		try {
			db?.close();
		} catch {
			// 忽略
		}
	}
}

/** 以只读方式按代次提取上游请求快照，WAL 尚未落盘时短暂重试。 */
export async function readSqliteUpstreamRequestsSince(
	config: BridgeConfig,
	agySessionId: string,
	afterGenIdx: number,
	retryDelaysMs: readonly number[] = [20, 40],
): Promise<SqliteUpstreamQueryResult> {
	const empty: SqliteUpstreamQueryResult = { maxGenIdx: afterGenIdx, snapshots: [] };
	if (!agySessionId) return empty;
	const dbPath = path.join(resolveAgyConversationsDir(config), `${agySessionId}.db`);
	if (!fs.existsSync(dbPath)) return empty;
	const sqlite = await loadNodeSqlite();
	if (!sqlite) return empty;

	const probeOnce = (): SqliteUpstreamQueryResult => {
		let db: import("node:sqlite").DatabaseSync | undefined;
		try {
			db = openSqliteWithTimeout(sqlite, dbPath, true, 100);
			// 先读取索引，再逐条解析，避免同时加载多条可能含有大图的请求。
			const rows = db.prepare("SELECT idx FROM gen_metadata WHERE idx > ? ORDER BY idx").all(afterGenIdx) as { idx: number }[];
			const selectData = db.prepare("SELECT data FROM gen_metadata WHERE idx = ?");
			const snapshots: SqliteUpstreamRequestSnapshot[] = [];
			for (const { idx } of rows) {
				const row = selectData.get(idx) as { data?: Uint8Array | null } | undefined;
				const snapshot = row?.data?.length ? parseGenMetadataUpstreamRequest(row.data, idx) : undefined;
				if (snapshot) snapshots.push(snapshot);
			}
			return { snapshots, maxGenIdx: rows.at(-1)?.idx ?? afterGenIdx };
		} catch {
			return empty;
		} finally {
			try {
				db?.close();
			} catch {
				// 忽略
			}
		}
	};

	const first = probeOnce();
	if (first.maxGenIdx > afterGenIdx) return first;
	for (const delay of retryDelaysMs) {
		await new Promise((r) => setTimeout(r, delay));
		const next = probeOnce();
		if (next.maxGenIdx > afterGenIdx) return next;
	}
	return empty;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 在工具边界切入用户转向消息（`steer`）前，等待刚结算的 loopback HTTP 工具结果落盘为非进行中状态（`status != 1`），
 * 确保随后的 `session/cancel` 不会误冲掉已完成工具的持久化输出。
 */
export async function waitForSqliteToolStepsSettled(
	config: BridgeConfig,
	agySessionId: string,
	maxWaitMs = 160,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return;
	const dbPath = agySessionId
		? path.join(resolveAgyConversationsDir(config), `${agySessionId}.db`)
		: "";
	if (!dbPath || !fs.existsSync(dbPath)) {
		await sleepWithAbort(25, signal);
		return;
	}
	const sqlite = await loadNodeSqlite();
	if (!sqlite) {
		await sleepWithAbort(25, signal);
		return;
	}

	await sleepWithAbort(20, signal);
	if (signal?.aborted) return;
	const deadline = Date.now() + Math.max(20, maxWaitMs - 20);
	while (Date.now() < deadline && !signal?.aborted) {
		let hasRunningTool = false;
		let db: import("node:sqlite").DatabaseSync | undefined;
		try {
			db = openSqliteWithTimeout(sqlite, dbPath, true, 200);
			const busy = db
				.prepare(
					"SELECT 1 AS busy FROM steps WHERE step_type != 15 AND step_type != 14 AND status IN (1, 2, 8, 9, 11) LIMIT 1",
				)
				.get() as { busy?: number } | undefined;
			hasRunningTool = busy?.busy === 1;
		} catch {
			hasRunningTool = false;
		} finally {
			try {
				db?.close();
			} catch {
				// 忽略
			}
		}
		if (!hasRunningTool) {
			return;
		}
		await sleepWithAbort(15, signal);
	}
}

function readSqliteWatermarks(db: import("node:sqlite").DatabaseSync): Omit<SqliteDbCheckpoint, "fingerprint"> {
	return db.prepare(`SELECT
		(SELECT COALESCE(MAX(idx) + 1, 0) FROM steps) AS steps,
		(SELECT COALESCE(MAX(idx) + 1, 0) FROM gen_metadata) AS generations,
		(SELECT COALESCE(MAX(idx) + 1, 0) FROM executor_metadata) AS executions
	`).get() as Omit<SqliteDbCheckpoint, "fingerprint">;
}

/**
 * Captures a read-only high-watermark checkpoint of agy's conversation SQLite DB.
 * Retries briefly when the DB file, schema, or WAL flush is not yet visible or a transient
 * lock occurs, returning `undefined` if no steps are persisted after all attempts.
 */
export async function captureSqliteCheckpoint(
	config: BridgeConfig,
	agySessionId: string,
	retryDelaysMs: readonly number[] = [25, 50],
): Promise<SqliteDbCheckpoint | undefined> {
	if (!agySessionId) return undefined;
	const sqlite = await loadNodeSqlite();
	if (!sqlite) return undefined;
	const dbPath = path.join(resolveAgyConversationsDir(config), `${agySessionId}.db`);

	const captureOnce = (): SqliteDbCheckpoint | undefined => {
		if (!fs.existsSync(dbPath)) {
			return undefined;
		}
		let db: import("node:sqlite").DatabaseSync | undefined;
		try {
			db = openSqliteWithTimeout(sqlite, dbPath, true);
			if (!verifyRequiredTables(db)) {
				return undefined;
			}

			// Read watermarks and step fingerprint from a single WAL read snapshot.
			db.exec("BEGIN");
			const watermarks = readSqliteWatermarks(db);
			if (watermarks.steps <= 0) return undefined;
			return { ...watermarks, fingerprint: computeStepsPrefixFingerprint(db, watermarks.steps) };
		} catch {
			return undefined;
		} finally {
			try {
				db?.close();
			} catch {
				// Ignore close errors.
			}
		}
	};

	const first = captureOnce();
	if (first) return first;

	for (const delay of retryDelaysMs) {
		await new Promise((resolve) => setTimeout(resolve, delay));
		const next = captureOnce();
		if (next) return next;
	}
	return undefined;
}

/**
 * 基于 `VACUUM INTO` 只读副本导出与水位截断，从历史锚点分叉出全新的 AGY 会话数据库文件。
 * 严格遵循只读原库原则；若校验不通过或出现任何文件锁异常，立即清理临时副本并返回 `undefined` 以便调用方无感降级至 `FreshReplay`。
 */
export async function forkSqliteConversationAtCheckpoint(
	config: BridgeConfig,
	sourceSessionId: string,
	checkpoint: SqliteDbCheckpoint,
): Promise<string | undefined> {
	if (!config.enableSqliteFork) {
		return undefined;
	}
	const convDir = resolveAgyConversationsDir(config);
	const sourceDbPath = path.join(convDir, `${sourceSessionId}.db`);
	if (!fs.existsSync(sourceDbPath)) {
		return undefined;
	}

	const sqlite = await loadNodeSqlite();
	if (!sqlite) return undefined;

	const forkedSessionId = crypto.randomUUID();
	const targetDbPath = path.join(convDir, `${forkedSessionId}.db`);
	const escapedTarget = targetDbPath.replace(/'/g, "''");

	let srcDb: import("node:sqlite").DatabaseSync | undefined;
	try {
		srcDb = openSqliteWithTimeout(sqlite, sourceDbPath, true);
		if (!verifyRequiredTables(srcDb)) {
			return undefined;
		}
		srcDb.exec(`VACUUM INTO '${escapedTarget}'`);
	} catch {
		cleanupDbFilesSafe(targetDbPath);
		return undefined;
	} finally {
		try {
			srcDb?.close();
		} catch {
			// 忽略
		}
	}

	let origTrajectoryId: string | undefined;
	let dstDb: import("node:sqlite").DatabaseSync | undefined;
	try {
		dstDb = openSqliteWithTimeout(sqlite, targetDbPath, false);
		// 在副本上校验检查点，原库可以在复制期间继续接收写入。
		const watermarks = readSqliteWatermarks(dstDb);
		if (
			watermarks.steps < checkpoint.steps ||
			watermarks.generations < checkpoint.generations ||
			watermarks.executions < checkpoint.executions ||
			computeStepsPrefixFingerprint(dstDb, checkpoint.steps) !== checkpoint.fingerprint
		) {
			throw new Error("SQLite session copy does not match the saved checkpoint");
		}
		const origMeta = dstDb
			.prepare("SELECT trajectory_id FROM trajectory_meta LIMIT 1")
			.get() as { trajectory_id?: string } | undefined;
		origTrajectoryId = origMeta?.trajectory_id;
		dstDb.exec("BEGIN IMMEDIATE");
		dstDb.prepare("DELETE FROM steps WHERE idx >= ?").run(checkpoint.steps);
		dstDb.prepare("DELETE FROM parent_references WHERE idx >= ?").run(checkpoint.steps);
		const hasBattleTable = dstDb
			.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'battle_mode_infos'")
			.get();
		if (hasBattleTable) {
			dstDb.prepare("DELETE FROM battle_mode_infos WHERE idx >= ?").run(checkpoint.steps);
		}
		dstDb.prepare("DELETE FROM gen_metadata WHERE idx >= ?").run(checkpoint.generations);
		dstDb.prepare("DELETE FROM executor_metadata WHERE idx >= ?").run(checkpoint.executions);
		dstDb
			.prepare("UPDATE trajectory_meta SET trajectory_id = ?, cascade_id = ?")
			.run(forkedSessionId, forkedSessionId);
		rewriteMetadataBlobUuids(dstDb, [sourceSessionId, origTrajectoryId], forkedSessionId);
		dstDb.exec("COMMIT");
		return forkedSessionId;
	} catch {
		try {
			dstDb?.close();
		} catch {
			// 忽略关闭异常
		}
		dstDb = undefined;
		cleanupDbFilesSafe(targetDbPath);
		return undefined;
	} finally {
		try {
			dstDb?.close();
		} catch {
			// 忽略关闭异常
		}
	}
}

const CORTEX_STEP_TYPE_USER_INPUT = 14;
const CORTEX_STEP_TYPE_PLANNER_RESPONSE = 15;
const CORTEX_STEP_STATUS_DONE = 3;
const CORTEX_TRAJECTORY_TYPE_INTERACTIVE_CASCADE = 4;
const CORTEX_TRAJECTORY_SOURCE_CLI = 17;

function encodeProtobufVarint(value: number | bigint): Buffer {
	let v = typeof value === "bigint" ? value : BigInt(value);
	const out: number[] = [];
	while (v >= 0x80n) {
		out.push(Number((v & 0x7fn) | 0x80n));
		v >>= 7n;
	}
	out.push(Number(v));
	return Buffer.from(out);
}

function encodeProtobufVarintField(fieldNo: number, value: number | bigint): Buffer {
	return Buffer.concat([encodeProtobufVarint((fieldNo << 3) | 0), encodeProtobufVarint(value)]);
}

function encodeProtobufBytesField(fieldNo: number, payload: Buffer | string): Buffer {
	const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
	return Buffer.concat([
		encodeProtobufVarint((fieldNo << 3) | 2),
		encodeProtobufVarint(buf.length),
		buf,
	]);
}

/** 构造 AGY `CortexStep`（`USER_INPUT`）最小标准 Protobuf 载荷 */
export function encodeUserInputStepPayload(text: string): Buffer {
	// CortexStepUserInput: field 2 = user_response, field 3 = items (TextOrScopeItem { field 1 = text })
	const textItem = encodeProtobufBytesField(1, text);
	const userInput = Buffer.concat([
		encodeProtobufBytesField(2, text),
		encodeProtobufBytesField(3, textItem),
	]);
	return Buffer.concat([
		encodeProtobufVarintField(1, CORTEX_STEP_TYPE_USER_INPUT),
		encodeProtobufVarintField(4, CORTEX_STEP_STATUS_DONE),
		encodeProtobufBytesField(19, userInput),
	]);
}

/** 构造 AGY `CortexStep`（`PLANNER_RESPONSE`）最小标准 Protobuf 载荷 */
export function encodePlannerResponseStepPayload(text: string): Buffer {
	// CortexStepPlannerResponse: field 1 = response, field 8 = modified_response
	const plannerResponse = Buffer.concat([
		encodeProtobufBytesField(1, text),
		encodeProtobufBytesField(8, text),
	]);
	return Buffer.concat([
		encodeProtobufVarintField(1, CORTEX_STEP_TYPE_PLANNER_RESPONSE),
		encodeProtobufVarintField(4, CORTEX_STEP_STATUS_DONE),
		encodeProtobufBytesField(20, plannerResponse),
	]);
}

/**
 * 校验已有本地会话库是否携带有效的 `trajectory_metadata_blob`（以及 `pi-tools` 模式下必需的 `pi-bridge` 标识）。
 * 用于在恢复或分叉历史锚点前自动识别并隔离旧版无元数据裸库，避免 `session/resume` 回退启用 Antigravity 原生内置工具。
 */
export async function hasValidAgentMetadataBlob(
	config: BridgeConfig,
	agySessionId: string,
	requiredAgentSubstring?: string,
): Promise<boolean> {
	if (!agySessionId) return true;
	const dbPath = path.join(resolveAgyConversationsDir(config), `${agySessionId}.db`);
	if (!fs.existsSync(dbPath)) {
		return true;
	}
	const sqlite = await loadNodeSqlite();
	if (!sqlite) return true;

	let db: import("node:sqlite").DatabaseSync | undefined;
	try {
		db = openSqliteWithTimeout(sqlite, dbPath, true, 500);
		const hasBlobTable = db
			.prepare(
				"SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'trajectory_metadata_blob'",
			)
			.get();
		if (!hasBlobTable) {
			return true;
		}
		const rows = db
			.prepare("SELECT data FROM trajectory_metadata_blob WHERE data IS NOT NULL AND length(data) > 0")
			.all() as Array<{ data: Uint8Array }>;
		if (rows.length === 0) {
			return false;
		}
		if (requiredAgentSubstring) {
			return rows.some((row) =>
				Buffer.from(row.data).toString("utf8").includes(requiredAgentSubstring),
			);
		}
		return true;
	} catch {
		return true;
	} finally {
		try {
			db?.close();
		} catch {
			// 忽略
		}
	}
}

/**
 * 在克隆出的 `.db` 的 `trajectory_metadata_blob` 中将旧 UUID 等长替换为新 UUID。
 * 仅对长度完全相等的 ASCII UUID 执行原位字节替换，不破坏 Protobuf 长度前缀编码。
 */
function rewriteMetadataBlobUuids(
	db: import("node:sqlite").DatabaseSync,
	oldIds: readonly (string | undefined)[],
	newId: string,
): void {
	const hasBlobTable = db
		.prepare(
			"SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'trajectory_metadata_blob'",
		)
		.get();
	if (!hasBlobTable) return;

	const targets = Array.from(
		new Set(
			oldIds.filter(
				(id): id is string =>
					typeof id === "string" && id.length === newId.length && id !== newId,
			),
		),
	);
	if (targets.length === 0) return;

	const newBytes = Buffer.from(newId, "ascii");
	const rows = db
		.prepare("SELECT id, data FROM trajectory_metadata_blob WHERE data IS NOT NULL")
		.all() as Array<{ id: string; data: Uint8Array }>;
	const updateStmt = db.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = ?");

	for (const row of rows) {
		const buf = Buffer.from(row.data);
		let changed = false;
		for (const oldId of targets) {
			const oldBytes = Buffer.from(oldId, "ascii");
			let offset = 0;
			while ((offset = buf.indexOf(oldBytes, offset)) !== -1) {
				newBytes.copy(buf, offset);
				offset += newBytes.length;
				changed = true;
			}
		}
		if (changed) {
			updateStmt.run(buf, row.id);
		}
	}
}

/**
 * 基于刚刚由官方 `agy session/new` 创建的空白模板会话数据库，通过只读 `VACUUM INTO` 克隆出全新 UUID 的
 * 会话库并写入多步预注入 `(USER_INPUT, PLANNER_RESPONSE)` 历史分片。
 *
 * 与从零建表不同，该方法完整保留 `agy` 原生写入 `trajectory_metadata_blob` 的 `CustomAgentSpec`
 * （如 `pi-tools` 模式下的 `pi-bridge` 禁用内置工具与默认组件规格、挂载插件、工作区 URI 与权限策略），
 * 防止 `session/resume` 找不到 Agent 元数据时回退启用 Antigravity 原生内置工具与工作流。
 */
export async function cloneTemplateSqliteConversationWithPreload(
	config: BridgeConfig,
	templateSessionId: string,
	turns: readonly PreloadedSqliteTurn[],
	options?: { signal?: AbortSignal },
): Promise<string | undefined> {
	if (!config.enableSqliteFork || !templateSessionId || turns.length === 0) {
		return undefined;
	}
	const sqlite = await loadNodeSqlite();
	if (!sqlite) return undefined;

	const convDir = resolveAgyConversationsDir(config);
	const templateDbPath = path.join(convDir, `${templateSessionId}.db`);

	// 等待刚刚关闭的模板会话完成 SQLite/WAL 落盘（最长 1200ms，快速轮询并响应取消信号）
	const deadline = Date.now() + 1_200;
	let templateReady = false;
	while (!options?.signal?.aborted) {
		if (fs.existsSync(templateDbPath)) {
			let probeDb: import("node:sqlite").DatabaseSync | undefined;
			try {
				probeDb = openSqliteWithTimeout(sqlite, templateDbPath, true, 300);
				if (verifyRequiredTables(probeDb)) {
					const hasBlobTable = probeDb
						.prepare(
							"SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'trajectory_metadata_blob'",
						)
						.get();
					if (hasBlobTable) {
						const blobRow = probeDb
							.prepare(
								"SELECT count(*) AS c FROM trajectory_metadata_blob WHERE data IS NOT NULL AND length(data) > 0",
							)
							.get() as { c?: number } | undefined;
						if (Number(blobRow?.c ?? 0) > 0) {
							templateReady = true;
							break;
						}
					}
				}
			} catch {
				// 模板仍在 WAL 刷盘中，短等后重试
			} finally {
				try {
					probeDb?.close();
				} catch {
					// 忽略
				}
			}
		}
		if (Date.now() >= deadline) {
			break;
		}
		await sleepWithAbort(20, options?.signal);
	}

	if (!templateReady || options?.signal?.aborted) {
		return undefined;
	}

	const clonedSessionId = crypto.randomUUID();
	const targetDbPath = path.join(convDir, `${clonedSessionId}.db`);
	const escapedTarget = targetDbPath.replace(/'/g, "''");

	let srcDb: import("node:sqlite").DatabaseSync | undefined;
	try {
		srcDb = openSqliteWithTimeout(sqlite, templateDbPath, true);
		srcDb.exec(`VACUUM INTO '${escapedTarget}'`);
	} catch {
		cleanupDbFilesSafe(targetDbPath);
		return undefined;
	} finally {
		try {
			srcDb?.close();
		} catch {
			// 忽略
		}
	}

	let dstDb: import("node:sqlite").DatabaseSync | undefined;
	try {
		dstDb = openSqliteWithTimeout(sqlite, targetDbPath, false);
		const origMeta = dstDb
			.prepare("SELECT trajectory_id FROM trajectory_meta LIMIT 1")
			.get() as { trajectory_id?: string } | undefined;

		dstDb.exec("BEGIN IMMEDIATE");
		dstDb.prepare("DELETE FROM steps").run();
		dstDb.prepare("DELETE FROM parent_references").run();
		const hasBattleTable = dstDb
			.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'battle_mode_infos'")
			.get();
		if (hasBattleTable) {
			dstDb.prepare("DELETE FROM battle_mode_infos").run();
		}
		dstDb.prepare("DELETE FROM gen_metadata").run();
		dstDb.prepare("DELETE FROM executor_metadata").run();
		dstDb
			.prepare("UPDATE trajectory_meta SET trajectory_id = ?, cascade_id = ?")
			.run(clonedSessionId, clonedSessionId);
		rewriteMetadataBlobUuids(
			dstDb,
			[templateSessionId, origMeta?.trajectory_id],
			clonedSessionId,
		);

		const insertStep = dstDb.prepare(
			"INSERT INTO steps (idx, step_type, status, has_subtrajectory, step_payload, step_format) VALUES (?, ?, ?, 0, ?, 0)",
		);
		let idx = 0;
		for (const turn of turns) {
			insertStep.run(
				idx++,
				CORTEX_STEP_TYPE_USER_INPUT,
				CORTEX_STEP_STATUS_DONE,
				encodeUserInputStepPayload(turn.userText),
			);
			insertStep.run(
				idx++,
				CORTEX_STEP_TYPE_PLANNER_RESPONSE,
				CORTEX_STEP_STATUS_DONE,
				encodePlannerResponseStepPayload(turn.assistantAckText),
			);
		}
		dstDb.exec("COMMIT");
		return clonedSessionId;
	} catch {
		try {
			dstDb?.exec("ROLLBACK");
		} catch {
			// 忽略
		}
		cleanupDbFilesSafe(targetDbPath);
		return undefined;
	} finally {
		try {
			dstDb?.close();
		} catch {
			// 忽略
		}
	}
}

/**
 * 新建一个独立 UUID 的 AGY 本地 SQLite 会话数据库，并将超长历史的多个安全分片以
 * `(USER_INPUT, PLANNER_RESPONSE)` 交替步预注入 `steps` 表（底层最小建库实现；生产路径请优先使用
 * `cloneTemplateSqliteConversationWithPreload` 以保留 `agy` 原生 `trajectory_metadata_blob` Agent 规格）。
 */
export async function createPreloadedSqliteConversation(
	config: BridgeConfig,
	turns: readonly PreloadedSqliteTurn[],
): Promise<string | undefined> {
	if (!config.enableSqliteFork || turns.length === 0) {
		return undefined;
	}

	const sqlite = await loadNodeSqlite();
	if (!sqlite) return undefined;

	const convDir = resolveAgyConversationsDir(config);
	try {
		fs.mkdirSync(convDir, { recursive: true });
	} catch {
		return undefined;
	}

	const sessionId = crypto.randomUUID();
	const dbPath = path.join(convDir, `${sessionId}.db`);

	let db: import("node:sqlite").DatabaseSync | undefined;
	try {
		db = openSqliteWithTimeout(sqlite, dbPath, false);
		db.exec(`
			PRAGMA user_version = 1;
			CREATE TABLE trajectory_meta (
				trajectory_id text,
				cascade_id text,
				trajectory_type integer,
				source integer,
				PRIMARY KEY (trajectory_id)
			);
			CREATE TABLE steps (
				idx integer,
				step_type integer NOT NULL DEFAULT 0,
				status integer NOT NULL DEFAULT 0,
				has_subtrajectory numeric NOT NULL DEFAULT false,
				metadata blob,
				error_details blob,
				permissions blob,
				task_details blob,
				render_info blob,
				step_payload blob,
				step_format integer NOT NULL DEFAULT 0,
				PRIMARY KEY (idx)
			);
			CREATE INDEX idx_steps_status ON steps(status);
			CREATE INDEX idx_steps_step_type ON steps(step_type);
			CREATE TABLE gen_metadata (
				idx integer,
				data blob,
				size integer NOT NULL DEFAULT 0,
				PRIMARY KEY (idx)
			);
			CREATE TABLE executor_metadata (
				idx integer,
				data blob,
				PRIMARY KEY (idx)
			);
			CREATE TABLE parent_references (
				idx integer,
				data blob,
				PRIMARY KEY (idx)
			);
			CREATE TABLE trajectory_metadata_blob (
				id text DEFAULT "main",
				data blob,
				PRIMARY KEY (id)
			);
			CREATE TABLE battle_mode_infos (
				idx integer,
				data blob,
				PRIMARY KEY (idx)
			);
		`);

		db.exec("BEGIN IMMEDIATE");
		db.prepare(
			"INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)",
		).run(
			sessionId,
			sessionId,
			CORTEX_TRAJECTORY_TYPE_INTERACTIVE_CASCADE,
			CORTEX_TRAJECTORY_SOURCE_CLI,
		);

		const insertStep = db.prepare(
			"INSERT INTO steps (idx, step_type, status, has_subtrajectory, step_payload, step_format) VALUES (?, ?, ?, 0, ?, 0)",
		);
		let idx = 0;
		for (const turn of turns) {
			insertStep.run(
				idx++,
				CORTEX_STEP_TYPE_USER_INPUT,
				CORTEX_STEP_STATUS_DONE,
				encodeUserInputStepPayload(turn.userText),
			);
			insertStep.run(
				idx++,
				CORTEX_STEP_TYPE_PLANNER_RESPONSE,
				CORTEX_STEP_STATUS_DONE,
				encodePlannerResponseStepPayload(turn.assistantAckText),
			);
		}
		db.exec("COMMIT");
		return sessionId;
	} catch {
		try {
			db?.exec("ROLLBACK");
		} catch {
			// 忽略
		}
		cleanupDbFilesSafe(dbPath);
		return undefined;
	} finally {
		try {
			db?.close();
		} catch {
			// 忽略
		}
	}
}

/**
 * 向刚通过 `forkSqliteConversationAtCheckpoint` 克隆出的新分叉 `.db` 末尾追加预注入分片步。
 * 仅用于尚未被 `agy` 打开的新分叉副本，严禁对正在运行的原库直接调用。
 */
export async function appendPreloadedTurnsToSqliteConversation(
	config: BridgeConfig,
	forkedSessionId: string,
	turns: readonly PreloadedSqliteTurn[],
): Promise<boolean> {
	if (!config.enableSqliteFork || !forkedSessionId || turns.length === 0) {
		return false;
	}
	const dbPath = path.join(resolveAgyConversationsDir(config), `${forkedSessionId}.db`);
	if (!fs.existsSync(dbPath)) {
		return false;
	}
	const sqlite = await loadNodeSqlite();
	if (!sqlite) return false;

	let db: import("node:sqlite").DatabaseSync | undefined;
	try {
		db = openSqliteWithTimeout(sqlite, dbPath, false);
		if (!verifyRequiredTables(db)) {
			return false;
		}
		const lastRow = db
			.prepare("SELECT idx, step_type FROM steps ORDER BY idx DESC LIMIT 1")
			.get() as { idx?: number; step_type?: number } | undefined;
		let nextIdx = typeof lastRow?.idx === "number" ? lastRow.idx + 1 : 0;

		db.exec("BEGIN IMMEDIATE");
		const insertStep = db.prepare(
			"INSERT INTO steps (idx, step_type, status, has_subtrajectory, step_payload, step_format) VALUES (?, ?, ?, 0, ?, 0)",
		);
		// 若原分叉尾部停在 USER_INPUT，先补一条中性 PLANNER_RESPONSE 保持严格交替角色合法性
		if (lastRow?.step_type === CORTEX_STEP_TYPE_USER_INPUT) {
			insertStep.run(
				nextIdx++,
				CORTEX_STEP_TYPE_PLANNER_RESPONSE,
				CORTEX_STEP_STATUS_DONE,
				encodePlannerResponseStepPayload("Continuing session context."),
			);
		}
		for (const turn of turns) {
			insertStep.run(
				nextIdx++,
				CORTEX_STEP_TYPE_USER_INPUT,
				CORTEX_STEP_STATUS_DONE,
				encodeUserInputStepPayload(turn.userText),
			);
			insertStep.run(
				nextIdx++,
				CORTEX_STEP_TYPE_PLANNER_RESPONSE,
				CORTEX_STEP_STATUS_DONE,
				encodePlannerResponseStepPayload(turn.assistantAckText),
			);
		}
		db.exec("COMMIT");
		return true;
	} catch {
		try {
			db?.exec("ROLLBACK");
		} catch {
			// 忽略
		}
		return false;
	} finally {
		try {
			db?.close();
		} catch {
			// 忽略
		}
	}
}

function cleanupDbFilesSafe(baseDbPath: string): void {
	for (const ext of ["", "-wal", "-shm", "-journal"]) {
		try {
			const candidate = `${baseDbPath}${ext}`;
			if (fs.existsSync(candidate)) {
				fs.unlinkSync(candidate);
			}
		} catch {
			// 忽略
		}
	}
}
