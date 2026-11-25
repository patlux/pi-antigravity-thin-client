import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
	normalizeContext,
	type AssistantMessage,
	type AssistantMessageEvent,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BRIDGE_CONFIG, type BridgeConfig } from "../src/config.ts";
import {
	AGY_SESSION_ANCHOR_CUSTOM_TYPE,
	appendPreloadedTurnsToSqliteConversation,
	captureSqliteCheckpoint,
	cloneTemplateSqliteConversationWithPreload,
	createPreloadedSqliteConversation,
	findBranchAnchorForHistory,
	forkSqliteConversationAtCheckpoint,
	hasValidAgentMetadataBlob,
	parseGenMetadataUpstreamRequest,
	parseStepMetadataGenerationUsage,
	parseStepPayloadPlannedToolCount,
	readCurrentMaxSqliteGenIdx,
	readCurrentMaxSqliteStepIdx,
	readSqliteUpstreamRequestsSince,
	readSqliteGenerationUsagesSince,
	waitForSqliteToolStepsSettled,
} from "../src/session/checkpoint-sync.ts";
import {
	buildFreshReplayPlan,
	buildFreshReplayPromptBlocks,
	buildPromptBlocksPreloadPlan,
	computeTranscriptDigest,
	estimateStepTokens,
	exceedsSafeSingleStepBudget,
	extractAuxiliaryTaskInstructions,
	inspectTrafficOptProjectionState,
	isAuxiliarySingleTurnRequest,
	measurePromptBlocksSize,
	SAFE_SINGLE_STEP_MAX_BYTES,
	SAFE_SINGLE_STEP_MAX_TOKENS,
	splitTextToSafeChunks,
} from "../src/session/reconcile.ts";
import {
	convertAcpUsageToPiUsage,
	QuotaSoftErrorFilter,
	StepStreamWriter,
} from "../src/stream/event-mapper.ts";
import { THIN_CLIENT_DISABLED } from "./thin-client-skip.ts";

describe("流式行尾缓冲、429 软错误拦截与 Usage 转换", () => {
	it("零延迟放行正常文本并精确拦截跨块分片的 429 RESOURCE_EXHAUSTED 行", () => {
		const filter = new QuotaSoftErrorFilter();

		const r1 = filter.push("Hello world!\nNormal line ");
		assert.equal(r1.safeText, "Hello world!\nNormal line ");
		assert.equal(r1.quotaError, undefined);

		const r2 = filter.push("\n⚠ API error (attempt 1");
		assert.equal(r2.safeText, "\n");
		assert.equal(r2.quotaError, undefined);

		const r3 = filter.push("): RESOURCE_EXHAUSTED (code 429) try again\nIgnored tail");
		assert.equal(r3.safeText, "");
		assert.ok(r3.quotaError?.includes("RESOURCE_EXHAUSTED"));

		// 验证 agy 1.5.13 直接无 attempt 前缀的真实 429 行格式
		const directFilter = new QuotaSoftErrorFilter();
		const d1 = directFilter.push("\n⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n");
		assert.equal(d1.safeText, "\n");
		assert.ok(d1.quotaError?.includes("RESOURCE_EXHAUSTED (code 429)"));

		// 验证模型正文中正常引用或代码块讨论 429 报错样本时不会误判拦截
		const quoteFilter = new QuotaSoftErrorFilter();
		const q1 = quoteFilter.push("常见报错如下：\n```\n⚠ RESOURCE_EXHAUSTED (code 429): sample\n```\nRESOURCE_EXHAUSTED (code 429): discussed inline\n");
		assert.equal(q1.quotaError, undefined);
		assert.ok(q1.safeText.includes("discussed inline"));

		// 验证跨 chunk 切分的行内 ⚠ 示例及跨 chunk 切分的 ``` 代码块围栏均不会误判
		const splitFilter = new QuotaSoftErrorFilter();
		const s1 = splitFilter.push("Inline example: ");
		const s2 = splitFilter.push("⚠ RESOURCE_EXHAUSTED (code 429): not at line start\n``");
		const s3 = splitFilter.push("`text\n⚠ RESOURCE_EXHAUSTED (code 429): inside split fence\n``");
		const s4 = splitFilter.push("`\nStill alive!\n");
		assert.equal(s1.quotaError, undefined);
		assert.equal(s2.quotaError, undefined);
		assert.equal(s3.quotaError, undefined);
		assert.equal(s4.quotaError, undefined);
		assert.ok((s1.safeText + s2.safeText + s3.safeText + s4.safeText).includes("Still alive!"));
	});

	it("StepStreamWriter 支持两阶段工具调用流式采样、代码块平衡与分步 Usage 写入", async () => {
		const mockModel = {
			id: "gemini-4-neon",
			name: "Gemini 4 Neon",
			api: "antigravity-acp",
			provider: "antigravity",
			baseUrl: "acp://antigravity-cli",
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 512000,
			maxTokens: 65536,
		};

		const writer = new StepStreamWriter(mockModel, {
			responseId: "sess-abc",
			providerThinkingLevel: "high",
		});

		writer.appendThinkingDelta("Let me check ");
		writer.appendThinkingDelta("the file.");
		writer.appendTextDelta("Reading now.");
		await writer.appendToolCallStreaming(
			{ id: "call_1", name: "read", arguments: { path: "a.ts" } },
			3,
		);
		writer.finishWithToolUse();

		const events: AssistantMessageEvent[] = [];
		for await (const ev of writer.stream) {
			if ("partial" in ev) {
				for (const block of ev.partial.content) {
					if (block.type === "toolCall") {
						assert.equal(block.id, "call_1");
						assert.deepEqual(block.arguments, { path: "a.ts" });
					}
				}
			}
			events.push(ev);
		}

		assert.deepEqual(
			events.map((e) => e.type),
			[
				"start",
				"thinking_start",
				"thinking_delta",
				"thinking_delta",
				"thinking_end",
				"text_start",
				"text_delta",
				"text_end",
				"toolcall_start",
				"toolcall_delta",
				"toolcall_delta",
				"toolcall_end",
				"done",
			],
		);
		const toolDeltas = events
			.filter((e): e is Extract<AssistantMessageEvent, { type: "toolcall_delta" }> => e.type === "toolcall_delta")
			.map((e) => e.delta)
			.join("");
		assert.equal(toolDeltas, JSON.stringify({ path: "a.ts" }));
		assert.ok(writer.estimatedOutputTokens > 0);
		assert.equal(writer.message.stopReason, "toolUse");
		assert.equal(writer.message.usage.totalTokens, 0);

		const finalUsage = convertAcpUsageToPiUsage({
			inputTokens: 1200,
			outputTokens: 350,
			cachedReadTokens: 800,
			thoughtTokens: 150,
		});
		assert.equal(finalUsage.input, 1200);
		assert.equal(finalUsage.output, 350);
		assert.equal(finalUsage.cacheRead, 800);
		assert.equal(finalUsage.reasoning, 150);
		assert.equal(finalUsage.totalTokens, 2350);

		// 验证带真实定价的模型在 finishWithToolUse 与 finishTurn 时自动计算 usage.cost
		const pricedModel = {
			...mockModel,
			cost: { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 },
		};
		const pricedWriter = new StepStreamWriter(pricedModel);
		pricedWriter.appendTextDelta("Costed reply");
		pricedWriter.finishTurn("end_turn", {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cachedReadTokens: 2_000_000,
		});
		assert.ok(Math.abs(pricedWriter.message.usage.cost.input - 3) < 1e-6);
		assert.ok(Math.abs(pricedWriter.message.usage.cost.output - 1.5) < 1e-6);
		assert.ok(Math.abs(pricedWriter.message.usage.cost.cacheRead - 0.3) < 1e-6);
		assert.ok(Math.abs(pricedWriter.message.usage.cost.total - 4.8) < 1e-6);
	});
});

