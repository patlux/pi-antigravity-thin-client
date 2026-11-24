import * as crypto from "node:crypto";
import {
	getCurrentSystemPrompt,
	getCurrentTools,
	type AssistantMessage,
	type ImageContent,
	type Message,
	type SimpleStreamOptions,
	type TextContent,
	type ToolResultMessage,
	type TranscriptContext,
	type UserMessage,
	withoutInitialSystemMessage,
} from "@earendil-works/pi-ai";
import type { AcpPromptBlock } from "../acp/protocol.ts";
import { REPLAY_REFUSED, ThinClientPolicyError } from "../thin-client-policy.ts";

/** 提取去除一切 `system` 消息后的模型可见对话序列 */
export function extractVisibleMessages(
	messages: readonly Message[],
): Array<UserMessage | AssistantMessage | ToolResultMessage> {
	const stripped = withoutInitialSystemMessage([...messages]);
	return stripped.filter(
		(m): m is UserMessage | AssistantMessage | ToolResultMessage => m.role !== "system",
	);
}

const TRAFFIC_OPT_TOOL_PLACEHOLDER_REGEX =
	/^\[(?:已归档|历史 recall 页)\s+(ctx:\/\/tool\/[a-f0-9]{16,64})\]/;
const TRAFFIC_OPT_IMAGE_PLACEHOLDER_REGEX =
	/^\[已归档图片\s+(ctx:\/\/image\/[a-f0-9]{16,64})\]/;

/** 判断文本块是否为 `pi-traffic-optimization` 归档投影生成的工具/recall 页占位符 */
export function isTrafficOptToolPlaceholder(text: string): boolean {
	return TRAFFIC_OPT_TOOL_PLACEHOLDER_REGEX.test(text);
}

/** 判断文本块是否为 `pi-traffic-optimization` 归档投影生成的图片占位符 */
export function isTrafficOptImagePlaceholder(text: string): boolean {
	return TRAFFIC_OPT_IMAGE_PLACEHOLDER_REGEX.test(text);
}

export interface TrafficOptProjectionState {
	/** 消息序列中存在的归档投影占位符总数（工具结果、历史 recall 页与图片） */
	archivedCount: number;
	/** 有序归档占位符集合的确定性 SHA-256 指纹（无投影时为空字符串） */
	projectionDigest: string;
}

/**
 * 扫描模型可见消息中的 `pi-traffic-optimization` 归档投影状态，
 * 用于在批量 GC 触发后精准检测投影变化并驱动有状态 AGY 会话按需瘦身重建，同时在非 GC 轮次零打扰热缓存。
 */
export function inspectTrafficOptProjectionState(
	visibleMessages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
): TrafficOptProjectionState {
	const entries: string[] = [];
	for (let i = 0; i < visibleMessages.length; i++) {
		const msg = visibleMessages[i];
		if (msg.role === "toolResult") {
			for (let j = 0; j < msg.content.length; j++) {
				const part = msg.content[j];
				if (part.type !== "text") continue;
				const toolMatch = TRAFFIC_OPT_TOOL_PLACEHOLDER_REGEX.exec(part.text);
				if (toolMatch) {
					entries.push(`t:${msg.toolCallId}:${j}:${toolMatch[1]}`);
					continue;
				}
				const imgMatch = TRAFFIC_OPT_IMAGE_PLACEHOLDER_REGEX.exec(part.text);
				if (imgMatch) {
					entries.push(`ti:${msg.toolCallId}:${j}:${imgMatch[1]}`);
				}
			}
		} else if (msg.role === "user" && Array.isArray(msg.content)) {
			for (let j = 0; j < msg.content.length; j++) {
				const part = msg.content[j];
				if (part.type !== "text") continue;
				const imgMatch = TRAFFIC_OPT_IMAGE_PLACEHOLDER_REGEX.exec(part.text);
				if (imgMatch) {
					entries.push(`ui:${i}:${j}:${imgMatch[1]}`);
				}
			}
		}
	}
	if (entries.length === 0) {
		return { archivedCount: 0, projectionDigest: "" };
	}
	const hash = crypto.createHash("sha256");
	for (const item of entries) {
		hash.update(`${item}\n`);
	}
	return {
		archivedCount: entries.length,
		projectionDigest: hash.digest("hex"),
	};
}

/**
 * 提取对话结构身份特征用于会话连续性与分支锚点校验。
 * 对 `ToolResultMessage` 与历史图片块仅采集不可变结构标识（忽略图片压缩后的 `mimeType` 变更，
 * 并将用户图片归档占位符归一为 `{ type: "image" }`），
 * 确保 `pi-traffic-optimization`（图片 WebP 压缩、工具输出/图片归档投影）或 `pi-orca-images` 等 `context` 钩子改写载荷后，
 * 原始 `turn_end` 锚点与投影后的 `streamSimple` 上下文仍 100% 精确匹配，绝不误拆健康热缓存会话。
 */
function canonicalizeMessage(msg: UserMessage | AssistantMessage | ToolResultMessage): unknown {
	if (msg.role === "user") {
		if (typeof msg.content === "string") {
			return { role: "user", text: msg.content };
		}
		return {
			role: "user",
			parts: msg.content.map((part) =>
				part.type === "image" || isTrafficOptImagePlaceholder(part.text)
					? { type: "image" }
					: { type: "text", text: part.text },
			),
		};
	}

	if (msg.role === "assistant") {
		return {
			role: "assistant",
			parts: msg.content.map((part) => {
				if (part.type === "text") {
					return { type: "text", text: part.text };
				}
				if (part.type === "thinking") {
					return { type: "thinking", thinking: part.thinking };
				}
				return {
					type: "toolCall",
					id: part.id,
					name: part.name,
					arguments: part.arguments,
				};
			}),
		};
	}

	return {
		role: "toolResult",
		toolCallId: msg.toolCallId,
		toolName: msg.toolName,
		isError: msg.isError,
	};
}

/**
 * 计算有序可见消息列表的确定性 SHA-256 摘要（忽略时间戳与统计噪音）。
 */
export function computeTranscriptDigest(
	visibleMessages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
): string {
	const hash = crypto.createHash("sha256");
	for (const msg of visibleMessages) {
		hash.update(`${JSON.stringify(canonicalizeMessage(msg))}\n`);
	}
	return hash.digest("hex");
}

const SUMMARY_USER_HINT_PATTERN =
	/(?:<conversation>|summarize\s+(?:the|this)\s+(?:conversation|session|branch)|for\s+compaction|compaction\s+summary|context\s+summary|structured\s+checkpoint|update\s+the\s+previous\s+summary|create\s+a\s+(?:structured\s+)?checkpoint)/i;

export const SUMMARY_SYSTEM_HINT_PATTERN =
	/(?:context\s+summarization\s+assistant|do\s+not\s+continue\s+the\s+conversation|summarize\s+the\s+conversation)/i;

