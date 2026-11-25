import { fileURLToPath } from "node:url";
import type { ImageContent, JsonObject, TextContent } from "@earendil-works/pi-ai";
import {
	defineTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	AcpElicitationCreateParams,
	AcpElicitationCreateResult,
	AcpRequestPermissionParams,
	AcpRequestPermissionResult,
	AcpToolCallContentItem,
	AcpToolCallLocation,
	AcpToolKind,
	AcpToolStatus,
} from "../acp/protocol.ts";
import {
	AGY_MIRROR_TOOL_NAMES,
	type AgyDiffPayload,
	type AgyMirrorToolDetails,
	type AgyMirrorToolName,
	getMirrorToolRenderers,
} from "./agy-renderers.ts";

const MirrorToolParamsSchema = Type.Object(
	{
		title: Type.Optional(Type.String()),
		kind: Type.Optional(Type.String()),
		path: Type.Optional(Type.String()),
		line: Type.Optional(Type.Number()),
		limit: Type.Optional(Type.Number()),
		command: Type.Optional(Type.String()),
		query: Type.Optional(Type.String()),
		agentRole: Type.Optional(Type.String()),
		tool: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);

export interface ClassifiedMirrorCall {
	mirrorToolName: AgyMirrorToolName;
	arguments: JsonObject;
}

function asRecord(val: unknown): Record<string, unknown> | undefined {
	if (val && typeof val === "object" && !Array.isArray(val)) {
		return val as Record<string, unknown>;
	}
	return undefined;
}

function pickFirstString(
	obj: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	if (!obj) return undefined;
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === "string" && v.trim().length > 0) {
			return v.trim();
		}
	}
	return undefined;
}

function pickFirstPositiveInt(
	obj: Record<string, unknown> | undefined,
	keys: readonly string[],
): number | undefined {
	if (!obj) return undefined;
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === "number" && Number.isSafeInteger(v) && v >= 1) {
			return v;
		}
		if (typeof v === "string" && /^\d+$/.test(v.trim())) {
			const parsed = Number.parseInt(v.trim(), 10);
			if (Number.isSafeInteger(parsed) && parsed >= 1) {
				return parsed;
			}
		}
	}
	return undefined;
}

function normalizeMirrorFilePath(rawPath: string | undefined): string | undefined {
	if (!rawPath) return undefined;
	const trimmed = rawPath.trim();
	if (!trimmed) return undefined;
	if (/^file:\/\//i.test(trimmed)) {
		try {
			return fileURLToPath(trimmed);
		} catch {
			return trimmed;
		}
	}
	return trimmed;
}

/**
 * 将 AGY 原生 `tool_call` 事件智能归类为对应的 Pi 语义镜像工具与展示参数。
 */