describe("会话摘要、历史重放与 SQLite 只读快照分叉", () => {
	it("识别辅助摘要请求并在 FreshReplay 中保留历史多模态图片块", { skip: THIN_CLIENT_DISABLED }, () => {
		const auxCtx = normalizeContext({
			systemPrompt: "You are a context summarization assistant. Do not continue the conversation.",
			messages: [
				{
					role: "user",
					content: "Please summarize the conversation above for compaction.",
					timestamp: 1,
				},
			],
			tools: [],
		});
		assert.equal(isAuxiliarySingleTurnRequest(auxCtx, undefined, false), true);
		assert.ok(extractAuxiliaryTaskInstructions(auxCtx)?.includes("summarization assistant"));

		// 用户以 --no-tools 首轮正常提问“总结 README”绝不能误判为一次性辅助请求
		const normalNoToolsCtx = normalizeContext({
			messages: [
				{
					role: "user",
					content: "Please summarize this README file and list its features.",
					timestamp: 1,
				},
			],
			tools: [],
		});
		assert.equal(isAuxiliarySingleTurnRequest(normalNoToolsCtx, undefined, false), false);

		const u1: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "Look at this screenshot" },
				{ type: "image", data: "aW1n", mimeType: "image/png" },
			],
			timestamp: 100,
		};
		const a1: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "I see a login button." }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			usage: convertAcpUsageToPiUsage(),
			stopReason: "stop",
			timestamp: 200,
		};
		const u2: UserMessage = {
			role: "user",
			content: "Now change its color.",
			timestamp: 300,
		};

		// 时间戳改变、context 阶段归档工具输出或重压缩历史图片均不影响会话结构摘要一致性
		const trRaw = {
			role: "toolResult" as const,
			toolCallId: "call_big_1",
			toolName: "read",
			content: [{ type: "text" as const, text: "x".repeat(50_000) }],
			isError: false,
			timestamp: 250,
		};
		const trArchived = {
			...trRaw,
			content: [{ type: "text" as const, text: "[已归档 ctx://tool/call_big_1]" }],
		};
		const u1Recompressed: UserMessage = {
			...u1,
			content: [
				{ type: "text", text: "Look at this screenshot" },
				{ type: "image", data: "cmVjb21wcmVzc2Vk", mimeType: "image/png" },
			],
		};
		const d1 = computeTranscriptDigest([u1, a1, trRaw]);
		const d2 = computeTranscriptDigest([
			{ ...u1Recompressed, timestamp: 9999 },
			{ ...a1, timestamp: 8888 },
			trArchived,
		]);
		assert.equal(d1, d2);
		assert.notEqual(
			d1,
			computeTranscriptDigest([u1, a1, { ...trRaw, isError: true }]),
		);

		const replayBlocks = buildFreshReplayPromptBlocks([u1, a1, u2]);
		assert.ok(replayBlocks.some((b) => b.type === "image" && b.data === "aW1n"));
		assert.ok(
			replayBlocks.some((b) => b.type === "text" && b.text.includes("<conversation-checkpoint>")),
		);

		// 验证 FreshReplay 字节预算保护：裁剪早期超长历史，但 100% 完整保留最近消息与末尾最新用户提问
		const hugeHistory: (UserMessage | AssistantMessage)[] = [];
		for (let i = 0; i < 30; i++) {
			hugeHistory.push({
				role: "user",
				content: `Turn ${i}: ${"H".repeat(2_000)}`,
				timestamp: i * 2 + 1,
			});
			hugeHistory.push({
				...a1,
				content: [{ type: "text", text: `Reply ${i}: ${"R".repeat(2_000)}` }],
				timestamp: i * 2 + 2,
			});
		}
		const finalPrompt: UserMessage = {
			role: "user",
			content: "CRITICAL_FINAL_USER_QUESTION_MUST_NEVER_BE_TRUNCATED",
			timestamp: 99999,
		};
		const budgetedBlocks = buildFreshReplayPromptBlocks([...hugeHistory, finalPrompt], 18_000);
		const joinedBudgetText = budgetedBlocks
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		assert.ok(joinedBudgetText.includes("earlier historical messages were omitted"));
		assert.ok(!joinedBudgetText.includes("Turn 0:"));
		assert.ok(joinedBudgetText.includes("Reply 29:"));
		const tailBlock = budgetedBlocks[budgetedBlocks.length - 1];
		assert.equal(tailBlock.type, "text");
		if (tailBlock.type === "text") {
			assert.equal(tailBlock.text, "CRITICAL_FINAL_USER_QUESTION_MUST_NEVER_BE_TRUNCATED");
		}
	});

	it("利用 node:sqlite VACUUM INTO 安全分叉截断会话数据库且原库保持只读不变", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-sqlite-"));
		try {
			const convDir = path.join(tmpRoot, ".gemini", "antigravity-cli", "conversations");
			fs.mkdirSync(convDir, { recursive: true });

			const cfg: BridgeConfig = {
				...DEFAULT_BRIDGE_CONFIG,
				geminiDir: path.join(tmpRoot, ".gemini"),
				appDataDirName: "antigravity-cli",
				enableSqliteFork: true,
			};

			const origSessionId = "11111111-2222-3333-4444-555555555555";
			const origDbPath = path.join(convDir, `${origSessionId}.db`);

			// 构建模拟真实 AGY 表结构的会话库（先写入第 1 轮共 2 个 step）
			const initDb = new DatabaseSync(origDbPath);
			initDb.exec(`
				CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id));
				CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob, metadata blob, PRIMARY KEY (idx));
				CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
				CREATE TABLE executor_metadata (idx integer, data blob, PRIMARY KEY (idx));
				CREATE TABLE parent_references (idx integer, data blob, PRIMARY KEY (idx));
				CREATE TABLE battle_mode_infos (idx integer, data blob, PRIMARY KEY (idx));
			`);
			initDb
				.prepare("INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)")
				.run(origSessionId, origSessionId);
			initDb
				.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 1, 2, X'0102'), (1, 2, 2, X'030405')")
				.run();
			initDb.prepare("INSERT INTO gen_metadata VALUES (0, X'AA', 2)").run();
			initDb.prepare("INSERT INTO executor_metadata VALUES (0, X'BB')").run();
			initDb.prepare("INSERT INTO parent_references VALUES (0, X'CC'), (1, X'DD')").run();
			initDb.close();

			// 在第 1 轮结束点采集检查点
			const cpTurn1 = await captureSqliteCheckpoint(cfg, origSessionId);
			assert.ok(cpTurn1);
			assert.equal(cpTurn1.steps, 2);

			// 模拟会话继续推进到了第 2 轮（新增 idx=2, 3，并在 idx=3 写入真实编码的 step_type=15 metadata）
			const encodeVarint = (n: number): number[] => {
				const out: number[] = [];
				let v = n;
				while (v >= 0x80) {
					out.push((v & 0x7f) | 0x80);
					v = Math.floor(v / 128);
				}
				out.push(v);
				return out;
			};
			const innerUsageBytes = Buffer.from([
				(2 << 3) | 0, ...encodeVarint(3353), // field 2: inputTokens = 3353
				(3 << 3) | 0, ...encodeVarint(445),  // field 3: outputTokens = 445
				(5 << 3) | 0, ...encodeVarint(10441), // field 5: cacheReadTokens = 10441
				(9 << 3) | 0, ...encodeVarint(255),  // field 9: thoughtTokens = 255
				(10 << 3) | 0, ...encodeVarint(190), // field 10: responseTokens = 190
			]);
			const stepMetaBlob = Buffer.from([
				(9 << 3) | 2, ...encodeVarint(innerUsageBytes.length), ...innerUsageBytes,
			]);
			const directParsed = parseStepMetadataGenerationUsage(stepMetaBlob, 3);
			assert.deepEqual(directParsed, {
				stepIdx: 3,
				inputTokens: 3353,
				outputTokens: 445,
				cacheWriteTokens: 0,
				cacheReadTokens: 10441,
				thoughtTokens: 255,
			});

			const appendDb = new DatabaseSync(origDbPath);
			// 构造包含 3 个 ToolCall (field 20 -> 3x field 7) 的 PlannerResponse payload
			const toolEntry = Buffer.from([(7 << 3) | 2, 2, 0x08, 0x01]);
			const plannerInner = Buffer.concat([toolEntry, toolEntry, toolEntry]);
			const stepPayload3Tools = Buffer.from([
				...encodeVarint((20 << 3) | 2),
				...encodeVarint(plannerInner.length),
				...plannerInner,
			]);
			assert.equal(parseStepPayloadPlannedToolCount(stepPayload3Tools), 3);

			appendDb
				.prepare("INSERT INTO steps (idx, step_type, status, step_payload, metadata) VALUES (2, 14, 2, X'06', NULL), (3, 15, 2, ?, ?)")
				.run(stepPayload3Tools, stepMetaBlob);
			appendDb.prepare("INSERT INTO gen_metadata VALUES (1, X'EE', 2)").run();
			appendDb.prepare("INSERT INTO parent_references VALUES (2, X'FF'), (3, X'11')").run();
			appendDb.close();

			const gensSince1 = await readSqliteGenerationUsagesSince(cfg, origSessionId, 1);
			assert.equal(gensSince1.length, 1);
			assert.equal(gensSince1[0].inputTokens, 3353);
			assert.equal(gensSince1[0].cacheReadTokens, 10441);
			assert.equal(gensSince1[0].outputTokens, 445);
			assert.equal(gensSince1[0].thoughtTokens, 255);
			assert.equal(gensSince1[0].plannedToolCalls, 3);

			// 从第 1 轮检查点执行快照分叉
			const forkedId = await forkSqliteConversationAtCheckpoint(cfg, origSessionId, cpTurn1);
			assert.ok(forkedId);
			assert.notEqual(forkedId, origSessionId);

			// 验证原库仍完整保留 4 条 step，新分叉库精确截断为 2 条 step 且更新了 trajectory_id
			const checkOrig = new DatabaseSync(origDbPath, { readOnly: true });
			const origCount = (checkOrig.prepare("SELECT COUNT(*) AS c FROM steps").get() as { c: number }).c;
			checkOrig.close();
			assert.equal(origCount, 4);

			const forkedDbPath = path.join(convDir, `${forkedId}.db`);
			const checkFork = new DatabaseSync(forkedDbPath, { readOnly: true });
			const forkCount = (checkFork.prepare("SELECT COUNT(*) AS c FROM steps").get() as { c: number }).c;
			const forkMeta = checkFork
				.prepare("SELECT trajectory_id FROM trajectory_meta")
				.get() as { trajectory_id: string };
			checkFork.close();
			assert.equal(forkCount, 2);
			assert.equal(forkMeta.trajectory_id, forkedId);

			// 验证分支锚点查找逻辑
			const m1: UserMessage = { role: "user", content: "turn1", timestamp: 1 };
			const m2: UserMessage = { role: "user", content: "turn2-edited", timestamp: 2 };
			const entries: SessionEntry[] = [
				{
					type: "custom",
					id: "e1",
					parentId: null,
					timestamp: "2026-11-21T00:00:00Z",
					customType: AGY_SESSION_ANCHOR_CUSTOM_TYPE,
					data: {
						version: 1,
						agySessionId: origSessionId,
						toolMode: "pi-tools",
						transcriptDigest: computeTranscriptDigest([m1]),
						messageCount: 1,
						mountDigest: "mount-1",
						toolsDigest: "tools-1",
						dbCheckpoint: cpTurn1,
					},
				},
			];

			const exactHit = findBranchAnchorForHistory({
				branchEntries: entries,
				priorMessages: [m1],
				toolMode: "pi-tools",
				mountDigest: "mount-1",
				config: cfg,
			});
			assert.equal(exactHit.kind, "exact");

			const forkHit = findBranchAnchorForHistory({
				branchEntries: entries,
				priorMessages: [m1, m2],
				toolMode: "pi-tools",
				mountDigest: "mount-1",
				config: cfg,
			});
			assert.equal(forkHit.kind, "forkable");

			// 验证 /agy sessions 刚导入的原始锚点（importedRaw: true）可跨空 mountDigest 直接命中 exact 恢复
			const importedEntries: SessionEntry[] = [
				{
					type: "custom",
					id: "e2",
					parentId: null,
					timestamp: "2026-11-21T00:00:00Z",
					customType: AGY_SESSION_ANCHOR_CUSTOM_TYPE,
					data: {
						version: 1,
						agySessionId: origSessionId,
						toolMode: "pi-tools",
						transcriptDigest: computeTranscriptDigest([m1]),
						messageCount: 1,
						mountDigest: "",
						toolsDigest: "",
						importedRaw: true,
					},
				},
			];
			const importedHit = findBranchAnchorForHistory({
				branchEntries: importedEntries,
				priorMessages: [m1],
				toolMode: "pi-tools",
				mountDigest: "new-live-mount-digest",
				config: cfg,
			});
			assert.equal(importedHit.kind, "exact");
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("适配 pi-traffic-optimization：图片压缩与归档占位符保持结构摘要恒定、精准统计投影指纹且重放不裁切 ctx:// 句柄", { skip: THIN_CLIENT_DISABLED }, () => {
		const hash64 = "a".repeat(64);
		const imgHash64 = "b".repeat(64);

		const rawUserPng: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "看看这张截图" },
				{ type: "image", data: "RAW_PNG_DATA", mimeType: "image/png" },
			],
			timestamp: 1,
		};
		const compressedUserWebp: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "看看这张截图" },
				{ type: "image", data: "SMALL_WEBP_DATA", mimeType: "image/webp" },
			],
			timestamp: 1,
		};
		const projectedUserImg: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "看看这张截图" },
				{
					type: "text",
					text: `[已归档图片 ctx://image/${imgHash64}] 1920x1080 image/webp optimized_bytes=12345 source=user；context_recall({id:"ctx://image/${imgHash64}"}) 可重新查看。`,
				},
			],
			timestamp: 1,
		};

		// 原始 PNG、WebP 压缩图与归档占位符在结构摘要上必须 100% 恒定，确保 turn_end 锚点跨重启与开关切换精准命中
		const digestRaw = computeTranscriptDigest([rawUserPng]);
		assert.equal(computeTranscriptDigest([compressedUserWebp]), digestRaw);
		assert.equal(computeTranscriptDigest([projectedUserImg]), digestRaw);

		const longPlaceholder = `[已归档 ctx://tool/${hash64}]\n${JSON.stringify({
			tool: "read",
			call: "call-1",
			preview: "x".repeat(5000),
		})}\n这是历史结果。精确取回：context_recall({id:"ctx://tool/${hash64}"})；query/offset/limit 可局部取回。`;

		const assistantStep: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "big.ts" } }],
			api: "antigravity-acp",
			provider: "antigravity",
			model: "gemini-4-neon",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const projectedToolRes = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text" as const, text: longPlaceholder }],
			isError: false,
			timestamp: 3,
		};
		const followUser: UserMessage = { role: "user", content: "继续分析", timestamp: 4 };

		const projState = inspectTrafficOptProjectionState([
			projectedUserImg,
			assistantStep,
			projectedToolRes,
			followUser,
		]);
		assert.equal(projState.archivedCount, 2);
		assert.ok(projState.projectionDigest.length === 64);

		// FreshReplay 必须完整保留超长 ctx:// 归档占位符末尾的 context_recall 指引，绝不截断破坏句柄
		const replayBlocks = buildFreshReplayPromptBlocks([
			projectedUserImg,
			assistantStep,
			projectedToolRes,
			followUser,
		]);
		const mergedReplayText = replayBlocks
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		assert.ok(mergedReplayText.includes(`context_recall({id:"ctx://tool/${hash64}"})`));
		assert.ok(!mergedReplayText.includes("[tool output truncated in replay]"));
	});

	it("buildFreshReplayPlan 与 buildPromptBlocksPreloadPlan 在单步内零开销直发，超限时生成严守双阈值的多步预注入与安全降级", { skip: THIN_CLIENT_DISABLED }, () => {
		const baseAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "antigravity-acp",
			provider: "antigravity",
			model: "gemini-4-neon",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};

		// 1. 短历史 + 工作区上下文可在单步安全预算内装下 -> preloadedTurns 为空
		const shortPlan = buildFreshReplayPlan({
			visibleMessages: [
				{ role: "user", content: "第一句", timestamp: 1 },
				baseAssistant,
				{ role: "user", content: "第二句", timestamp: 2 },
			],
			workspaceContextBlock: "<workspace_context>short</workspace_context>",
		});
		assert.equal(shortPlan.preloadedTurns.length, 0);
		assert.equal(shortPlan.omittedMessageCount, 0);
		assert.ok(
			shortPlan.finalPromptBlocks.some(
				(b) => b.type === "text" && b.text.includes("<workspace_context>short</workspace_context>"),
			),
		);

		// 2. 超长中英代码混合历史 + 32KB workspaceContextBlock -> 多步预注入零丢失 + 单步降级严守双阈值且保住末尾提问
		const bigWorkspace = `<workspace_context>\n${"规则描述与技能清单 ".repeat(1_200)}\n</workspace_context>`;
		const longMessages: (UserMessage | AssistantMessage)[] = [];
		for (let i = 0; i < 40; i++) {
			longMessages.push({
				role: "user",
				content: `TURN_${i}_SECRET_${i * 7}: ${"代码片段 { key: 12345, val: '中文测试' } ".repeat(90)}`,
				timestamp: i * 2 + 1,
			});
			longMessages.push({
				...baseAssistant,
				content: [
					{
						type: "text",
						text: `REPLY_${i}: ${"分析结果与调用说明 alpha beta gamma 9876543210 ".repeat(85)}`,
					},
				],
				timestamp: i * 2 + 2,
			});
		}
		const criticalTail: UserMessage = {
			role: "user",
			content: "FINAL_TAIL_QUESTION_MUST_SURVIVE_BOTH_PATHS_9999",
			timestamp: 99999,
		};

		const bigPlan = buildFreshReplayPlan({
			visibleMessages: [...longMessages, criticalTail],
			workspaceContextBlock: bigWorkspace,
			maxContextWindowTokens: 1_000_000,
		});
		assert.ok(bigPlan.preloadedTurns.length >= 2, `应拆分为多步预注入，实际=${bigPlan.preloadedTurns.length}`);
		assert.equal(bigPlan.omittedMessageCount, 0, "1M 窗口下应完整保留全部 80 条历史零省略");

		// 验证每一条预注入 USER_INPUT 步与最终 prompt 均严格低于单步安全红线
		for (const turn of bigPlan.preloadedTurns) {
			assert.ok(
				Buffer.byteLength(turn.userText, "utf8") <= SAFE_SINGLE_STEP_MAX_BYTES,
				"预注入步字节数超标",
			);
			assert.ok(
				estimateStepTokens(turn.userText) <= SAFE_SINGLE_STEP_MAX_TOKENS,
				"预注入步估算 token 超标",
			);
			assert.ok(turn.assistantAckText.length > 0);
		}
		assert.equal(exceedsSafeSingleStepBudget(bigPlan.finalPromptBlocks), false);
		const allPreloadedText = bigPlan.preloadedTurns.map((t) => t.userText).join("\n");
		assert.ok(allPreloadedText.includes("<workspace_context>"), "首步应包含 workspace_context");
		assert.ok(allPreloadedText.includes("TURN_0_SECRET_0"), "最早一轮历史必须完整保留");
		assert.ok(allPreloadedText.includes("TURN_39_SECRET_273"), "最近历史必须完整保留");
		const finalText = bigPlan.finalPromptBlocks
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		assert.ok(finalText.includes("FINAL_TAIL_QUESTION_MUST_SURVIVE_BOTH_PATHS_9999"));
		assert.ok(!finalText.includes("<workspace_context>"), "workspace_context 不应重复发送");

		// 验证无 SQLite 单步降级块也严格低于双阈值，且完整保留末尾提问
		const fallbackMeasured = measurePromptBlocksSize(bigPlan.singleStepFallbackBlocks);
		assert.ok(fallbackMeasured.bytes <= SAFE_SINGLE_STEP_MAX_BYTES);
		assert.ok(fallbackMeasured.tokens <= SAFE_SINGLE_STEP_MAX_TOKENS);
		const fallbackText = bigPlan.singleStepFallbackBlocks
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		assert.ok(fallbackText.includes("FINAL_TAIL_QUESTION_MUST_SURVIVE_BOTH_PATHS_9999"));

		// 3. 超长单条文本切片不撕裂 UTF-16 代理对，且 buildPromptBlocksPreloadPlan 保留末尾指令与图片块
		const emojiLog = `HEAD_MARKER\n${"日志🔥🚀代码 0123456789\n".repeat(4_500)}TAIL_MARKER_8888`;
		const chunks = splitTextToSafeChunks(emojiLog, 20_000, 12_000);
		assert.ok(chunks.length >= 4);
		assert.equal(chunks.join(""), emojiLog, "切片拼接必须 100% 无损还原原文");
		for (const c of chunks) {
			assert.ok(Buffer.byteLength(c, "utf8") <= 20_000);
			assert.ok(estimateStepTokens(c) <= 12_000);
			// 不允许末尾悬挂高代理项或开头悬挂低代理项
			const first = c.charCodeAt(0);
			const last = c.charCodeAt(c.length - 1);
			assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "切片开头出现残缺低代理项");
			assert.ok(!(last >= 0xd800 && last <= 0xdbff), "切片末尾出现残缺高代理项");
		}

		const singleBlockPlan = buildPromptBlocksPreloadPlan([
			{ type: "text", text: emojiLog },
			{ type: "image", data: "BASE64IMG", mimeType: "image/png" },
		]);
		assert.ok(singleBlockPlan.preloadedTurns.length >= 1);
		assert.ok(singleBlockPlan.finalPromptBlocks.some((b) => b.type === "image" && b.data === "BASE64IMG"));
		assert.equal(exceedsSafeSingleStepBudget(singleBlockPlan.finalPromptBlocks), false);
		assert.equal(exceedsSafeSingleStepBudget(singleBlockPlan.singleStepFallbackBlocks), false);
		const fallbackSingleText = singleBlockPlan.singleStepFallbackBlocks
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		assert.ok(fallbackSingleText.includes("HEAD_MARKER"));
		assert.ok(fallbackSingleText.includes("TAIL_MARKER_8888"));
	});

	it("createPreloadedSqliteConversation 与 appendPreloadedTurnsToSqliteConversation 写入合规库结构且不污染统计水位", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-preload-db-"));
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			geminiDir: path.join(tmpRoot, ".gemini"),
			enableSqliteFork: true,
		};

		try {
			const seededId = await createPreloadedSqliteConversation(cfg, [
				{ userText: "PART_1_CONTENT_你好", assistantAckText: "Ack 1" },
				{ userText: "PART_2_CONTENT_世界", assistantAckText: "Ack 2" },
			]);
			assert.ok(seededId);

			const dbPath = path.join(cfg.geminiDir, "antigravity-cli", "conversations", `${seededId}.db`);
			assert.ok(fs.existsSync(dbPath));

			const db = new DatabaseSync(dbPath, { readOnly: true });
			const uv = db.prepare("PRAGMA user_version").get() as { user_version: number };
			assert.equal(uv.user_version, 1);

			const meta = db.prepare("SELECT * FROM trajectory_meta").get() as {
				trajectory_id: string;
				cascade_id: string;
				trajectory_type: number;
				source: number;
			};
			assert.equal(meta.trajectory_id, seededId);
			assert.equal(meta.cascade_id, seededId);
			assert.equal(meta.trajectory_type, 4);
			assert.equal(meta.source, 17);

			const rows = db
				.prepare("SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx ASC")
				.all() as Array<{
				idx: number;
				step_type: number;
				status: number;
				metadata: Uint8Array | null;
				step_payload: Uint8Array;
			}>;
			assert.equal(rows.length, 4);
			assert.deepEqual(
				rows.map((r) => [r.idx, r.step_type, r.status, r.metadata]),
				[
					[0, 14, 3, null],
					[1, 15, 3, null],
					[2, 14, 3, null],
					[3, 15, 3, null],
				],
			);
			assert.ok(Buffer.from(rows[0].step_payload).includes("PART_1_CONTENT_你好"));
			assert.ok(Buffer.from(rows[3].step_payload).includes("Ack 2"));
			db.close();

			// 水位读取与真实 token 统计不被预注入步污染
			assert.equal(await readCurrentMaxSqliteStepIdx(cfg, seededId), 3);
			assert.deepEqual(await readSqliteGenerationUsagesSince(cfg, seededId, -1), []);

			// 模拟分叉尾部停在 USER_INPUT（step_type=14），追加时应自动补一条 PLANNER_RESPONSE 保持严格交替
			const dbEdit = new DatabaseSync(dbPath);
			dbEdit.prepare("DELETE FROM steps WHERE idx = 3").run();
			dbEdit.close();

			const appended = await appendPreloadedTurnsToSqliteConversation(cfg, seededId, [
				{ userText: "APPENDED_PART_3", assistantAckText: "Ack 3" },
			]);
			assert.equal(appended, true);

			const dbCheck = new DatabaseSync(dbPath, { readOnly: true });
			const afterRows = dbCheck
				.prepare("SELECT idx, step_type FROM steps ORDER BY idx ASC")
				.all() as Array<{ idx: number; step_type: number }>;
			dbCheck.close();
			assert.deepEqual(
				afterRows.map((r) => [r.idx, r.step_type]),
				[
					[0, 14],
					[1, 15],
					[2, 14],
					[3, 15],
					[4, 14],
					[5, 15],
				],
			);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("cloneTemplateSqliteConversationWithPreload 完整保留模板 trajectory_metadata_blob 中的 pi-bridge 规格并同步替换 UUID，模板缺失元数据时拒绝生成裸库", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-template-preload-"));
		try {
			const cfg: BridgeConfig = {
				...DEFAULT_BRIDGE_CONFIG,
				geminiDir: path.join(tmpRoot, ".gemini"),
				enableSqliteFork: true,
			};
			const convDir = path.join(cfg.geminiDir, "antigravity-cli", "conversations");
			fs.mkdirSync(convDir, { recursive: true });

			// 1. 构造含 trajectory_metadata_blob（带 pi-bridge 与模板 UUID）的官方模板会话库
			const templateId = "11111111-2222-4333-8444-555555555555";
			const origTrajId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
			const templateDbPath = path.join(convDir, `${templateId}.db`);
			const tmplDb = new DatabaseSync(templateDbPath);
			tmplDb.exec(`
				PRAGMA user_version = 1;
				CREATE TABLE trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer);
				CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0);
				CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
				CREATE TABLE executor_metadata (idx integer PRIMARY KEY, data blob);
				CREATE TABLE parent_references (idx integer PRIMARY KEY, data blob);
				CREATE TABLE trajectory_metadata_blob (id text PRIMARY KEY DEFAULT "main", data blob);
				CREATE TABLE battle_mode_infos (idx integer PRIMARY KEY, data blob);
			`);
			tmplDb
				.prepare("INSERT INTO trajectory_meta VALUES (?, ?, 4, 17)")
				.run(origTrajId, templateId);
			const fakeBlob = Buffer.from(
				`header\x00pi-bridge\x00Tool execution bridge agent for Pi\x00${templateId}\x00${origTrajId}\x00footer`,
				"utf8",
			);
			tmplDb.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(fakeBlob);
			tmplDb.close();

			const clonedId = await cloneTemplateSqliteConversationWithPreload(cfg, templateId, [
				{ userText: "CLONED_HISTORY_1", assistantAckText: "Ack 1" },
				{ userText: "CLONED_HISTORY_2", assistantAckText: "Ack 2" },
			]);
			assert.ok(clonedId && clonedId !== templateId);

			const clonedDb = new DatabaseSync(path.join(convDir, `${clonedId}.db`), { readOnly: true });
			const meta = clonedDb.prepare("SELECT * FROM trajectory_meta").get() as {
				trajectory_id: string;
				cascade_id: string;
			};
			assert.equal(meta.trajectory_id, clonedId);
			assert.equal(meta.cascade_id, clonedId);

			const blobRow = clonedDb
				.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
				.get() as { data: Uint8Array };
			const blobText = Buffer.from(blobRow.data).toString("utf8");
			assert.equal(blobRow.data.length, fakeBlob.length, "UUID 替换必须保持原位等长以防破坏 Protobuf 编码");
			assert.ok(blobText.includes("pi-bridge"), "克隆库必须完整保留 pi-bridge Agent 规格");
			assert.ok(blobText.includes(clonedId), "克隆库元数据中的旧 UUID 应同步替换为新会话 UUID");
			assert.ok(!blobText.includes(templateId), "克隆库元数据中不应残留模板 UUID");
			assert.ok(!blobText.includes(origTrajId), "克隆库元数据中不应残留旧 trajectory_id");

			const stepRows = clonedDb
				.prepare("SELECT idx, step_type FROM steps ORDER BY idx ASC")
				.all() as Array<{ idx: number; step_type: number }>;
			clonedDb.close();
			assert.deepEqual(
				stepRows.map((r) => [r.idx, r.step_type]),
				[
					[0, 14],
					[1, 15],
					[2, 14],
					[3, 15],
				],
			);

			// 2. 模板库缺少 trajectory_metadata_blob 时，必须拒绝克隆返回 undefined，绝不生成失去 pi-bridge 约束的裸库
			const bareId = "99999999-8888-4777-8666-555555555555";
			const bareDb = new DatabaseSync(path.join(convDir, `${bareId}.db`));
			bareDb.exec(`
				CREATE TABLE trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer);
				CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, status integer, step_payload blob);
				CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob);
				CREATE TABLE executor_metadata (idx integer PRIMARY KEY, data blob);
				CREATE TABLE parent_references (idx integer PRIMARY KEY, data blob);
				CREATE TABLE trajectory_metadata_blob (id text PRIMARY KEY, data blob);
			`);
			bareDb.close();

			const rejected = await cloneTemplateSqliteConversationWithPreload(cfg, bareId, [
				{ userText: "SHOULD_REJECT", assistantAckText: "Ack" },
			]);
			assert.equal(rejected, undefined);

			// 3. 历史恢复自愈校验：克隆库应通过 pi-bridge 校验，空元数据裸库应被识别为无效以便自动重建
			assert.equal(await hasValidAgentMetadataBlob(cfg, clonedId, "pi-bridge"), true);
			assert.equal(await hasValidAgentMetadataBlob(cfg, bareId, "pi-bridge"), false);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("重放截断保留单图归档 ctx://image/ 句柄、多图短文本不被误裁且预注入历史图片携带来源标签", { skip: THIN_CLIENT_DISABLED }, () => {
		const imagePlaceholder =
			"[已归档图片 ctx://image/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef]";
		const longToolMsg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_img_mixed",
			toolName: "read",
			content: [
				{
					type: "text",
					text: `${"前面超长正文 ".repeat(600)}\n${imagePlaceholder}\n${"后面超长正文 ".repeat(600)}`,
				},
			],
			isError: false,
			timestamp: 10,
		};
		const replayBlocks = buildFreshReplayPromptBlocks([
			{ role: "user", content: "读取结果", timestamp: 1 },
			longToolMsg,
			{ role: "user", content: "继续分析", timestamp: 20 },
		]);
		const toolBlock = replayBlocks.find(
			(b) => b.type === "text" && b.text.includes('id="call_img_mixed"'),
		);
		assert.ok(toolBlock && toolBlock.type === "text");
		assert.ok(
			toolBlock.text.includes(imagePlaceholder),
			"超长正文截断时必须完整保留 ctx://image/ 归档句柄",
		);

		// 45 张图片 + 2000 字节短文本：超限源自图片数量而非文本过长，不应无故切分或截断短文本
		const manyImages = Array.from({ length: 45 }, () => ({
			type: "image" as const,
			data: "AAAA",
			mimeType: "image/png",
		}));
		const shortQuestion = `SHORT_QUESTION_KEEP_INTACT ${"说明文字 ".repeat(150)}`;
		const multiImgPlan = buildPromptBlocksPreloadPlan([
			{ type: "text", text: shortQuestion },
			...manyImages,
		]);
		assert.equal(multiImgPlan.preloadedTurns.length, 0);
		assert.ok(
			multiImgPlan.finalPromptBlocks.some(
				(b) => b.type === "text" && b.text === shortQuestion,
			),
			"大量图片场景下短文本必须完整保留不被裁切",
		);

		// SQLite 多步预注入中保留的近期历史工具图片应包裹 <tool_result> 标签以保留工具归属
		const dummyAssistant: AssistantMessage = {
			role: "assistant",
			api: "antigravity-acp",
			provider: "antigravity",
			model: "gemini-4-neon",
			content: [{ type: "text", text: `长回答 ${"中文文本段 ".repeat(3_500)}` }],
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const longHistoryMsgs: Array<UserMessage | AssistantMessage | ToolResultMessage> = [];
		for (let i = 0; i < 16; i++) {
			longHistoryMsgs.push({
				role: "user",
				content: `长提问 ${i} ${"上下文内容 alpha beta ".repeat(500)}`,
				timestamp: i * 2 + 1,
			});
			longHistoryMsgs.push({ ...dummyAssistant, timestamp: i * 2 + 2 });
		}
		longHistoryMsgs.push(
			{
				role: "toolResult",
				toolCallId: "agy_mcp_snap_1",
				toolName: "read",
				content: [
					{ type: "text", text: "截图已读" },
					{ type: "image", data: "BBBB", mimeType: "image/png" },
				],
				isError: false,
				timestamp: 100,
			},
			{ role: "user", content: "结合上面的截图回答", timestamp: 101 },
		);
		const preloadWithHistoryImage = buildFreshReplayPlan({
			visibleMessages: longHistoryMsgs,
			maxContextWindowTokens: 1_000_000,
		});
		assert.ok(preloadWithHistoryImage.preloadedTurns.length > 0);
		const imgIdx = preloadWithHistoryImage.finalPromptBlocks.findIndex(
			(b) => b.type === "image" && b.data === "BBBB",
		);
		assert.ok(imgIdx > 0, "多步预注入末片应附带近期历史图片");
		const prevBlock = preloadWithHistoryImage.finalPromptBlocks[imgIdx - 1];
		assert.ok(
			prevBlock.type === "text" &&
				prevBlock.text.includes('<tool_result id="agy_mcp_snap_1" tool="read" status="ok">'),
			"历史保留的工具图片前应附带 <tool_result> 来源标签",
		);
	});

	it("parseGenMetadataUpstreamRequest 与只读 SQLite 读取精确还原上游全量请求分类、图片哈希与工具声明并排除末尾本轮输出", async () => {
		const encVarint = (val: bigint | number): Buffer => {
			let v = typeof val === "bigint" ? val : BigInt(val);
			if (v < 0n) v = BigInt.asUintN(64, v);
			const out: number[] = [];
			while (v >= 0x80n) {
				out.push(Number((v & 0x7fn) | 0x80n));
				v >>= 7n;
			}
			out.push(Number(v));
			return Buffer.from(out);
		};
		const pbVarint = (field: number, val: bigint | number): Buffer =>
			Buffer.concat([encVarint((field << 3) | 0), encVarint(val)]);
		const pbBytes = (field: number, data: Buffer | string): Buffer => {
			const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
			return Buffer.concat([encVarint((field << 3) | 2), encVarint(buf.length), buf]);
		};

		const fakeWebp = Buffer.from("RIFF____WEBPVP8_DEMO_IMAGE_PAYLOAD_BYTES");
		const fakeSig = Buffer.alloc(48, 0xab);

		// 构造完整 ChatRequest protobuf（覆盖 agy-tools 原生系统提示、user_rules、workspace_context、工具调用与签名、延迟多模态图片、工具声明、64位负数 varint、末尾本轮输出）
		const userMsg0 = Buffer.concat([
			pbVarint(2, 1),
			pbBytes(
				3,
				"<USER_REQUEST>\n<workspace_context>\n<cwd>/repo</cwd>\n</workspace_context>\n请查看文件\n</USER_REQUEST>",
			),
		]);
		const assistantHistMsg = Buffer.concat([
			pbVarint(2, 2),
			pbBytes(3, "正在读取图片"),
			pbBytes(11, "Need to read image first"),
			pbBytes(
				6,
				Buffer.concat([
					pbBytes(1, "call_101"),
					pbBytes(2, "mcp_pi_tools_read"),
					pbBytes(3, '{"path":"demo.png"}'),
					pbBytes(7, fakeSig),
				]),
			),
		]);
		const toolResultMsg = Buffer.concat([
			pbVarint(2, 4),
			pbBytes(7, "call_101"),
			pbBytes(3, "Read image file [image/png]\n[1 image(s) (>10KB) delivered via follow-up]"),
		]);
		const multimodalImgMsg = Buffer.concat([
			pbVarint(2, 1),
			pbBytes(
				3,
				'<USER_REQUEST>\n<tool_result id="agy_mcp_1" tool="read" status="ok">\n[Attached 1 image]\n</tool_result>\nPlease inspect the attached tool result image(s) above and continue.\n</USER_REQUEST>',
			),
			pbBytes(19, Buffer.concat([pbBytes(1, "image/webp"), pbBytes(2, fakeWebp)])),
		]);
		// 末尾 role=2 是 agy 在本轮生成结束后追加的输出（不应计入本轮上传字节）
		const trailingGeneratedOutput = Buffer.concat([
			pbVarint(2, 2),
			pbBytes(3, "这是本轮刚生成的最终回复，绝不能算进本轮上传！"),
			pbBytes(20, Buffer.alloc(120, 0xcd)),
		]);
		const toolDef = Buffer.concat([
			pbBytes(1, "mcp_pi_tools_read"),
			pbBytes(2, "Read file contents"),
			pbBytes(3, '{"type":"object","properties":{"path":{"type":"string"}}}'),
		]);
		const userRules = Buffer.concat([pbBytes(1, "user_rules"), pbBytes(2, "<user_rules>规则</user_rules>")]);
		const metaWithNegVarint = Buffer.concat([pbVarint(2, -1n), pbBytes(10, "Tools index")]);

		const chatReq = Buffer.concat([
			pbBytes(1, "<identity>Native system prompt</identity>"),
			pbBytes(16, userRules),
			pbBytes(9, metaWithNegVarint),
			pbBytes(8, toolDef),
			pbBytes(2, userMsg0),
			pbBytes(2, assistantHistMsg),
			pbBytes(2, toolResultMsg),
			pbBytes(2, multimodalImgMsg),
			pbBytes(2, trailingGeneratedOutput),
		]);
		const fullGenData = pbBytes(1, chatReq);

		const snap = parseGenMetadataUpstreamRequest(fullGenData, 5);
		assert.ok(snap, "完整 gen_metadata 应成功解析");
		assert.equal(snap.genIdx, 5);
		assert.ok(snap.system_bytes > 0, "应计入原生 system prompt、user_rules 与 workspace_context");
		assert.ok(snap.user_text_bytes > 0);
		assert.ok(snap.assistant_text_bytes > 0);
		assert.ok(snap.tool_call_bytes > 0);
		assert.ok(snap.tool_result_bytes > 0);
		assert.ok(snap.tool_schema_bytes > 0);
		assert.equal(snap.opaque_reasoning_bytes, Math.ceil(fakeSig.length / 3) * 4, "仅计入历史思考签名，排除末尾本轮输出签名");
		assert.equal(snap.image_count, 1);
		assert.equal(snap.image_decoded_bytes, fakeWebp.length);
		assert.equal(snap.image_payload_bytes, Math.ceil(fakeWebp.length / 3) * 4);
		assert.equal(snap.images[0].mime_type, "image/webp");
		assert.equal(snap.images[0].tool_name, "read");
		assert.equal(snap.images[0].source_type, "toolResult/read image");
		assert.equal(
			snap.total_payload_bytes,
			snap.system_bytes +
				snap.user_text_bytes +
				snap.assistant_text_bytes +
				snap.tool_call_bytes +
				snap.tool_result_bytes +
				snap.image_payload_bytes +
				snap.tool_schema_bytes +
				snap.other_bytes,
			"全部分项之和必须与 total_payload_bytes 严格守恒",
		);

		// 已被 agy 裁剪的旧代次摘要（无 field 2 消息体）应返回 undefined
		const strippedGenData = pbBytes(1, Buffer.concat([pbBytes(19, "gemini-4-neon")]));
		assert.equal(parseGenMetadataUpstreamRequest(strippedGenData, 4), undefined);

		// 逐条读取有效请求，裁剪过的记录只推进水位，不复制其他代次补数。
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-gen-upstream-"));
		try {
			const cfg: BridgeConfig = {
				...DEFAULT_BRIDGE_CONFIG,
				geminiDir: path.join(tmpRoot, ".gemini"),
			};
			const convDir = path.join(cfg.geminiDir, cfg.appDataDirName, "conversations");
			fs.mkdirSync(convDir, { recursive: true });
			const sid = "11112222-3333-4444-5555-666677778888";
			const db = new DatabaseSync(path.join(convDir, `${sid}.db`));
			db.exec("CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob);");
			const insert = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
			insert.run(0, strippedGenData);
			insert.run(1, fullGenData);
			insert.run(2, pbBytes(1, pbBytes(2, Buffer.concat([pbVarint(2, 1), pbBytes(3, "不同请求")]))));
			insert.run(3, strippedGenData);
			db.close();

			assert.equal(await readCurrentMaxSqliteGenIdx(cfg, sid), 3);
			const res = await readSqliteUpstreamRequestsSince(cfg, sid, 0, []);
			assert.equal(res.maxGenIdx, 3);
			assert.deepEqual(res.snapshots.map((entry) => entry.genIdx), [1, 2]);
			assert.equal(res.snapshots[0].total_payload_bytes, snap.total_payload_bytes);
			assert.equal(res.snapshots[1].user_text_bytes, Buffer.byteLength("不同请求"));
			assert.deepEqual(await readSqliteUpstreamRequestsSince(cfg, sid, 3, []), { maxGenIdx: 3, snapshots: [] });
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("剥离非 429 瞬时流重试告警行、过滤失败重试步生成记账并等待 status=2 运行中工具步骤落盘", async () => {
		// 1. QuotaSoftErrorFilter：剥离非 429 瞬时流中断重试行，保留代码块内示例，正常拦截 429
		const filter = new QuotaSoftErrorFilter();
		const p1 = filter.push("第一段正常输出\n⚠ API error (attempt 1): stream reading error: ");
		assert.equal(p1.safeText, "第一段正常输出\n");
		assert.equal(p1.quotaError, undefined);
		const p2 = filter.push("unexpected EOF\n重试恢复后的第二段正文\n");
		assert.equal(p2.safeText, "重试恢复后的第二段正文\n");
		assert.equal(p2.quotaError, undefined);

		const fenceFilter = new QuotaSoftErrorFilter();
		const fp = fenceFilter.push("```\n⚠ API error (attempt 1): stream reading error: unexpected EOF\n```\n");
		assert.ok(fp.safeText.includes("unexpected EOF"), "代码块中的告警示例文本应完整保留");

		// 2. readSqliteGenerationUsagesSince 排除 status=6/7/8 失败或未完结步 & waitForSqliteToolStepsSettled 等待 status=2
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-status2-settled-"));
		try {
			const cfg: BridgeConfig = {
				...DEFAULT_BRIDGE_CONFIG,
				geminiDir: path.join(tmpRoot, ".gemini"),
			};
			const convDir = path.join(cfg.geminiDir, cfg.appDataDirName, "conversations");
			fs.mkdirSync(convDir, { recursive: true });
			const sid = "22223333-4444-5555-6666-777788889999";
			const dbPath = path.join(convDir, `${sid}.db`);
			const db = new DatabaseSync(dbPath);
			db.exec(
				"CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL, status integer NOT NULL, step_payload blob, metadata blob);",
			);

			const encodeVarint = (n: number): number[] => {
				const out: number[] = [];
				let v = n;
				while (v >= 0x80) {
					out.push((v & 0x7f) | 0x80);
					v = Math.floor(v / 128);
				}
				out.push(v);
				return out;
			};
			const makeMeta = (inp: number, outp: number) => {
				const inner = Buffer.from([
					...encodeVarint((2 << 3) | 0),
					...encodeVarint(inp),
					...encodeVarint((3 << 3) | 0),
					...encodeVarint(outp),
				]);
				return Buffer.from([...encodeVarint((9 << 3) | 2), ...encodeVarint(inner.length), ...inner]);
			};

			// idx=1: 失败的首次尝试 (status=7 ERROR)，idx=2: 重试成功的生成 (status=3 DONE)，idx=3: 运行中的 MCP 工具 (status=2 RUNNING)
			db.prepare("INSERT INTO steps VALUES (1, 15, 7, NULL, ?)").run(makeMeta(999, 10));
			db.prepare("INSERT INTO steps VALUES (2, 15, 3, NULL, ?)").run(makeMeta(1200, 85));
			db.prepare("INSERT INTO steps VALUES (3, 132, 2, X'01', NULL)").run();
			db.close();

			const gens = await readSqliteGenerationUsagesSince(cfg, sid, 0);
			assert.equal(gens.length, 1, "应排除 status=7 的失败重试生成步");
			assert.equal(gens[0].stepIdx, 2);
			assert.equal(gens[0].inputTokens, 1200);
			assert.equal(gens[0].outputTokens, 85);

			// 在 55ms 后将 idx=3 的工具步骤状态由 2 (RUNNING) 更新为 3 (DONE)，验证 waitForSqliteToolStepsSettled 会等待该翻转完成
			const t0 = Date.now();
			const flipTimer = setTimeout(() => {
				const writerDb = new DatabaseSync(dbPath);
				writerDb.prepare("UPDATE steps SET status = 3 WHERE idx = 3").run();
				writerDb.close();
			}, 55);
			try {
				await waitForSqliteToolStepsSettled(cfg, sid, 300);
				const elapsed = Date.now() - t0;
				assert.ok(elapsed >= 45, `应等待 status=2 工具步骤变为终态后再返回 (elapsed=${elapsed}ms)`);
			} finally {
				clearTimeout(flipTimer);
			}
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});