/**
 * 判定当前请求是否为后台单轮无工具辅助请求（例如 `/compact` 生成摘要、`/tree` 分支总结或缓存预热）。
 * 辅助请求将分配独立临时 ACP Session，避免污染主会话状态；同时避免误伤用户在 `--no-tools` 下首轮普通的总结类提问。
 */
export function isAuxiliarySingleTurnRequest(
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	hasBusyPrimaryTurn: boolean,
): boolean {
	if (options?.disableContinuation === true) {
		return true;
	}
	if (options?.toolChoice === "none") {
		return true;
	}

	const tools = getCurrentTools(context.messages);
	const visible = extractVisibleMessages(context.messages);

	if (tools.length === 0 && visible.length <= 2) {
		const sysText = getCurrentSystemPrompt(context.messages);
		if (sysText && SUMMARY_SYSTEM_HINT_PATTERN.test(sysText)) {
			return true;
		}
		const last = visible[visible.length - 1];
		if (last?.role === "user") {
			const text =
				typeof last.content === "string"
					? last.content
					: last.content
							.filter((c): c is TextContent => c.type === "text")
							.map((c) => c.text)
							.join("\n");
			if (SUMMARY_USER_HINT_PATTERN.test(text)) {
				return true;
			}
		}
		if (hasBusyPrimaryTurn) {
			return true;
		}
	}

	return false;
}

/**
 * 为后台无状态辅助请求（如 `/compact`、`/tree` 分支摘要）提取宿主传入的任务说明文本，
 * 通过用户消息块传递给临时会话，确保摘要约束与输出格式生效且不修改任何官方系统提示词。
 */
export function extractAuxiliaryTaskInstructions(context: TranscriptContext): string | undefined {
	const raw = getCurrentSystemPrompt(context.messages)?.trim();
	if (!raw) return undefined;
	if (raw.length > 8_000) {
		return raw.slice(0, 8_000);
	}
	return raw;
}

/** 将单条或多条新增的 `UserMessage` 转换为 ACP `PromptBlock[]` */
export function convertUserMessagesToPromptBlocks(
	messages: readonly UserMessage[],
): AcpPromptBlock[] {
	const blocks: AcpPromptBlock[] = [];
	for (const msg of messages) {
		if (typeof msg.content === "string") {
			if (msg.content.length > 0) {
				blocks.push({ type: "text", text: msg.content });
			}
			continue;
		}
		for (const part of msg.content) {
			if (part.type === "text") {
				if (part.text.length > 0) {
					blocks.push({ type: "text", text: part.text });
				}
			} else if (part.type === "image") {
				blocks.push({
					type: "image",
					data: part.data,
					mimeType: part.mimeType,
				});
			}
		}
	}
	return blocks;
}

/**
 * 为超过 165 秒预取消剥离（Detached）的工具调用构造迟到结果补发 Prompt。
 * 保留文本与图片多模态内容，并指示模型继续后续步骤而无需重复调用同一工具。
 */
export function buildDetachedToolResultBlocks(
	results: readonly ToolResultMessage[],
	trailingUserMessages: readonly UserMessage[] = [],
): AcpPromptBlock[] {
	const blocks: AcpPromptBlock[] = [];
	const introLines = [
		"The previously initiated tool execution(s) finished after the MCP hold timeout.",
		"Below are the actual tool execution results. Treat these calls as completed and continue from here without invoking the same tool call again:",
		"",
	];
	blocks.push({ type: "text", text: introLines.join("\n") });

	for (const res of results) {
		const statusAttr = res.isError ? "error" : "ok";
		const textParts: string[] = [];
		const imageParts: ImageContent[] = [];

		for (const item of res.content) {
			if (item.type === "text") {
				textParts.push(item.text);
			} else if (item.type === "image") {
				imageParts.push(item);
			}
		}

		blocks.push({
			type: "text",
			text: `<tool_result id="${res.toolCallId}" tool="${res.toolName}" status="${statusAttr}">\n${textParts.join("\n")}\n</tool_result>`,
		});

		for (const img of imageParts) {
			blocks.push({
				type: "image",
				data: img.data,
				mimeType: img.mimeType,
			});
		}
	}

	if (trailingUserMessages.length > 0) {
		blocks.push(...convertUserMessagesToPromptBlocks(trailingUserMessages));
	}

	return blocks;
}

/** `agy` 单条 `USER_INPUT` 步硬上限为 64,000 tokens（超过后按 192KB 硬切尾部）。此处留足跨模型 tokenizer 安全余量 */
export const SAFE_SINGLE_STEP_MAX_TOKENS = 42_000;
/** 单条 `USER_INPUT` 步 UTF-8 字节安全上限（配合 token 双阈值严防触及 192KB 硬切线） */
export const SAFE_SINGLE_STEP_MAX_BYTES = 110_000;
/** 单步纯文本重放默认历史预算（兼容旧调用方导出常量，已收紧至单步安全线以内） */
export const MAX_FRESH_REPLAY_HISTORY_BYTES = 96_000;
/** 当历史已由 `pi-traffic-optimization` 归档瘦身时的单步历史上限（仍严守在 `agy` 64k 单步红线之内） */
export const MAX_PROJECTED_REPLAY_HISTORY_BYTES = 104_000;
/** 多步 SQLite 预注入默认模型窗口参考值（未提供模型窗口时回退） */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
/** 多步 SQLite 预注入历史总 token 硬顶（避免超长历史无限制挤占模型有效窗口） */
const MAX_PRELOAD_TOTAL_HISTORY_TOKENS = 600_000;
/** 多步 SQLite 预注入历史总字节硬顶 */
const MAX_PRELOAD_TOTAL_HISTORY_BYTES = 2_400_000;
/** 历史检查点重放最多保留的近期历史图片数（更早图片转为占位文本，防单行 JSON-RPC 体积失控） */
const MAX_FRESH_REPLAY_HISTORY_IMAGES = 6;
/** 每张内联图片在单步预算中预留的保守 token 占位 */
const ESTIMATED_IMAGE_BLOCK_TOKENS = 1_000;
const MAX_SINGLE_REPLAY_TOOL_TEXT_BYTES = 4_000;
const MAX_SINGLE_REPLAY_MESSAGE_TEXT_BYTES = 16_000;
/** 多步预注入模式下允许保留更完整的单条历史消息与工具输出 */
const MAX_PRELOAD_SINGLE_TOOL_TEXT_BYTES = 16_000;
const MAX_PRELOAD_SINGLE_MESSAGE_TEXT_BYTES = 48_000;

/** 写入本地新建 SQLite 会话的一对预注入历史步（严格满足 `user -> assistant` 交替角色约束） */
export interface PreloadedSqliteTurn {
	userText: string;
	assistantAckText: string;
}