export function classifyAgyToolCall(input: {
	title?: string;
	kind?: AcpToolKind;
	rawInput?: unknown;
	locations?: AcpToolCallLocation[];
	content?: AcpToolCallContentItem[];
}): ClassifiedMirrorCall {
	const rawObj = asRecord(input.rawInput);
	const title = input.title?.trim() ?? "";
	const lowerTitle = title.toLowerCase();
	const kind = (input.kind ?? "").toLowerCase();

	const locPath = normalizeMirrorFilePath(input.locations?.[0]?.path);
	const locLine =
		typeof input.locations?.[0]?.line === "number" &&
		Number.isSafeInteger(input.locations[0].line) &&
		input.locations[0].line >= 1
			? input.locations[0].line
			: pickFirstPositiveInt(rawObj, ["StartLine", "start_line", "startLine", "offset", "line"]);
	const explicitLimit = pickFirstPositiveInt(rawObj, ["limit", "Limit", "num_lines", "NumLines"]);
	const endLine = pickFirstPositiveInt(rawObj, ["EndLine", "end_line", "endLine"]);
	const lineLimit =
		explicitLimit ??
		(endLine !== undefined && endLine >= (locLine ?? 1) ? endLine - (locLine ?? 1) + 1 : undefined);
	const filePath =
		locPath ||
		normalizeMirrorFilePath(
			pickFirstString(rawObj, ["Path", "path", "TargetFile", "AbsolutePath", "file_path", "uri"]),
		);
	const command = pickFirstString(rawObj, ["CommandLine", "command", "cmd"]);
	const query = pickFirstString(rawObj, ["Query", "query", "Pattern", "pattern", "SearchPath"]);
	// 仅匹配明确的子代理专属字段，避免普通工具的通用 name / Description 字段误触发 agy_subagent
	const agentRole = pickFirstString(rawObj, [
		"Role",
		"TypeName",
		"SubagentType",
		"subagent_type",
		"agent_role",
	]);

	const hasDiffBlock = Boolean(input.content?.some((item) => item.type === "diff"));
	const isExplicitSubagentTitle =
		lowerTitle.includes("subagent") ||
		lowerTitle.includes("swarm") ||
		lowerTitle.includes("workflow");

	let mirrorToolName: AgyMirrorToolName = "agy_tool";
	// agy reports its own non-shell tools (schedule, manage_task, ...) as kind
	// "other" titled "Run <tool_name>"; they are not shell commands.
	const internalTool =
		kind === "other" && command === undefined ? /^run ([a-z][a-z0-9_]*)$/.exec(lowerTitle)?.[1] : undefined;

	if (internalTool) {
		mirrorToolName = "agy_tool";
	} else if (isExplicitSubagentTitle) {
		mirrorToolName = "agy_subagent";
	} else if (kind === "execute" || command !== undefined || lowerTitle.startsWith("run ")) {
		mirrorToolName = "agy_bash";
	} else if (hasDiffBlock || kind === "edit" || lowerTitle.startsWith("edit")) {
		mirrorToolName = "agy_edit";
	} else if (lowerTitle.startsWith("write") || lowerTitle.startsWith("create ")) {
		mirrorToolName = "agy_write";
	} else if (kind === "read" || lowerTitle.startsWith("read") || lowerTitle.startsWith("view")) {
		mirrorToolName = "agy_read";
	} else if (
		kind === "search" ||
		kind === "fetch" ||
		query !== undefined ||
		lowerTitle.includes("search") ||
		lowerTitle.includes("grep") ||
		lowerTitle.includes("find")
	) {
		mirrorToolName = "agy_search";
	} else if (agentRole !== undefined) {
		mirrorToolName = "agy_subagent";
	}

	const args: Record<string, string | number> = {};
	if (title) args.title = title;
	if (input.kind) args.kind = input.kind;
	if (filePath) args.path = filePath;
	if (typeof locLine === "number") args.line = locLine;
	if (mirrorToolName === "agy_read" && typeof lineLimit === "number") args.limit = lineLimit;
	if (command) args.command = command;
	if (query) args.query = query;
	if (agentRole) args.agentRole = agentRole;
	if (internalTool) args.tool = internalTool;

	return {
		mirrorToolName,
		arguments: args,
	};
}

interface TrackedMirrorCallState {
	toolCallId: string;
	agySessionId: string;
	title?: string;
	kind?: string;
	path?: string;
	line?: number;
	limit?: number;
	command?: string;
	query?: string;
	agentRole?: string;
	tool?: string;
	status: AcpToolStatus;
	contentBlocks: Array<TextContent | ImageContent>;
	diffs: AgyDiffPayload[];
	rawOutputText?: string;
	completed: boolean;
	failed: boolean;
	onUpdate?: AgentToolUpdateCallback<AgyMirrorToolDetails>;
	activeCtx?: ExtensionContext;
	activeSignal?: AbortSignal;
	resolveCompletion?: (result: AgentToolResult<AgyMirrorToolDetails>) => void;
}