export interface FreshReplayPlanOptions {
	visibleMessages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[];
	/** 可选前置工作区上下文块（`<workspace_context>...</workspace_context>`） */
	workspaceContextBlock?: string;
	/** 当前模型上下文窗口上限（用于按比例计算多步预注入总预算，默认 200k） */
	maxContextWindowTokens?: number;
	/** 单步估算 token 安全上限（默认 `SAFE_SINGLE_STEP_MAX_TOKENS`） */
	maxSingleStepTokens?: number;
	/** 单步 UTF-8 字节安全上限（默认 `SAFE_SINGLE_STEP_MAX_BYTES`） */
	maxSingleStepBytes?: number;
	/** 多步预注入总历史 token 上限（可选，默认按模型窗口 60% 计算） */
	maxTotalHistoryTokens?: number;
	/** 多步预注入总历史字节上限（可选） */
	maxTotalHistoryBytes?: number;
}

export interface FreshReplayPlan {
	/** 需写入新建本地 SQLite 会话的前序分片步（为空表示单次 `session/prompt` 即可全量装下，无需预注入） */
	preloadedTurns: PreloadedSqliteTurn[];
	/** 预注入完成并 `session/resume` 后通过 `session/prompt` 发送的最终提示块（严守单步安全预算） */
	finalPromptBlocks: AcpPromptBlock[];
	/** SQLite 不可用或 `session/resume` 失败时的纯公开协议单步降级块（严守单步预算且绝不切掉末尾提问） */
	singleStepFallbackBlocks: AcpPromptBlock[];
	/** 超出多步总窗口预算而被省略的最早期历史消息数 */
	omittedMessageCount: number;
}

export interface PromptBlocksPreloadPlan {
	/** 需预注入的前序分片步（为空表示原块已在单步安全预算内） */
	preloadedTurns: PreloadedSqliteTurn[];
	/** 最终通过 `session/prompt` 发送的安全块 */
	finalPromptBlocks: AcpPromptBlock[];
	/** 无法预注入时的单步安全降级块（保留首尾关键指令） */
	singleStepFallbackBlocks: AcpPromptBlock[];
}

/**
 * 保守估算字符串在 Gemini / Claude tokenizer 下占用的 token 数。
 * 对非 ASCII 字符、数字及密集标点采用偏保守系数，避免跨模型 tokenizer 差异导致误撞 `agy` 64,000 单步上限。
 */
export function estimateStepTokens(text: string): number {
	if (!text) return 0;
	let normalAscii = 0;
	let denseAscii = 0;
	let nonAscii = 0;

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code > 0x7f) {
			nonAscii++;
		} else if (
			code < 0x20 ||
			(code >= 0x21 && code <= 0x40) ||
			(code >= 0x5b && code <= 0x60) ||
			(code >= 0x7b && code <= 0x7e)
		) {
			// 数字（0x30-0x39）、标点与控制字符通常切词更密
			denseAscii++;
		} else {
			normalAscii++;
		}
	}

	return Math.ceil(normalAscii / 2.6 + denseAscii / 1.4 + nonAscii * 1.15);
}

/** 统计 ACP Prompt 块序列的 UTF-8 字节数与保守估算 token 数 */
export function measurePromptBlocksSize(
	blocks: readonly AcpPromptBlock[],
	extraPrefixText?: string,
): { bytes: number; tokens: number; imageCount: number } {
	let bytes = 0;
	let tokens = 0;
	let imageCount = 0;

	if (extraPrefixText) {
		bytes += Buffer.byteLength(extraPrefixText, "utf8") + 1;
		tokens += estimateStepTokens(extraPrefixText) + 1;
	}

	for (const block of blocks) {
		if (block.type === "text") {
			bytes += Buffer.byteLength(block.text, "utf8") + 1;
			tokens += estimateStepTokens(block.text) + 1;
		} else if (block.type === "image") {
			imageCount++;
			tokens += ESTIMATED_IMAGE_BLOCK_TOKENS;
		} else if (block.type === "resource" && block.resource?.text) {
			bytes += Buffer.byteLength(block.resource.text, "utf8") + 1;
			tokens += estimateStepTokens(block.resource.text) + 1;
		}
	}

	return { bytes, tokens, imageCount };
}

/** 判断一组 Prompt 块（含可选前缀）是否超出单条 `USER_INPUT` 步安全预算 */
export function exceedsSafeSingleStepBudget(
	blocks: readonly AcpPromptBlock[],
	extraPrefixText?: string,
	maxSingleStepBytes = SAFE_SINGLE_STEP_MAX_BYTES,
	maxSingleStepTokens = SAFE_SINGLE_STEP_MAX_TOKENS,
): boolean {
	const measured = measurePromptBlocksSize(blocks, extraPrefixText);
	return measured.bytes > maxSingleStepBytes || measured.tokens > maxSingleStepTokens;
}

function truncateUtf8Middle(
	text: string,
	maxBytes: number,
	marker: string,
	headRatio = 0.65,
): string {
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= maxBytes) {
		return text;
	}
	const markerBytes = Buffer.byteLength(marker, "utf8");
	const budget = Math.max(128, maxBytes - markerBytes);
	const headBudget = Math.floor(budget * headRatio);
	const tailBudget = Math.max(64, budget - headBudget);
	const buf = Buffer.from(text, "utf8");
	// 使用 TextDecoder 自动处理多字节 UTF-8 边界，避免产生残缺代理对
	const decoder = new TextDecoder("utf-8", { fatal: false });
	const headStr = decoder.decode(buf.subarray(0, headBudget));
	const tailStr = decoder.decode(buf.subarray(buf.length - tailBudget));
	return `${headStr}${marker}${tailStr}`;
}

/** 按双重安全预算（UTF-8 字节 + 保守 token 估算）做中间裁切，默认偏向保留尾部关键提问 */
function truncateTextMiddleToSafeBudget(
	text: string,
	maxBytes: number,
	maxTokens: number,
	marker: string,
	headRatio = 0.35,
): string {
	let current = text;
	let byteCap = Math.max(256, maxBytes);
	for (let attempt = 0; attempt < 6; attempt++) {
		const b = Buffer.byteLength(current, "utf8");
		const t = estimateStepTokens(current);
		if (b <= maxBytes && t <= maxTokens) {
			return current;
		}
		if (t > maxTokens) {
			const shrinkRatio = Math.max(0.25, (maxTokens * 0.92) / t);
			byteCap = Math.max(256, Math.min(byteCap, Math.floor(b * shrinkRatio)));
		} else {
			byteCap = Math.max(256, maxBytes);
		}
		current = truncateUtf8Middle(text, byteCap, marker, headRatio);
	}
	return current;
}

/** 将一段超长文本按行/字符安全切分为多个同时满足字节与 token 双上限的连续片段（不破坏 UTF-16 代理对） */
export function splitTextToSafeChunks(
	text: string,
	maxChunkBytes: number,
	maxChunkTokens: number,
): string[] {
	const safeBytes = Math.max(512, maxChunkBytes);
	const safeTokens = Math.max(256, maxChunkTokens);
	if (Buffer.byteLength(text, "utf8") <= safeBytes && estimateStepTokens(text) <= safeTokens) {
		return [text];
	}

	const chunks: string[] = [];
	let cursor = 0;
	const totalLen = text.length;

	while (cursor < totalLen) {
		// 先用严格单调的二分查找定位最大合法切点，再规整 UTF-16 代理对边界，避免代理对回退引起区间震荡
		let low = cursor + 1;
		let high = Math.min(totalLen, cursor + safeBytes);
		let best = low;
		while (low <= high) {
			const rawMid = Math.floor((low + high) / 2);
			const slice = text.slice(cursor, rawMid);
			if (
				Buffer.byteLength(slice, "utf8") <= safeBytes &&
				estimateStepTokens(slice) <= safeTokens
			) {
				best = rawMid;
				low = rawMid + 1;
			} else {
				high = rawMid - 1;
			}
		}

		// 确保不会在 UTF-16 高代理项（0xD800-0xDBFF）之后切开代理对
		let cut = best;
		if (cut < totalLen) {
			const prev = text.charCodeAt(cut - 1);
			if (prev >= 0xd800 && prev <= 0xdbff) {
				cut = cut - 1 > cursor ? cut - 1 : Math.min(totalLen, cut + 1);
			}
		}

		// 若未抵达末尾，尽量在片段后半区的换行符处对齐边界，保持可读性
		if (cut < totalLen) {
			const minLineCut = cursor + Math.floor((cut - cursor) * 0.65);
			const nlIdx = text.lastIndexOf("\n", cut - 1);
			if (nlIdx >= minLineCut) {
				cut = nlIdx + 1;
			}
		}
		if (cut <= cursor) {
			const first = text.charCodeAt(cursor);
			cut =
				first >= 0xd800 && first <= 0xdbff
					? Math.min(totalLen, cursor + 2)
					: Math.min(totalLen, cursor + 1);
		}
		chunks.push(text.slice(cursor, cut));
		cursor = cut;
	}

	return chunks;
}

interface SerializedReplayEntry {
	blocks: AcpPromptBlock[];
	textBytes: number;
	tokens: number;
}

function serializeReplayHistoryEntry(
	msg: UserMessage | AssistantMessage | ToolResultMessage,
	limits: {
		maxMessageBytes: number;
		maxToolBytes: number;
	} = {
		maxMessageBytes: MAX_SINGLE_REPLAY_MESSAGE_TEXT_BYTES,
		maxToolBytes: MAX_SINGLE_REPLAY_TOOL_TEXT_BYTES,
	},
): SerializedReplayEntry {
	const entryBlocks: AcpPromptBlock[] = [];

	if (msg.role === "user") {
		if (typeof msg.content === "string") {
			const trimmed = truncateUtf8Middle(
				msg.content,
				limits.maxMessageBytes,
				"\n...[earlier user text truncated in replay]...\n",
			);
			entryBlocks.push({ type: "text", text: `<user>\n${trimmed}\n</user>` });
		} else {
			entryBlocks.push({ type: "text", text: "<user>" });
			for (const part of msg.content) {
				if (part.type === "text") {
					const trimmed = truncateUtf8Middle(
						part.text,
						limits.maxMessageBytes,
						"\n...[earlier user text truncated in replay]...\n",
					);
					entryBlocks.push({ type: "text", text: trimmed });
				} else if (part.type === "image") {
					entryBlocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
				}
			}
			entryBlocks.push({ type: "text", text: "</user>" });
		}
	} else if (msg.role === "assistant") {
		const segs: string[] = [];
		for (const part of msg.content) {
			if (part.type === "text" && part.text.trim()) {
				segs.push(
					truncateUtf8Middle(
						part.text,
						limits.maxMessageBytes,
						"\n...[assistant text truncated in replay]...\n",
					),
				);
			} else if (part.type === "toolCall") {
				const rawArgs = JSON.stringify(part.arguments);
				const safeArgs = truncateUtf8Middle(rawArgs, 2_000, "...[truncated]...");
				segs.push(`<tool_call id="${part.id}" name="${part.name}">${safeArgs}</tool_call>`);
			}
		}
		if (segs.length > 0) {
			entryBlocks.push({
				type: "text",
				text: `<assistant model="${msg.model}">\n${segs.join("\n")}\n</assistant>`,
			});
		}
	} else if (msg.role === "toolResult") {
		const status = msg.isError ? "error" : "ok";
		const rawTexts = msg.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		// 对 pi-traffic-optimization 已生成的紧凑 ctx:// 归档占位符保留原文不裁切，确保 handle 与 context_recall 指引完整
		let cappedTexts = isTrafficOptToolPlaceholder(rawTexts)
			? rawTexts
			: truncateUtf8Middle(
					rawTexts,
					limits.maxToolBytes,
					"\n...[tool output truncated in replay]...\n",
				);
		// 若仅单图归档的工具结果因正文过长被截断，补回被裁掉的 ctx://image/ 归档句柄行，避免模型丢失图片引用
		if (cappedTexts !== rawTexts) {
			const missingImagePlaceholders = rawTexts
				.split("\n")
				.filter((line) => isTrafficOptImagePlaceholder(line) && !cappedTexts.includes(line));
			if (missingImagePlaceholders.length > 0) {
				cappedTexts = `${cappedTexts}\n${missingImagePlaceholders.join("\n")}`;
			}
		}
		entryBlocks.push({
			type: "text",
			text: `<tool_result id="${msg.toolCallId}" tool="${msg.toolName}" status="${status}">\n${cappedTexts}\n</tool_result>`,
		});
		for (const part of msg.content) {
			if (part.type === "image") {
				entryBlocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
			}
		}
	}

	let textBytes = 0;
	let tokens = 0;
	for (const b of entryBlocks) {
		if (b.type === "text") {
			textBytes += Buffer.byteLength(b.text, "utf8") + 1;
			tokens += estimateStepTokens(b.text) + 1;
		}
	}
	return { blocks: entryBlocks, textBytes, tokens };
}

function splitHistoryAndActiveTail(
	visibleMessages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
): {
	historySlice: readonly (UserMessage | AssistantMessage | ToolResultMessage)[];
	activeTail: readonly (UserMessage | AssistantMessage | ToolResultMessage)[];
} {
	if (visibleMessages.every((m) => m.role === "user")) {
		return { historySlice: [], activeTail: visibleMessages };
	}

	let splitIndex = visibleMessages.length;
	while (splitIndex > 0 && visibleMessages[splitIndex - 1].role === "user") {
		splitIndex--;
	}

	const historySlice =
		splitIndex > 0 ? visibleMessages.slice(0, splitIndex) : visibleMessages.slice(0, -1);
	const activeTail =
		splitIndex < visibleMessages.length
			? visibleMessages.slice(splitIndex)
			: [visibleMessages[visibleMessages.length - 1]];

	return { historySlice, activeTail };
}

function buildActiveTailBlocks(
	activeTail: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
): AcpPromptBlock[] {
	const tailUsers = activeTail.filter((m): m is UserMessage => m.role === "user");
	if (tailUsers.length > 0) {
		return convertUserMessagesToPromptBlocks(tailUsers);
	}
	const tailToolResults = activeTail.filter(
		(m): m is ToolResultMessage => m.role === "toolResult",
	);
	if (tailToolResults.length > 0) {
		return buildDetachedToolResultBlocks(tailToolResults);
	}
	return [{ type: "text", text: "Please continue." }];
}