function mergeContentItems(
	items: readonly AcpToolCallContentItem[] | undefined,
): { blocks: Array<TextContent | ImageContent>; diffs: AgyDiffPayload[] } {
	const blocks: Array<TextContent | ImageContent> = [];
	const diffs: AgyDiffPayload[] = [];
	if (!items) return { blocks, diffs };

	for (const item of items) {
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
			diffs.push({
				path: normalizeMirrorFilePath(item.path) ?? item.path,
				oldText: item.oldText ?? "",
				newText: item.newText,
			});
		}
	}
	return { blocks, diffs };
}

function formatRawOutputFallback(rawOutput: unknown): string | undefined {
	if (rawOutput === undefined || rawOutput === null) return undefined;
	if (typeof rawOutput === "string") return rawOutput;
	try {
		return JSON.stringify(rawOutput, null, 2);
	} catch {
		return String(rawOutput);
	}
}

/** What a note for a mirror call without output may look at. */
export interface EmptyResultContext {
	agySessionId: string;
	kind?: string;
	title?: string;
	command?: string;
	/** agy-internal tool name such as `schedule`. */
	toolName?: string;
}

/**
 * 模式 A 镜像工具状态中枢，同时承载：
 * 1. `tool_call` / `tool_call_update` 与 `Mirror.execute()` 的跨循环实时同步；
 * 2. 并发 `session/request_permission` 的 FIFO 互斥弹窗队列；
 * 3. `elicitation/create` 到 Pi 原生 `ctx.ui.select` / `ctx.ui.input` 的结构化表单映射。
 */
export class AgyTurnMirrorBroker {
	private readonly calls = new Map<string, TrackedMirrorCallState>();
	private fallbackUiContext?: ExtensionContext;
	private permissionMutex: Promise<void> = Promise.resolve();
	private emptyResultNote?: (context: EmptyResultContext) => string | undefined;

	/** Supplies a note for calls that agy finished without output (background tasks, timers). */
	setEmptyResultNote(note: ((context: EmptyResultContext) => string | undefined) | undefined): void {
		this.emptyResultNote = note;
	}

	setFallbackUiContext(ctx: ExtensionContext | undefined): void {
		this.fallbackUiContext = ctx;
	}

	/** Whether a mirror call with this id is registered and not yet collected. */
	isTracking(toolCallId: string): boolean {
		return this.calls.has(toolCallId);
	}

	registerOrUpdateCall(
		agySessionId: string,
		payload: {
			toolCallId: string;
			title?: string;
			kind?: AcpToolKind;
			status?: AcpToolStatus;
			rawInput?: unknown;
			rawOutput?: unknown;
			content?: AcpToolCallContentItem[];
			locations?: AcpToolCallLocation[];
		},
	): ClassifiedMirrorCall {
		const classified = classifyAgyToolCall(payload);
		let state = this.calls.get(payload.toolCallId);

		if (!state) {
			state = {
				toolCallId: payload.toolCallId,
				agySessionId,
				title: payload.title,
				kind: payload.kind,
				path: typeof classified.arguments.path === "string" ? classified.arguments.path : undefined,
				line: typeof classified.arguments.line === "number" ? classified.arguments.line : undefined,
				limit:
					typeof classified.arguments.limit === "number" ? classified.arguments.limit : undefined,
				command:
					typeof classified.arguments.command === "string"
						? classified.arguments.command
						: undefined,
				query:
					typeof classified.arguments.query === "string" ? classified.arguments.query : undefined,
				agentRole:
					typeof classified.arguments.agentRole === "string"
						? classified.arguments.agentRole
						: undefined,
				tool: typeof classified.arguments.tool === "string" ? classified.arguments.tool : undefined,
				status: payload.status ?? "pending",
				contentBlocks: [],
				diffs: [],
				completed: false,
				failed: false,
			};
			this.calls.set(payload.toolCallId, state);
		} else {
			if (payload.title) state.title = payload.title;
			if (payload.kind) state.kind = payload.kind;
			if (payload.status) state.status = payload.status;
			if (payload.locations?.[0]?.path) {
				state.path = normalizeMirrorFilePath(payload.locations[0].path);
			}
			if (typeof payload.locations?.[0]?.line === "number") state.line = payload.locations[0].line;
			if (typeof classified.arguments.path === "string" && !state.path) {
				state.path = classified.arguments.path;
			}
			if (typeof classified.arguments.line === "number" && state.line === undefined) {
				state.line = classified.arguments.line;
			}
			if (typeof classified.arguments.limit === "number" && state.limit === undefined) {
				state.limit = classified.arguments.limit;
			}
			if (typeof classified.arguments.command === "string") {
				state.command = classified.arguments.command;
			}
			if (typeof classified.arguments.query === "string") {
				state.query = classified.arguments.query;
			}
			if (typeof classified.arguments.agentRole === "string") {
				state.agentRole = classified.arguments.agentRole;
			}
			if (typeof classified.arguments.tool === "string") {
				state.tool = classified.arguments.tool;
			}
		}

		if (payload.content && payload.content.length > 0) {
			const merged = mergeContentItems(payload.content);
			if (merged.blocks.length > 0) {
				state.contentBlocks = merged.blocks;
			}
			if (merged.diffs.length > 0) {
				state.diffs = merged.diffs;
			}
		}

		const rawText = formatRawOutputFallback(payload.rawOutput);
		if (rawText) {
			state.rawOutputText = rawText;
		}

		const isTerminal = payload.status === "completed" || payload.status === "failed";
		if (isTerminal) {
			state.completed = true;
			state.failed = payload.status === "failed";
			if (state.resolveCompletion) {
				const resolver = state.resolveCompletion;
				state.resolveCompletion = undefined;
				resolver(this.buildToolResult(state));
			}
		} else if (state.onUpdate) {
			state.onUpdate(this.buildToolResult(state));
		}

		return classified;
	}