/**
 * 将任意 ACP Prompt 块序列（例如辅助摘要请求或热会话中用户单次粘贴的超长文本）拆分为：
 * - 若已在单步安全预算内：`preloadedTurns = []`，`finalPromptBlocks` 原样返回；
 * - 若超出单步安全预算：将前序文本分片放入 `preloadedTurns`，末尾片段与图片块保留在 `finalPromptBlocks`。
 */
export function buildPromptBlocksPreloadPlan(
	promptBlocks: readonly AcpPromptBlock[],
	options?: {
		maxSingleStepBytes?: number;
		maxSingleStepTokens?: number;
		segmentLabel?: string;
	},
): PromptBlocksPreloadPlan {
	const maxStepBytes = options?.maxSingleStepBytes ?? SAFE_SINGLE_STEP_MAX_BYTES;
	const maxStepTokens = options?.maxSingleStepTokens ?? SAFE_SINGLE_STEP_MAX_TOKENS;
	const segmentLabel = options?.segmentLabel ?? "user-message-part";

	const measured = measurePromptBlocksSize(promptBlocks);
	if (measured.bytes <= maxStepBytes && measured.tokens <= maxStepTokens) {
		return {
			preloadedTurns: [],
			finalPromptBlocks: [...promptBlocks],
			singleStepFallbackBlocks: [...promptBlocks],
		};
	}

	const textParts: string[] = [];
	const nonTextBlocks: AcpPromptBlock[] = [];
	for (const b of promptBlocks) {
		if (b.type === "text") {
			if (b.text.length > 0) textParts.push(b.text);
		} else if (b.type === "resource" && b.resource?.text) {
			textParts.push(b.resource.text);
		} else {
			nonTextBlocks.push(b);
		}
	}
	const combinedText = textParts.join("\n\n");
	const nonTextMeasured = measurePromptBlocksSize(nonTextBlocks);
	const wrapperOverheadBytes = 240;
	const wrapperOverheadTokens = 96;

	const chunkBytesLimit = Math.max(1_024, Math.floor((maxStepBytes - wrapperOverheadBytes) * 0.9));
	const chunkTokensLimit = Math.max(
		512,
		Math.floor((maxStepTokens - wrapperOverheadTokens) * 0.9),
	);
	const minProtectedTextBytes = Math.min(chunkBytesLimit, 16_384);
	const minProtectedTextTokens = Math.min(chunkTokensLimit, 4_096);
	const finalTextBytesLimit = Math.max(
		minProtectedTextBytes,
		Math.min(chunkBytesLimit, maxStepBytes - nonTextMeasured.bytes - wrapperOverheadBytes),
	);
	const finalTextTokensLimit = Math.max(
		minProtectedTextTokens,
		Math.min(chunkTokensLimit, maxStepTokens - nonTextMeasured.tokens - wrapperOverheadTokens),
	);

	// 若超限纯粹源自图片数量过多而文本本身位于保护预算内，原样保留块结构，避免无意义裁切短文本
	const combinedTextBytes = Buffer.byteLength(combinedText, "utf8");
	const combinedTextTokens = estimateStepTokens(combinedText);
	if (combinedTextBytes <= finalTextBytesLimit && combinedTextTokens <= finalTextTokensLimit) {
		return {
			preloadedTurns: [],
			finalPromptBlocks: [...promptBlocks],
			singleStepFallbackBlocks: [...promptBlocks],
		};
	}

	// 单步安全降级块：保留头部 35% 与末尾 65%（优先保住末尾问题与输出格式要求）
	const fallbackText = truncateTextMiddleToSafeBudget(
		combinedText,
		finalTextBytesLimit,
		finalTextTokensLimit,
		"\n...[middle content omitted to stay within single-step limit]...\n",
		0.35,
	);
	const singleStepFallbackBlocks: AcpPromptBlock[] = [
		...(fallbackText ? [{ type: "text" as const, text: fallbackText }] : []),
		...nonTextBlocks,
	];

	const rawChunks = splitTextToSafeChunks(combinedText, finalTextBytesLimit, finalTextTokensLimit);
	if (rawChunks.length <= 1) {
		return {
			preloadedTurns: [],
			finalPromptBlocks: singleStepFallbackBlocks,
			singleStepFallbackBlocks,
		};
	}

	const totalParts = rawChunks.length;
	const preloadedTurns: PreloadedSqliteTurn[] = [];
	for (let i = 0; i < totalParts - 1; i++) {
		const partNum = i + 1;
		preloadedTurns.push({
			userText: `<${segmentLabel} part="${partNum}/${totalParts}">\n${rawChunks[i]}\n</${segmentLabel}>`,
			assistantAckText: `Received part ${partNum}/${totalParts}. Ready for the next part.`,
		});
	}

	const finalPromptBlocks: AcpPromptBlock[] = [
		{
			type: "text",
			text: `<${segmentLabel} part="${totalParts}/${totalParts}">\n${rawChunks[totalParts - 1]}\n</${segmentLabel}>\n\nAll ${totalParts} parts of the request have now been provided. Please respond to the complete request.`,
		},
		...nonTextBlocks,
	];

	return {
		preloadedTurns,
		finalPromptBlocks,
		singleStepFallbackBlocks,
	};
}

/**
 * 构建支持「本地 SQLite 多步预注入（零额外 LLM 调用）」与「单步双阈值防截断兜底」的统一重放计划。
 * - 当 `workspaceContextBlock + 全部历史 + 末尾提问` 能在 1 步安全预算内放得下时，不产生预注入步，直接单次发送；
 * - 超出单步安全预算时，按安全单步上限（<= 42k 估算 token 且 <= 110KB）将历史与超长末尾拆分为多个 `(USER_INPUT, PLANNER_RESPONSE)` 预注入步，
 *   使整段历史突破 `agy` 64,000 单步限制直达模型完整窗口，同时给出严守单步预算的纯公开协议降级方案。
 */