	/** 由镜像工具 `execute()` 调用，等待同一 `toolCallId` 到达终态并实时转发流式更新 */
	async executeMirrorCall(
		toolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<AgyMirrorToolDetails> | undefined,
		ctx: ExtensionContext,
		onUserAbortSession?: (agySessionId: string) => void,
	): Promise<AgentToolResult<AgyMirrorToolDetails>> {
		const state = this.calls.get(toolCallId);
		if (!state) {
			return {
				content: [{ type: "text", text: "(completed)" }],
				details: {},
			};
		}

		state.onUpdate = onUpdate;
		state.activeCtx = ctx;
		state.activeSignal = signal;

		// 若在 Pi 调度到 execute() 前该原生工具已极速执行完毕，直接返回结果并清理记录
		if (state.completed) {
			const finalRes = this.buildToolResult(state);
			this.calls.delete(toolCallId);
			if (state.failed) {
				const errMsg =
					finalRes.content.find((c): c is TextContent => c.type === "text")?.text ||
					"Tool execution failed";
				throw new Error(errMsg);
			}
			return finalRes;
		}

		if (state.contentBlocks.length > 0 || state.diffs.length > 0) {
			onUpdate?.(this.buildToolResult(state));
		}

		const result = await new Promise<AgentToolResult<AgyMirrorToolDetails>>((resolve, reject) => {
			if (signal?.aborted) {
				onUserAbortSession?.(state.agySessionId);
				reject(new Error("Tool execution aborted"));
				return;
			}

			const onAbort = () => {
				state.resolveCompletion = undefined;
				this.calls.delete(toolCallId);
				onUserAbortSession?.(state.agySessionId);
				reject(new Error("Tool execution aborted"));
			};

			signal?.addEventListener("abort", onAbort, { once: true });

			state.resolveCompletion = (res) => {
				signal?.removeEventListener("abort", onAbort);
				this.calls.delete(toolCallId);
				if (state.failed) {
					const errText =
						res.content.find((c): c is TextContent => c.type === "text")?.text ||
						"Tool execution failed";
					reject(new Error(errText));
				} else {
					resolve(res);
				}
			};
		});

		return result;
	}