export function buildFreshReplayPlan(options: FreshReplayPlanOptions): FreshReplayPlan {
	const { visibleMessages, workspaceContextBlock } = options;
	const maxStepBytes = options.maxSingleStepBytes ?? SAFE_SINGLE_STEP_MAX_BYTES;
	const maxStepTokens = options.maxSingleStepTokens ?? SAFE_SINGLE_STEP_MAX_TOKENS;

	if (visibleMessages.length === 0) {
		const base: AcpPromptBlock[] = workspaceContextBlock
			? [
					{ type: "text", text: workspaceContextBlock },
					{ type: "text", text: "Continue." },
				]
			: [{ type: "text", text: "Continue." }];
		return {
			preloadedTurns: [],
			finalPromptBlocks: base,
			singleStepFallbackBlocks: base,
			omittedMessageCount: 0,
		};
	}

	const { historySlice, activeTail } = splitHistoryAndActiveTail(visibleMessages);
	if (historySlice.length > 0) {
		throw new ThinClientPolicyError(REPLAY_REFUSED);
	}
	const rawTailBlocks = buildActiveTailBlocks(activeTail);
	const wsBytes = workspaceContextBlock ? Buffer.byteLength(workspaceContextBlock, "utf8") + 1 : 0;
	const wsTokens = workspaceContextBlock ? estimateStepTokens(workspaceContextBlock) + 1 : 0;

	const headerText =
		"<conversation-checkpoint>\nThe following is the prior conversation transcript from this session (preserved across model switch, compaction, or branch navigation):";
	const footerText =
		"</conversation-checkpoint>\n\nPlease respond to the latest message(s) below based on the checkpoint context above:";
	const wrapperBytes = Buffer.byteLength(headerText, "utf8") + Buffer.byteLength(footerText, "utf8") + 160;
	const wrapperTokens = estimateStepTokens(headerText) + estimateStepTokens(footerText) + 64;

	// 1. 构建单步纯公开协议降级块（严格扣除 workspaceContextBlock 与末尾用户提问，绝不触发 agy 尾部硬切）
	let fallbackWorkspaceText = workspaceContextBlock;
	let fallbackWsBytes = wsBytes;
	let fallbackWsTokens = wsTokens;
	let workspaceRequiredShrinkInSingleStep = false;
	if (workspaceContextBlock) {
		const maxFallbackWsBytes = Math.max(512, Math.floor(maxStepBytes * 0.65));
		const maxFallbackWsTokens = Math.max(256, Math.floor(maxStepTokens * 0.65));
		if (wsBytes > maxFallbackWsBytes || wsTokens > maxFallbackWsTokens) {
			workspaceRequiredShrinkInSingleStep = true;
			fallbackWorkspaceText = truncateTextMiddleToSafeBudget(
				workspaceContextBlock,
				maxFallbackWsBytes,
				maxFallbackWsTokens,
				"\n...[workspace context trimmed in single-step fallback]...\n",
				0.5,
			);
			fallbackWsBytes = Buffer.byteLength(fallbackWorkspaceText, "utf8") + 1;
			fallbackWsTokens = estimateStepTokens(fallbackWorkspaceText) + 1;
		}
	}

	const tailMeasured = measurePromptBlocksSize(rawTailBlocks);
	const singleStepTailBudgetBytes = Math.max(1_024, maxStepBytes - fallbackWsBytes - 128);
	const singleStepTailBudgetTokens = Math.max(512, maxStepTokens - fallbackWsTokens - 64);

	let safeSingleStepTailBlocks: AcpPromptBlock[] = rawTailBlocks;
	let tailRequiredShrinkInSingleStep = false;
	if (
		tailMeasured.bytes > singleStepTailBudgetBytes ||
		tailMeasured.tokens > singleStepTailBudgetTokens
	) {
		tailRequiredShrinkInSingleStep = true;
		const tailFallbackPlan = buildPromptBlocksPreloadPlan(rawTailBlocks, {
			maxSingleStepBytes: singleStepTailBudgetBytes,
			maxSingleStepTokens: singleStepTailBudgetTokens,
		});
		safeSingleStepTailBlocks = tailFallbackPlan.singleStepFallbackBlocks;
	}

	const safeTailMeasured = measurePromptBlocksSize(safeSingleStepTailBlocks);
	const availSingleHistoryBytes = Math.max(
		0,
		maxStepBytes - fallbackWsBytes - safeTailMeasured.bytes - wrapperBytes,
	);
	const availSingleHistoryTokens = Math.max(
		0,
		maxStepTokens - fallbackWsTokens - safeTailMeasured.tokens - wrapperTokens,
	);

	let singleStepOmittedCount = 0;
	const singleStepFallbackBlocks: AcpPromptBlock[] = [];
	if (fallbackWorkspaceText) {
		singleStepFallbackBlocks.push({ type: "text", text: fallbackWorkspaceText });
	}

	if (historySlice.length > 0 && !tailRequiredShrinkInSingleStep) {
		const selectedReversed: AcpPromptBlock[][] = [];
		let usedBytes = 0;
		let usedTokens = 0;
		let usedImages = 0;

		for (let i = historySlice.length - 1; i >= 0; i--) {
			const serialized = serializeReplayHistoryEntry(historySlice[i]);
			if (serialized.blocks.length === 0) continue;

			const imageCountInEntry = serialized.blocks.filter((b) => b.type === "image").length;
			const keptImagesInEntry = Math.max(
				0,
				Math.min(imageCountInEntry, MAX_FRESH_REPLAY_HISTORY_IMAGES - usedImages),
			);
			const entryTokens = serialized.tokens + keptImagesInEntry * ESTIMATED_IMAGE_BLOCK_TOKENS;

			if (
				usedBytes + serialized.textBytes > availSingleHistoryBytes ||
				usedTokens + entryTokens > availSingleHistoryTokens
			) {
				singleStepOmittedCount = i + 1;
				break;
			}

			const cappedBlocks: AcpPromptBlock[] = serialized.blocks.map((block) => {
				if (block.type !== "image") return block;
				if (usedImages < MAX_FRESH_REPLAY_HISTORY_IMAGES) {
					usedImages++;
					return block;
				}
				return {
					type: "text",
					text: `[earlier ${block.mimeType} image omitted in replay]`,
				};
			});
			selectedReversed.push(cappedBlocks);
			usedBytes += serialized.textBytes;
			usedTokens += entryTokens;
		}

		if (selectedReversed.length > 0 || singleStepOmittedCount > 0) {
			singleStepFallbackBlocks.push({ type: "text", text: headerText });
			if (singleStepOmittedCount > 0) {
				singleStepFallbackBlocks.push({
					type: "text",
					text: `[Note: ${singleStepOmittedCount} earlier historical messages were omitted to stay within the single-step prompt size budget.]`,
				});
			}
			for (let i = selectedReversed.length - 1; i >= 0; i--) {
				singleStepFallbackBlocks.push(...selectedReversed[i]);
			}
			singleStepFallbackBlocks.push({ type: "text", text: footerText });
		}
	} else if (historySlice.length > 0) {
		singleStepOmittedCount = historySlice.length;
	}

	singleStepFallbackBlocks.push(...safeSingleStepTailBlocks);

	// 若单步即可无省略装下全部历史与末尾提问，直接返回（零 SQLite 预注入开销）
	if (
		singleStepOmittedCount === 0 &&
		!tailRequiredShrinkInSingleStep &&
		!workspaceRequiredShrinkInSingleStep
	) {
		return {
			preloadedTurns: [],
			finalPromptBlocks: singleStepFallbackBlocks,
			singleStepFallbackBlocks,
			omittedMessageCount: 0,
		};
	}

	// 2. 超出单步安全预算 -> 构建多步 SQLite 预注入计划
	const contextWindow = Math.max(
		DEFAULT_CONTEXT_WINDOW_TOKENS,
		options.maxContextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
	);
	const totalHistoryTokenBudget =
		options.maxTotalHistoryTokens ??
		Math.max(
			maxStepTokens,
			Math.min(MAX_PRELOAD_TOTAL_HISTORY_TOKENS, Math.floor(contextWindow * 0.6)),
		);
	const totalHistoryByteBudget =
		options.maxTotalHistoryBytes ??
		Math.min(MAX_PRELOAD_TOTAL_HISTORY_BYTES, totalHistoryTokenBudget * 4);

	const preloadEntriesReversed: { text: string; bytes: number; tokens: number }[] = [];
	const preservedRecentHistoryImages: Array<{
		block: Extract<AcpPromptBlock, { type: "image" }>;
		source:
			| { kind: "toolResult"; toolCallId: string; toolName: string; status: "ok" | "error" }
			| { kind: "user" };
	}> = [];
	let totalUsedHistoryBytes = 0;
	let totalUsedHistoryTokens = 0;
	let omittedMessageCount = 0;

	for (let i = historySlice.length - 1; i >= 0; i--) {
		const historyMsg = historySlice[i];
		const serialized = serializeReplayHistoryEntry(historyMsg, {
			maxMessageBytes: MAX_PRELOAD_SINGLE_MESSAGE_TEXT_BYTES,
			maxToolBytes: MAX_PRELOAD_SINGLE_TOOL_TEXT_BYTES,
		});
		if (serialized.blocks.length === 0) continue;

		const textSegments: string[] = [];
		for (const block of serialized.blocks) {
			if (block.type === "text") {
				textSegments.push(block.text);
			} else if (block.type === "image") {
				if (preservedRecentHistoryImages.length < MAX_FRESH_REPLAY_HISTORY_IMAGES) {
					preservedRecentHistoryImages.push({
						block,
						source:
							historyMsg.role === "toolResult"
								? {
										kind: "toolResult",
										toolCallId: historyMsg.toolCallId,
										toolName: historyMsg.toolName,
										status: historyMsg.isError ? "error" : "ok",
									}
								: { kind: "user" },
					});
					textSegments.push(`[attached recent ${block.mimeType} image from history]`);
				} else {
					textSegments.push(`[earlier ${block.mimeType} image omitted in replay]`);
				}
			}
		}
		const entryText = textSegments.join("\n");
		const entryBytes = Buffer.byteLength(entryText, "utf8") + 1;
		const entryTokens = estimateStepTokens(entryText) + 1;

		if (
			preloadEntriesReversed.length > 0 &&
			(totalUsedHistoryBytes + entryBytes > totalHistoryByteBudget ||
				totalUsedHistoryTokens + entryTokens > totalHistoryTokenBudget)
		) {
			omittedMessageCount = i + 1;
			break;
		}

		preloadEntriesReversed.push({ text: entryText, bytes: entryBytes, tokens: entryTokens });
		totalUsedHistoryBytes += entryBytes;
		totalUsedHistoryTokens += entryTokens;
	}

	const chronologicalEntries = preloadEntriesReversed.reverse();
	const chunkPayloadMaxBytes = Math.max(1_024, Math.floor((maxStepBytes - 512) * 0.92));
	const chunkPayloadMaxTokens = Math.max(512, Math.floor((maxStepTokens - 256) * 0.92));

	// 把所有历史条目（含超大单条切分）按时间正序打包成多个严格低于单步安全上限的文本分片
	const rawHistoryChunks: string[] = [];
	let currentChunkLines: string[] = [];
	let currentBytes = 0;
	let currentTokens = 0;

	// 若存在 workspaceContextBlock，随第 1 个预注入分片一起送入
	const flushChunk = () => {
		if (currentChunkLines.length > 0) {
			rawHistoryChunks.push(currentChunkLines.join("\n"));
			currentChunkLines = [];
			currentBytes = 0;
			currentTokens = 0;
		}
	};

	const appendAtomicPiece = (piece: string) => {
		const pBytes = Buffer.byteLength(piece, "utf8") + 1;
		const pTokens = estimateStepTokens(piece) + 1;
		if (pBytes > chunkPayloadMaxBytes || pTokens > chunkPayloadMaxTokens) {
			flushChunk();
			const subPieces = splitTextToSafeChunks(piece, chunkPayloadMaxBytes, chunkPayloadMaxTokens);
			for (const sub of subPieces) {
				rawHistoryChunks.push(sub);
			}
			return;
		}
		if (
			currentChunkLines.length > 0 &&
			(currentBytes + pBytes > chunkPayloadMaxBytes ||
				currentTokens + pTokens > chunkPayloadMaxTokens)
		) {
			flushChunk();
		}
		currentChunkLines.push(piece);
		currentBytes += pBytes;
		currentTokens += pTokens;
	};

	if (omittedMessageCount > 0) {
		appendAtomicPiece(
			`[Note: ${omittedMessageCount} earlier historical messages were omitted to stay within the model context window budget.]`,
		);
	}
	for (const entry of chronologicalEntries) {
		appendAtomicPiece(entry.text);
	}
	flushChunk();

	const preloadedTurns: PreloadedSqliteTurn[] = [];
	let workspacePlaced = false;

	if (rawHistoryChunks.length > 0) {
		// 检查首片加上 workspaceContextBlock 是否超过单步预算；若超限则让 workspaceContextBlock 单独成首步
		let wsPrefixForFirstChunk = "";
		if (workspaceContextBlock) {
			const firstWithWsBytes =
				wsBytes + Buffer.byteLength(rawHistoryChunks[0], "utf8") + 320;
			const firstWithWsTokens =
				wsTokens + estimateStepTokens(rawHistoryChunks[0]) + 128;
			if (firstWithWsBytes <= maxStepBytes && firstWithWsTokens <= maxStepTokens) {
				wsPrefixForFirstChunk = `${workspaceContextBlock}\n\n`;
				workspacePlaced = true;
			} else {
				const wsChunks = splitTextToSafeChunks(
					workspaceContextBlock,
					chunkPayloadMaxBytes,
					chunkPayloadMaxTokens,
				);
				for (let w = 0; w < wsChunks.length; w++) {
					preloadedTurns.push({
						userText: wsChunks[w],
						assistantAckText: "Workspace context noted.",
					});
				}
				workspacePlaced = true;
			}
		}

		const totalHistoryParts = rawHistoryChunks.length;
		for (let i = 0; i < totalHistoryParts; i++) {
			const partNum = i + 1;
			const prefix = i === 0 ? wsPrefixForFirstChunk : "";
			const body =
				`${prefix}<conversation-checkpoint part="${partNum}/${totalHistoryParts}">\n` +
				`${rawHistoryChunks[i]}\n` +
				`</conversation-checkpoint>`;
			preloadedTurns.push({
				userText: body,
				assistantAckText: `Understood. Historical context segment ${partNum}/${totalHistoryParts} received.`,
			});
		}
	} else if (workspaceContextBlock) {
		// 无历史但末尾用户提问本身超长：先将 workspaceContextBlock 单独预注入为首步
		const wsChunks = splitTextToSafeChunks(
			workspaceContextBlock,
			chunkPayloadMaxBytes,
			chunkPayloadMaxTokens,
		);
		for (const wsChunk of wsChunks) {
			preloadedTurns.push({
				userText: wsChunk,
				assistantAckText: "Workspace context noted.",
			});
		}
		workspacePlaced = true;
	}

	// 3. 组装最终通过 `session/prompt` 发送的末尾最新提问（若末尾自身仍超单步预算，自动续切进 preloadedTurns）
	const finalCandidateBlocks: AcpPromptBlock[] = [];
	if (workspaceContextBlock && !workspacePlaced) {
		finalCandidateBlocks.push({ type: "text", text: workspaceContextBlock });
	}
	// 仅在剩余预算充足时附带少量近期历史图片（保留来源标签），绝不挤爆末尾用户提问
	if (preservedRecentHistoryImages.length > 0) {
		const wrappedHistoryImageBlocks: AcpPromptBlock[] = [];
		for (const item of [...preservedRecentHistoryImages].reverse()) {
			if (item.source.kind === "toolResult") {
				wrappedHistoryImageBlocks.push({
					type: "text",
					text: `<tool_result id="${item.source.toolCallId}" tool="${item.source.toolName}" status="${item.source.status}">\n[recent image preserved from history]\n</tool_result>`,
				});
			} else {
				wrappedHistoryImageBlocks.push({
					type: "text",
					text: "[recent user image preserved from history]",
				});
			}
			wrappedHistoryImageBlocks.push(item.block);
		}
		const tailWithImgs = measurePromptBlocksSize([
			...wrappedHistoryImageBlocks,
			...rawTailBlocks,
		]);
		if (tailWithImgs.bytes <= maxStepBytes && tailWithImgs.tokens <= maxStepTokens) {
			finalCandidateBlocks.push(...wrappedHistoryImageBlocks);
		}
	}
	finalCandidateBlocks.push(...rawTailBlocks);

	const tailPlan = buildPromptBlocksPreloadPlan(finalCandidateBlocks, {
		maxSingleStepBytes: maxStepBytes,
		maxSingleStepTokens: maxStepTokens,
		segmentLabel: "user-message-part",
	});
	preloadedTurns.push(...tailPlan.preloadedTurns);

	return {
		preloadedTurns,
		finalPromptBlocks: tailPlan.finalPromptBlocks,
		singleStepFallbackBlocks,
		omittedMessageCount,
	};
}