	/**
	 * 隐式完结兜底：当 AGY 未发送 `completed` 即进入下一段思考/正文或结束 Turn 时，
	 * 自动结算该会话下所有挂起的镜像工具以防死锁。
	 */
	completePendingCallsImplicitly(agySessionId: string): void {
		for (const state of Array.from(this.calls.values())) {
			if (state.agySessionId !== agySessionId || state.completed) continue;
			state.completed = true;
			state.status = "completed";
			if (state.resolveCompletion) {
				const resolver = state.resolveCompletion;
				state.resolveCompletion = undefined;
				resolver(this.buildToolResult(state));
			}
		}
	}

	/** 会话异常终止或取消时清理残留状态 */
	abortSessionCalls(agySessionId: string, reason = "Cancelled"): void {
		for (const [id, state] of Array.from(this.calls.entries())) {
			if (state.agySessionId !== agySessionId) continue;
			state.completed = true;
			state.failed = true;
			if (state.resolveCompletion) {
				const resolver = state.resolveCompletion;
				state.resolveCompletion = undefined;
				resolver({
					content: [{ type: "text", text: reason }],
					details: { status: "failed" },
				});
			}
			this.calls.delete(id);
		}
	}

	/** FIFO 串行化处理来自 AGY 主代理或并行 Subagent 的权限确认弹窗 */
	handlePermissionRequest(
		params: AcpRequestPermissionParams,
	): Promise<AcpRequestPermissionResult> {
		const run = async (): Promise<AcpRequestPermissionResult> => {
			const callId = params.toolCall?.toolCallId;
			const callState = callId ? this.calls.get(callId) : undefined;
			const uiCtx = callState?.activeCtx ?? this.fallbackUiContext;
			const signal = callState?.activeSignal ?? uiCtx?.signal;

			if (!uiCtx || !uiCtx.hasUI || params.options.length === 0) {
				return { outcome: { outcome: "cancelled" } };
			}
			if (signal?.aborted) {
				return { outcome: { outcome: "cancelled" } };
			}

			const toolTitle =
				params.toolCall?.title || callState?.title || params.toolCall?.kind || "Antigravity Tool";
			const labels = params.options.map((opt) => opt.name || opt.optionId);
			const selectedLabel = await uiCtx.ui.select(
				`授权确认：${toolTitle}`,
				labels,
				{ signal },
			);

			if (!selectedLabel) {
				return { outcome: { outcome: "cancelled" } };
			}

			const idx = labels.indexOf(selectedLabel);
			const chosen = idx >= 0 ? params.options[idx] : params.options[0];
			return {
				outcome: {
					outcome: "selected",
					optionId: chosen.optionId,
				},
			};
		};

		const task = this.permissionMutex.then(run, run);
		this.permissionMutex = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	/** 处理 ACP `elicitation/create` 结构化提问请求 */
	async handleElicitationRequest(
		params: AcpElicitationCreateParams,
	): Promise<AcpElicitationCreateResult> {
		const uiCtx = this.fallbackUiContext;
		if (!uiCtx || !uiCtx.hasUI) {
			throw new Error("Interactive UI unavailable in current mode");
		}

		const signal = uiCtx.signal;
		if (params.mode === "url" && params.url) {
			const confirmed = await uiCtx.ui.confirm(
				params.message || "外部授权确认",
				`请确认是否已完成访问：${params.url}`,
				{ signal },
			);
			return { action: confirmed ? "accept" : "decline" };
		}

		const props = params.requestedSchema?.properties;
		if (!props || Object.keys(props).length === 0) {
			const answer = await uiCtx.ui.input(params.message || "请输入回复", undefined, { signal });
			if (answer === undefined) {
				return { action: "cancel" };
			}
			return {
				action: "accept",
				content: { response: answer },
			};
		}

		const content: Record<string, unknown> = {};
		for (const [key, propSchema] of Object.entries(props)) {
			const fieldTitle = propSchema.title || propSchema.description || key;
			const promptTitle = params.message ? `${params.message} — ${fieldTitle}` : fieldTitle;

			if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
				const displayChoices =
					Array.isArray(propSchema.enumNames) &&
					propSchema.enumNames.length === propSchema.enum.length
						? propSchema.enumNames
						: propSchema.enum;
				const picked = await uiCtx.ui.select(promptTitle, displayChoices, { signal });
				if (picked === undefined) {
					return { action: "cancel" };
				}
				const choiceIdx = displayChoices.indexOf(picked);
				content[key] = choiceIdx >= 0 ? propSchema.enum[choiceIdx] : picked;
				continue;
			}

			if (propSchema.type === "boolean") {
				const picked = await uiCtx.ui.select(promptTitle, ["是 (Yes)", "否 (No)"], { signal });
				if (picked === undefined) {
					return { action: "cancel" };
				}
				content[key] = picked.startsWith("是");
				continue;
			}

			const rawInput = await uiCtx.ui.input(
				promptTitle,
				propSchema.default !== undefined ? String(propSchema.default) : undefined,
				{ signal },
			);
			if (rawInput === undefined) {
				return { action: "cancel" };
			}

			if (propSchema.type === "number" || propSchema.type === "integer") {
				const num = Number(rawInput);
				content[key] = Number.isFinite(num) ? num : rawInput;
			} else {
				content[key] = rawInput;
			}
		}

		return {
			action: "accept",
			content,
		};
	}

	private buildToolResult(
		state: TrackedMirrorCallState,
	): AgentToolResult<AgyMirrorToolDetails> {
		let content = [...state.contentBlocks];
		if (content.length === 0 && state.rawOutputText) {
			content = [{ type: "text", text: state.rawOutputText }];
		}
		if (content.length === 0 && state.diffs.length > 0) {
			content = [
				{
					type: "text",
					text: state.diffs.map((d) => `Updated ${d.path}`).join("\n"),
				},
			];
		}
		if (content.length === 0 && state.completed && !state.failed && this.emptyResultNote) {
			let note: string | undefined;
			try {
				note = this.emptyResultNote({
					agySessionId: state.agySessionId,
					kind: state.kind,
					title: state.title,
					command: state.command,
					toolName: state.tool,
				});
			} catch {
				note = undefined;
			}
			if (note) content = [{ type: "text", text: note }];
		}

		return {
			content,
			details: {
				kind: state.kind,
				title: state.title,
				path: state.path,
				line: state.line,
				limit: state.limit,
				command: state.command,
				query: state.query,
				agentRole: state.agentRole,
				diffs: state.diffs.length > 0 ? state.diffs : undefined,
				status: state.status,
			},
		};
	}
}

/**
 * 构建全部 7 个模式 A 语义镜像工具定义。
 * 默认设为 `defaultActive: false` 且无 `promptSnippet`，仅在激活 `agy-tools` / `hybrid` 模式时动态启用。
 */
export function createAgyMirrorToolDefinitions(
	broker: AgyTurnMirrorBroker,
	onUserAbortSession?: (agySessionId: string) => void,
): ToolDefinition<typeof MirrorToolParamsSchema, AgyMirrorToolDetails>[] {
	const labels: Record<AgyMirrorToolName, string> = {
		agy_read: "Antigravity Read",
		agy_edit: "Antigravity Edit",
		agy_write: "Antigravity Write",
		agy_bash: "Antigravity Shell",
		agy_search: "Antigravity Search",
		agy_subagent: "Antigravity Subagent",
		agy_tool: "Antigravity Tool",
	};

	return AGY_MIRROR_TOOL_NAMES.map((toolName) => {
		const renderers = getMirrorToolRenderers(toolName);
		return defineTool({
			name: toolName,
			label: labels[toolName],
			description: `Mirrors native Antigravity tool execution (${toolName}).`,
			parameters: MirrorToolParamsSchema,
			defaultActive: false,
			executionMode: "parallel",
			renderShell: renderers.renderShell,
			renderCall: renderers.renderCall,
			renderResult: renderers.renderResult,
			async execute(toolCallId, _params, signal, onUpdate, ctx) {
				return broker.executeMirrorCall(
					toolCallId,
					signal,
					onUpdate,
					ctx,
					onUserAbortSession,
				);
			},
		});
	});
}