/**
 * 构建单步结构化历史重放（`FreshReplay`）的 ACP Prompt 块序列。
 * 内置字节与 token 双阈值保护：从最近的历史消息向前逆序纳管，超出预算时优先裁切最早的旧历史与超长工具输出，
 * 100% 保证最近上下文与末尾最新用户提问永不被后端截断。
 */
export function buildFreshReplayPromptBlocks(
	visibleMessages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
	maxHistoryBytes?: number,
): AcpPromptBlock[] {
	if (visibleMessages.length === 0) {
		return [{ type: "text", text: "Continue." }];
	}
	const effectiveMaxHistoryBytes =
		maxHistoryBytes ??
		(inspectTrafficOptProjectionState(visibleMessages).archivedCount > 0
			? MAX_PROJECTED_REPLAY_HISTORY_BYTES
			: MAX_FRESH_REPLAY_HISTORY_BYTES);

	// 若仅有单轮用户消息，直接原样发送无需包裹检查点标签
	const allUsers = visibleMessages.every((m) => m.role === "user");
	if (allUsers) {
		return convertUserMessagesToPromptBlocks(visibleMessages as UserMessage[]);
	}

	// 拆分前序历史上下文与末尾最新待响应的用户消息切片
	const { historySlice, activeTail } = splitHistoryAndActiveTail(visibleMessages);
	if (historySlice.length > 0) {
		throw new ThinClientPolicyError(REPLAY_REFUSED);
	}
	const tailBlocks = buildActiveTailBlocks(activeTail);
	const tailMeasured = measurePromptBlocksSize(tailBlocks);

	// 未显式指定自定义预算时，自动套用单步双阈值保护（同时严守 42k token 与 110KB 字节线）
	const effectiveMaxHistoryTokens =
		maxHistoryBytes !== undefined
			? Number.POSITIVE_INFINITY
			: Math.max(1_024, SAFE_SINGLE_STEP_MAX_TOKENS - tailMeasured.tokens - 256);
	const cappedHistoryBytes =
		maxHistoryBytes !== undefined
			? effectiveMaxHistoryBytes
			: Math.min(
					effectiveMaxHistoryBytes,
					Math.max(1_024, SAFE_SINGLE_STEP_MAX_BYTES - tailMeasured.bytes - 512),
				);

	const blocks: AcpPromptBlock[] = [];

	if (historySlice.length > 0) {
		const selectedReversed: AcpPromptBlock[][] = [];
		let usedHistoryBytes = 0;
		let usedHistoryTokens = 0;
		let usedHistoryImages = 0;
		let omittedCount = 0;

		for (let i = historySlice.length - 1; i >= 0; i--) {
			const serialized = serializeReplayHistoryEntry(historySlice[i]);
			if (serialized.blocks.length === 0) {
				continue;
			}
			const imageCountInEntry = serialized.blocks.filter((b) => b.type === "image").length;
			const keptImagesInEntry = Math.max(
				0,
				Math.min(imageCountInEntry, MAX_FRESH_REPLAY_HISTORY_IMAGES - usedHistoryImages),
			);
			const entryTokens = serialized.tokens + keptImagesInEntry * ESTIMATED_IMAGE_BLOCK_TOKENS;

			if (
				selectedReversed.length > 0 &&
				(usedHistoryBytes + serialized.textBytes > cappedHistoryBytes ||
					usedHistoryTokens + entryTokens > effectiveMaxHistoryTokens)
			) {
				omittedCount = i + 1;
				break;
			}
			const cappedBlocks: AcpPromptBlock[] = serialized.blocks.map((block) => {
				if (block.type !== "image") return block;
				if (usedHistoryImages < MAX_FRESH_REPLAY_HISTORY_IMAGES) {
					usedHistoryImages++;
					return block;
				}
				return {
					type: "text",
					text: `[earlier ${block.mimeType} image omitted in replay]`,
				};
			});
			selectedReversed.push(cappedBlocks);
			usedHistoryBytes += serialized.textBytes;
			usedHistoryTokens += entryTokens;
		}

		blocks.push({
			type: "text",
			text: "<conversation-checkpoint>\nThe following is the prior conversation transcript from this session (preserved across model switch, compaction, or branch navigation):",
		});

		if (omittedCount > 0) {
			blocks.push({
				type: "text",
				text: `[Note: ${omittedCount} earlier historical messages were omitted to stay within the prompt replay size budget.]`,
			});
		}

		for (let i = selectedReversed.length - 1; i >= 0; i--) {
			blocks.push(...selectedReversed[i]);
		}

		blocks.push({
			type: "text",
			text: "</conversation-checkpoint>\n\nPlease respond to the latest message(s) below based on the checkpoint context above:",
		});
	}

	blocks.push(...tailBlocks);
	return blocks;
}
