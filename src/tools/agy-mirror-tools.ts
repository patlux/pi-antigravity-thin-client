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
import {
	type AcpElicitationCreateParams,
	type AcpElicitationCreateResult,
	type AcpElicitationPropertySchema,
	type AcpElicitationTitledOption,
	type AcpPermissionOption,
	type AcpRequestPermissionParams,
	type AcpRequestPermissionResult,
	type AcpToolCallContentItem,
	type AcpToolCallLocation,
	type AcpToolKind,
	type AcpToolStatus,
	isAntigravityUserInputRequest,
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
		prompt: Type.Optional(Type.String()),
		agentType: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		parentModel: Type.Optional(Type.String()),
		agentCount: Type.Optional(Type.Number()),
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

const MAX_STORED_TEXT_CHARS = 128 * 1024;
const MAX_STORED_DIFF_CHARS = 512 * 1024;
const TRUNCATED_OUTPUT_MARKER = "[Earlier output truncated]\n\n";
const SECURITY_WARNING_META_KEY = "agy.security.warning";
const WARNING_TEXT_LIMIT = 512;
const OPTION_LABEL_LIMIT = 512;
const QUESTION_TEXT_LIMIT = 8_000;
const APPROVAL_DETAIL_LIMIT = 160;
const APPROVAL_TITLE_LIMIT = 240;

/** Copies a sliced string so V8 does not retain the much larger backing string. */
function copyBoundedText(text: string): string {
	return Buffer.from(text, "utf16le").toString("utf16le");
}

/** Keeps the tail of long tool outputs and detaches from the original string. */
function boundTailText(text: string, limit: number): string {
	if (
		text.length <= limit ||
		(text.length <= limit + TRUNCATED_OUTPUT_MARKER.length &&
			text.startsWith(TRUNCATED_OUTPUT_MARKER))
	) {
		return text;
	}
	const tail = text.slice(-limit).replace(/^[\uDC00-\uDFFF]/u, "");
	return copyBoundedText(`${TRUNCATED_OUTPUT_MARKER}${tail}`);
}

/** Keeps the start of long labels, warnings, or titles without splitting surrogate pairs. */
function boundHeadText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const prefix = text.slice(0, Math.max(0, limit - 3)).replace(/[\uD800-\uDBFF]$/u, "");
	return copyBoundedText(`${prefix}...`);
}

function toSingleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

type NativeSwarmToolName = "swarm" | "post_message" | "read_board" | "swarm_wait";

const NATIVE_SWARM_TOOL_NAMES: ReadonlySet<string> = new Set<NativeSwarmToolName>([
	"swarm",
	"post_message",
	"read_board",
	"swarm_wait",
]);

function isNativeSwarmToolName(value: unknown): value is NativeSwarmToolName {
	return typeof value === "string" && NATIVE_SWARM_TOOL_NAMES.has(value);
}

const SWARM_TITLE_TO_TOOL: ReadonlyMap<string, NativeSwarmToolName> = new Map([
	["Running swarm", "swarm"],
	["Run swarm?", "swarm"],
	["Run swarm", "swarm"],
	["Running post_message", "post_message"],
	["Run post_message?", "post_message"],
	["Run post_message", "post_message"],
	["Running read_board", "read_board"],
	["Run read_board?", "read_board"],
	["Run read_board", "read_board"],
	["Running swarm_wait", "swarm_wait"],
	["Run swarm_wait?", "swarm_wait"],
	["Run swarm_wait", "swarm_wait"],
]);

const UPDATE_STEPS_TITLE_PATTERN = /^(?:run|running)\s+update_steps\??$/i;

function cleanHandle(value: unknown): string {
	return typeof value === "string" ? value.trim().replace(/^@/, "") : "";
}

function cleanChannel(value: unknown): string {
	return typeof value === "string" ? value.trim().replace(/^#/, "") : "";
}

function formatSwarmToolTitle(
	tool: NativeSwarmToolName,
	action: string | undefined,
	rawObj: Record<string, unknown> | undefined,
): string {
	switch (tool) {
		case "swarm": {
			const name = cleanHandle(rawObj?.name);
			switch (action?.toLowerCase()) {
				case "add": {
					const tasks = Array.isArray(rawObj?.tasks) ? rawObj.tasks.length : 0;
					const n =
						typeof rawObj?.n === "number" && Number.isFinite(rawObj.n)
							? Math.trunc(rawObj.n)
							: 0;
					const count = Math.max(tasks, n);
					if (count > 1 && name.length > 0) {
						return `Add ${count} swarm workers (@${name}-1..${count})`;
					}
					if (count > 1) return `Add ${count} swarm workers`;
					return name.length > 0 ? `Add swarm worker @${name}` : "Add swarm worker";
				}
				case "kill":
					return name.length > 0 ? `Stop swarm worker @${name}` : "Stop swarm worker";
				case "status":
					return "Check swarm status";
				case "models":
					return "List swarm models";
				case "model": {
					const model = typeof rawObj?.model === "string" ? rawObj.model.trim() : "";
					if (name.length > 0 && model.length > 0) {
						return `Switch @${name} model to ${model}`;
					}
					if (name.length > 0) return `Switch swarm model for @${name}`;
					if (model.length > 0) return `Switch swarm model to ${model}`;
					return "Switch swarm model";
				}
				case "title": {
					const swarmTitle = typeof rawObj?.title === "string" ? rawObj.title.trim() : "";
					return swarmTitle.length > 0 ? `Set swarm title "${swarmTitle}"` : "Set swarm title";
				}
				case "channel": {
					const op = typeof rawObj?.op === "string" ? rawObj.op.trim() : "";
					const channel = cleanChannel(rawObj?.channel);
					if (op.length > 0 && channel.length > 0) {
						return `Swarm channel ${op} #${channel}`;
					}
					return op.length > 0 ? `Swarm channel ${op}` : "Manage swarm channels";
				}
				case "join": {
					const swarmName = typeof rawObj?.swarm === "string" ? rawObj.swarm.trim() : "";
					return swarmName.length > 0 ? `Join swarm ${swarmName}` : "Join swarm";
				}
				default:
					return "Manage swarm";
			}
		}
		case "post_message": {
			const channel = cleanChannel(rawObj?.channel);
			return channel.length > 0 && channel !== "main"
				? `Post to #${channel}`
				: "Post to swarm board";
		}
		case "read_board": {
			if (rawObj?.status === true) return "Read swarm status";
			const channel = cleanChannel(rawObj?.channel);
			return channel.length > 0 && channel !== "main" && channel !== "*"
				? `Read #${channel}`
				: "Read swarm board";
		}
		case "swarm_wait":
			return "Wait for swarm board";
	}
}

function identifySwarmToolCall(
	title: string,
	kind: string,
	command: string | undefined,
	rawObj: Record<string, unknown> | undefined,
	meta: Record<string, unknown> | undefined,
): { tool: NativeSwarmToolName; title: string } | undefined {
	if (command !== undefined) return undefined;
	if (meta?.is_mcp_tool_call === true) return undefined;

	const antigravityMeta = asRecord(meta?.antigravity);
	const swarmMeta = asRecord(antigravityMeta?.swarm);
	const metaTool = isNativeSwarmToolName(swarmMeta?.tool) ? swarmMeta.tool : undefined;
	const legacyTool = SWARM_TITLE_TO_TOOL.get(title);
	const tool = metaTool ?? legacyTool;
	if (!tool) return undefined;

	if ((tool === "swarm" || tool === "post_message") && kind !== "" && kind !== "other") {
		return undefined;
	}
	if (tool === "read_board" && kind !== "" && kind !== "other" && kind !== "read") {
		return undefined;
	}
	if (tool === "swarm_wait" && kind !== "" && kind !== "other" && kind !== "think") {
		return undefined;
	}

	const metaAction =
		typeof swarmMeta?.action === "string" && swarmMeta.action.trim().length > 0
			? swarmMeta.action.trim()
			: undefined;
	const inputAction =
		typeof rawObj?.action === "string" && rawObj.action.trim().length > 0
			? rawObj.action.trim()
			: undefined;
	const action = metaAction ?? inputAction;

	const formattedTitle =
		legacyTool !== undefined || title.length === 0
			? formatSwarmToolTitle(tool, action, rawObj)
			: title;

	return {
		tool,
		title: boundHeadText(toSingleLine(formattedTitle), APPROVAL_TITLE_LIMIT),
	};
}

function formatUpdateStepsTitle(rawObj: Record<string, unknown> | undefined): string {
	const rawSteps = Array.isArray(rawObj?.steps) ? rawObj.steps : [];
	const steps = rawSteps
		.map((entry) => asRecord(entry))
		.filter((entry): entry is Record<string, unknown> => entry !== undefined);
	if (steps.length === 0) return "Update plan";

	let doneCount = 0;
	let activeTitle: string | undefined;
	for (const step of steps) {
		const status = typeof step.status === "string" ? step.status.toLowerCase() : "";
		if (status === "done" || status === "completed") {
			doneCount++;
		} else if (!activeTitle && (status === "in_progress" || status === "running")) {
			const candidate = pickFirstString(step, ["title", "content", "step"]);
			if (candidate) activeTitle = candidate;
		}
	}

	if (activeTitle) {
		return boundHeadText(
			`Update plan (${doneCount}/${steps.length}): ${toSingleLine(activeTitle)}`,
			APPROVAL_TITLE_LIMIT,
		);
	}
	if (doneCount > 0) {
		return `Update plan (${doneCount}/${steps.length} done)`;
	}
	return `Update plan (${steps.length} ${steps.length === 1 ? "step" : "steps"})`;
}

function identifyUpdateStepsCall(
	title: string,
	kind: string,
	command: string | undefined,
	rawObj: Record<string, unknown> | undefined,
	isMcp: boolean,
): string | undefined {
	if (isMcp || command !== undefined) return undefined;
	if (kind !== "" && kind !== "other") return undefined;
	if (!UPDATE_STEPS_TITLE_PATTERN.test(title)) return undefined;
	return formatUpdateStepsTitle(rawObj);
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
	_meta?: Record<string, unknown>;
}): ClassifiedMirrorCall {
	const rawObj = asRecord(input.rawInput);
	const metaObj = asRecord(input._meta);
	const isMcp = metaObj?.is_mcp_tool_call === true;
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

	const swarmCall = identifySwarmToolCall(title, kind, command, rawObj, metaObj);
	const updateStepsTitle =
		swarmCall === undefined
			? identifyUpdateStepsCall(title, kind, command, rawObj, isMcp)
			: undefined;

	let mirrorToolName: AgyMirrorToolName = "agy_tool";
	let displayTitle = title;
	// agy reports its own non-shell tools (schedule, manage_task, ...) as kind
	// "other" titled "Run <tool_name>"; they are not shell commands.
	const rawInternalTool =
		kind === "other" && command === undefined
			? /^run ([a-z][a-z0-9_]*)$/.exec(lowerTitle)?.[1]
			: undefined;
	const internalTool =
		isMcp && rawInternalTool && (isNativeSwarmToolName(rawInternalTool) || rawInternalTool === "update_steps")
			? undefined
			: rawInternalTool;

	let resolvedToolName: string | undefined;

	if (swarmCall) {
		mirrorToolName = "agy_tool";
		resolvedToolName = swarmCall.tool;
		displayTitle = swarmCall.title;
	} else if (updateStepsTitle !== undefined) {
		mirrorToolName = "agy_tool";
		resolvedToolName = "update_steps";
		displayTitle = updateStepsTitle;
	} else if (internalTool === "invoke_subagent") {
		mirrorToolName = "agy_subagent";
		resolvedToolName = internalTool;
	} else if (internalTool) {
		mirrorToolName = "agy_tool";
		resolvedToolName = internalTool;
	} else if (isMcp && kind === "other" && command === undefined) {
		mirrorToolName = "agy_tool";
	} else if (kind === "execute" || command !== undefined || lowerTitle.startsWith("run ")) {
		// Shell commands and explicit file/search tools may mention words such as
		// `workflow`, `subagent`, or `swarm`; classify them before subagent title heuristics.
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
	} else if (isExplicitSubagentTitle || agentRole !== undefined) {
		mirrorToolName = "agy_subagent";
	}

	const args: Record<string, string | number> = {};
	if (displayTitle) args.title = displayTitle;
	if (input.kind) args.kind = input.kind;
	if (filePath) args.path = filePath;
	if (typeof locLine === "number") args.line = locLine;
	if (mirrorToolName === "agy_read" && typeof lineLimit === "number") args.limit = lineLimit;
	if (command) args.command = command;
	if (query) args.query = query;
	if (agentRole) args.agentRole = agentRole;
	if (resolvedToolName) args.tool = resolvedToolName;
	if (resolvedToolName === "invoke_subagent") {
		Object.assign(args, subagentSpawnArguments(rawObj));
	}

	return {
		mirrorToolName,
		arguments: args,
	};
}

const MAX_SUBAGENT_PROMPT_CHARS = 4_000;

function displayArguments(args: JsonObject): Record<string, string | number> {
	const out: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string" || typeof value === "number") out[key] = value;
	}
	return out;
}

/**
 * What `invoke_subagent` starts: role, type, model and task of one subagent, or the
 * count and roles when one call starts several.
 */
function subagentSpawnArguments(rawObj: Record<string, unknown> | undefined): Record<string, string | number> {
	const out: Record<string, string | number> = {};
	if (!rawObj) return out;
	const typeName = pickFirstString(rawObj, ["TypeName", "typeName"]);
	const model = pickFirstString(rawObj, ["Model", "model"]);
	const prompt = pickFirstString(rawObj, ["Prompt", "prompt"]);
	if (typeName) out.agentType = typeName;
	if (model) out.model = model;
	if (prompt) {
		out.prompt =
			prompt.length > MAX_SUBAGENT_PROMPT_CHARS ? `${prompt.slice(0, MAX_SUBAGENT_PROMPT_CHARS - 1)}…` : prompt;
		return out;
	}
	// Batch form: an array of subagent specs.
	for (const value of Object.values(rawObj)) {
		if (!Array.isArray(value)) continue;
		const specs = value.map(asRecord).filter((spec) => spec !== undefined);
		if (specs.length === 0 || !specs.some((spec) => "Prompt" in spec || "Role" in spec)) continue;
		out.agentCount = specs.length;
		const roles = specs.map((spec) => pickFirstString(spec, ["Role", "TypeName"])).filter((role) => role !== undefined);
		if (roles.length > 0) out.agentRole = roles.join(", ");
		break;
	}
	return out;
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
	/** Classified display arguments, e.g. the task of a subagent. */
	args: Record<string, string | number>;
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
				blocks.push({
					type: "text",
					text: boundTailText(item.content.text, MAX_STORED_TEXT_CHARS),
				});
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
				oldText: boundTailText(item.oldText ?? "", MAX_STORED_DIFF_CHARS),
				newText: boundTailText(item.newText, MAX_STORED_DIFF_CHARS),
			});
		}
	}
	return { blocks, diffs };
}

function formatRawOutputFallback(rawOutput: unknown): string | undefined {
	if (rawOutput === undefined || rawOutput === null) return undefined;
	if (typeof rawOutput === "string") {
		return boundTailText(rawOutput, MAX_STORED_TEXT_CHARS);
	}
	try {
		const serialized = JSON.stringify(
			rawOutput,
			(_key, value: unknown) =>
				typeof value === "string" && value.length > MAX_STORED_TEXT_CHARS
					? boundTailText(value, MAX_STORED_TEXT_CHARS)
					: value,
			2,
		);
		return serialized === undefined
			? undefined
			: boundTailText(serialized, MAX_STORED_TEXT_CHARS);
	} catch {
		return boundTailText(String(rawOutput), MAX_STORED_TEXT_CHARS);
	}
}

function disambiguateLabels(
	entries: ReadonlyArray<{ baseLabel: string; disambiguator: string }>,
): string[] {
	const baseCounts = new Map<string, number>();
	for (const entry of entries) {
		baseCounts.set(entry.baseLabel, (baseCounts.get(entry.baseLabel) ?? 0) + 1);
	}
	const used = new Set<string>();
	for (const entry of entries) {
		if ((baseCounts.get(entry.baseLabel) ?? 0) === 1) {
			used.add(entry.baseLabel);
		}
	}
	const pairCounts = new Map<string, number>();
	for (const entry of entries) {
		if ((baseCounts.get(entry.baseLabel) ?? 0) > 1 && entry.disambiguator.length > 0) {
			const pairKey = `${entry.baseLabel}\u0000${entry.disambiguator}`;
			pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);
		}
	}
	return entries.map((entry, index) => {
		if ((baseCounts.get(entry.baseLabel) ?? 0) === 1) {
			return entry.baseLabel;
		}
		const pairKey = `${entry.baseLabel}\u0000${entry.disambiguator}`;
		let candidate =
			entry.disambiguator.length > 0 && pairCounts.get(pairKey) === 1
				? `${entry.baseLabel} (${entry.disambiguator})`
				: `${entry.baseLabel} (#${index + 1})`;
		if (used.has(candidate)) {
			let suffix = index + 1;
			candidate = `${entry.baseLabel} (#${suffix})`;
			while (used.has(candidate)) {
				suffix++;
				candidate = `${entry.baseLabel} (#${suffix})`;
			}
		}
		used.add(candidate);
		return candidate;
	});
}

function extractSecurityWarning(option: AcpPermissionOption): string | undefined {
	const meta = asRecord(option._meta);
	const warning = asRecord(meta?.[SECURITY_WARNING_META_KEY]);
	if (!warning) return undefined;
	const message = typeof warning.message === "string" ? toSingleLine(warning.message) : "";
	const title = typeof warning.title === "string" ? toSingleLine(warning.title) : "";
	const text = message || title;
	if (!text) return undefined;
	return boundHeadText(text, WARNING_TEXT_LIMIT);
}

const GENERIC_PLACEHOLDER_TITLES: ReadonlySet<string> = new Set([
	"antigravity tool",
	"tool",
	"other",
]);

const GENERIC_APPROVAL_TITLES: ReadonlySet<string> = new Set([
	...GENERIC_PLACEHOLDER_TITLES,
	"run command",
	"run command?",
	"running command",
	"execute command",
	"run run_command",
	"run run_command?",
	"running run_command",
	"edit file",
	"edit file?",
	"editing file",
	"run edit_file",
	"run edit_file?",
	"running edit_file",
	"write file",
	"write file?",
	"writing file",
	"write to file",
	"read file",
	"read file?",
	"reading file",
	"view file",
	"view file?",
	"delete file",
	"delete file?",
	"execute",
	"edit",
	"read",
	"write",
	"delete",
	"move",
	"search",
	"fetch",
]);

function normalizeGenericActionLabel(rawTitle: string): string {
	const cleaned = toSingleLine(rawTitle).replace(/\?+$/, "").trim();
	const lower = cleaned.toLowerCase();
	if (lower === "run run_command" || lower === "running run_command") {
		return "Run command";
	}
	if (lower === "run edit_file" || lower === "running edit_file") {
		return "Edit file";
	}
	return cleaned;
}

function buildApprovalPromptTitle(
	params: AcpRequestPermissionParams,
	callState: TrackedMirrorCallState | undefined,
): string {
	const explicitTitle = params.toolCall?.title ? toSingleLine(params.toolCall.title) : "";
	const trackedTitle = callState?.title ? toSingleLine(callState.title) : "";
	const kind = params.toolCall?.kind?.trim() || callState?.kind?.trim() || "";
	const lowerExplicit = explicitTitle.toLowerCase();
	const isExplicitGeneric = !explicitTitle || GENERIC_APPROVAL_TITLES.has(lowerExplicit);

	if (!isExplicitGeneric) {
		return boundHeadText(explicitTitle, APPROVAL_TITLE_LIMIT);
	}

	const rawInputObj = asRecord(params.toolCall?.rawInput);
	const rawCommand = pickFirstString(rawInputObj, [
		"CommandLine",
		"command",
		"command_line",
		"commandLine",
		"cmd",
	]);
	const command = callState?.command ?? rawCommand;
	const rawPath =
		normalizeMirrorFilePath(params.toolCall?.locations?.[0]?.path) ??
		normalizeMirrorFilePath(
			pickFirstString(rawInputObj, [
				"Path",
				"path",
				"TargetFile",
				"AbsolutePath",
				"absolute_path",
				"file_path",
				"uri",
			]),
		);
	const filePath = callState?.path ?? rawPath;

	const preferPath =
		kind.toLowerCase() === "edit" ||
		kind.toLowerCase() === "read" ||
		kind.toLowerCase() === "delete" ||
		kind.toLowerCase() === "move" ||
		lowerExplicit.includes("file");
	const detailRaw = preferPath ? (filePath ?? command) : (command ?? filePath);
	const detail = detailRaw ? boundHeadText(toSingleLine(detailRaw), APPROVAL_DETAIL_LIMIT) : "";

	if (detail) {
		if (!explicitTitle || GENERIC_PLACEHOLDER_TITLES.has(lowerExplicit)) {
			if (trackedTitle && !GENERIC_APPROVAL_TITLES.has(trackedTitle.toLowerCase())) {
				return boundHeadText(trackedTitle, APPROVAL_TITLE_LIMIT);
			}
			return boundHeadText(detail, APPROVAL_TITLE_LIMIT);
		}
		const actionLabel = normalizeGenericActionLabel(explicitTitle);
		return boundHeadText(`${actionLabel}: ${detail}`, APPROVAL_TITLE_LIMIT);
	}

	if (trackedTitle && !GENERIC_APPROVAL_TITLES.has(trackedTitle.toLowerCase())) {
		return boundHeadText(trackedTitle, APPROVAL_TITLE_LIMIT);
	}

	return boundHeadText(explicitTitle || trackedTitle || kind || "Antigravity Tool", APPROVAL_TITLE_LIMIT);
}

interface ElicitationChoiceOption {
	value: string;
	label: string;
}

const GENERIC_ELICITATION_COUNT_MESSAGE = /^(?:answer\s+)?\d+\s+questions?$/i;

function formatElicitationPromptTitle(
	message: string | undefined,
	key: string,
	propSchema: AcpElicitationPropertySchema,
): string {
	const msg = message?.trim() ?? "";
	const title = propSchema.title?.trim() ?? "";
	const description = propSchema.description?.trim() ?? "";
	const isCountMessage = msg.length > 0 && GENERIC_ELICITATION_COUNT_MESSAGE.test(msg);

	// agy's ask_question puts each question in property.title and a count like "2 questions" in params.message.
	if (title && !description) {
		if (!msg || isCountMessage || msg === title) {
			return title;
		}
		return `${msg} — ${title}`;
	}

	const fieldText =
		title && description && title !== description
			? `${title} — ${description}`
			: title || description || key;

	if (!msg || isCountMessage || msg === fieldText) {
		return fieldText;
	}
	return `${msg} — ${fieldText}`;
}

function extractTitledOptions(
	entries: readonly AcpElicitationTitledOption[] | undefined,
): ElicitationChoiceOption[] | undefined {
	if (!Array.isArray(entries) || entries.length === 0) return undefined;
	const rawOptions: Array<{ value: string; baseLabel: string; disambiguator: string }> = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || typeof entry.const !== "string") {
			return undefined;
		}
		const titleText = typeof entry.title === "string" ? toSingleLine(entry.title) : "";
		const descText = typeof entry.description === "string" ? toSingleLine(entry.description) : "";
		const valueText = toSingleLine(entry.const);
		const primary = titleText || valueText || JSON.stringify(entry.const);
		const fullLabel = descText && descText !== primary ? `${primary} — ${descText}` : primary;
		rawOptions.push({
			value: entry.const,
			baseLabel: boundHeadText(fullLabel, OPTION_LABEL_LIMIT),
			disambiguator: entry.const,
		});
	}
	const labels = disambiguateLabels(rawOptions);
	return rawOptions.map((opt, idx) => ({
		value: opt.value,
		label: labels[idx],
	}));
}

function extractEnumOptions(
	entries: readonly string[] | undefined,
	enumNames?: readonly string[],
): ElicitationChoiceOption[] | undefined {
	if (
		!Array.isArray(entries) ||
		entries.length === 0 ||
		!entries.every((value) => typeof value === "string")
	) {
		return undefined;
	}
	if (Array.isArray(enumNames) && enumNames.length === entries.length) {
		const rawOptions = entries.map((value, idx) => {
			const name = enumNames[idx];
			const baseLabel = name.length > 0 ? name : JSON.stringify(value);
			return { value, baseLabel, disambiguator: value };
		});
		const labels = disambiguateLabels(rawOptions);
		return rawOptions.map((opt, idx) => ({ value: opt.value, label: labels[idx] }));
	}

	const trimmedCounts = new Map<string, number>();
	for (const value of entries) {
		const trimmed = value.trim();
		trimmedCounts.set(trimmed, (trimmedCounts.get(trimmed) ?? 0) + 1);
	}
	const initial = entries.map((value) => {
		const trimmed = value.trim();
		const label = trimmed !== "" && trimmedCounts.get(trimmed) === 1 ? trimmed : JSON.stringify(value);
		return { value, label };
	});
	const uniqueLabels = new Set(initial.map((opt) => opt.label)).size === initial.length;
	const resolved = uniqueLabels
		? initial
		: initial.map((opt) => ({ value: opt.value, label: JSON.stringify(opt.value) }));
	const labels = disambiguateLabels(
		resolved.map((opt) => ({ baseLabel: opt.label, disambiguator: opt.value })),
	);
	return resolved.map((opt, idx) => ({ value: opt.value, label: labels[idx] }));
}

function extractSingleChoiceOptions(
	propSchema: AcpElicitationPropertySchema,
): ElicitationChoiceOption[] | undefined {
	if (propSchema.type === "array") return undefined;
	if (Array.isArray(propSchema.oneOf) && propSchema.oneOf.length > 0) {
		return extractTitledOptions(propSchema.oneOf);
	}
	if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
		return extractEnumOptions(propSchema.enum, propSchema.enumNames);
	}
	return undefined;
}

function extractMultiChoiceOptions(
	propSchema: AcpElicitationPropertySchema,
): ElicitationChoiceOption[] | undefined {
	if (propSchema.type !== "array" || !propSchema.items) return undefined;
	if (Array.isArray(propSchema.items.anyOf) && propSchema.items.anyOf.length > 0) {
		return extractTitledOptions(propSchema.items.anyOf);
	}
	if (Array.isArray(propSchema.items.enum) && propSchema.items.enum.length > 0) {
		return extractEnumOptions(propSchema.items.enum);
	}
	return undefined;
}

function isPlainTextField(propSchema: AcpElicitationPropertySchema): boolean {
	if (propSchema.type !== undefined && propSchema.type !== "string") return false;
	if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) return false;
	if (Array.isArray(propSchema.oneOf) && propSchema.oneOf.length > 0) return false;
	return true;
}

function uniqueMenuLabel(desired: string, existing: ReadonlySet<string>): string {
	if (!existing.has(desired)) return desired;
	let suffix = 2;
	let candidate = `${desired} (${suffix})`;
	while (existing.has(candidate)) {
		suffix++;
		candidate = `${desired} (${suffix})`;
	}
	return candidate;
}

function formatMultiSelectHint(minItems: number, maxItems: number): string {
	const hasMax = Number.isFinite(maxItems);
	if (minItems > 0 && hasMax) {
		return minItems === maxItems
			? ` (select ${minItems})`
			: ` (select ${minItems}-${maxItems})`;
	}
	if (minItems > 0) {
		return ` (select at least ${minItems})`;
	}
	if (hasMax) {
		return ` (select up to ${maxItems})`;
	}
	return "";
}

/** What a note for a mirror call without output may look at. */
export interface EmptyResultContext {
	agySessionId: string;
	kind?: string;
	title?: string;
	command?: string;
	/** agy-internal tool name such as `schedule`. */
	toolName?: string;
	/** Classified display arguments (role, task and model of a subagent, ...). */
	args: Record<string, string | number>;
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
	private uiDialogMutex: Promise<void> = Promise.resolve();
	private emptyResultNote?: (context: EmptyResultContext) => string | undefined;

	private enqueueUiDialog<T>(run: () => Promise<T>): Promise<T> {
		const task = this.uiDialogMutex.then(run, run);
		this.uiDialogMutex = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

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
			_meta?: Record<string, unknown>;
		},
	): ClassifiedMirrorCall {
		const classified = classifyAgyToolCall(payload);
		const classifiedArgs = displayArguments(classified.arguments);
		const resolvedTitle =
			typeof classifiedArgs.title === "string" ? classifiedArgs.title : payload.title;
		const isGenericFallbackTitle =
			(classifiedArgs.tool === "swarm" && resolvedTitle === "Manage swarm") ||
			(classifiedArgs.tool === "update_steps" && resolvedTitle === "Update plan");
		const isTerminal = payload.status === "completed" || payload.status === "failed";
		let state = this.calls.get(payload.toolCallId);
		const isStaleNonTerminal = Boolean(state?.completed && !isTerminal);

		if (!state) {
			state = {
				toolCallId: payload.toolCallId,
				agySessionId,
				title: resolvedTitle,
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
				args: classifiedArgs,
				status: payload.status ?? "pending",
				contentBlocks: [],
				diffs: [],
				completed: false,
				failed: false,
			};
			this.calls.set(payload.toolCallId, state);
		} else {
			const preserveRichTitle = Boolean(
				isGenericFallbackTitle && state.title && payload.rawInput === undefined,
			);
			if (resolvedTitle && (!isStaleNonTerminal || !state.title) && !preserveRichTitle) {
				state.title = resolvedTitle;
			}
			if (payload.kind && (!isStaleNonTerminal || !state.kind)) state.kind = payload.kind;
			if (payload.status && !isStaleNonTerminal) state.status = payload.status;
			if (payload.locations?.[0]?.path && (!isStaleNonTerminal || !state.path)) {
				state.path = normalizeMirrorFilePath(payload.locations[0].path);
			}
			if (
				typeof payload.locations?.[0]?.line === "number" &&
				(!isStaleNonTerminal || state.line === undefined)
			) {
				state.line = payload.locations[0].line;
			}
			if (typeof classified.arguments.path === "string" && !state.path) {
				state.path = classified.arguments.path;
			}
			if (typeof classified.arguments.line === "number" && state.line === undefined) {
				state.line = classified.arguments.line;
			}
			if (typeof classified.arguments.limit === "number" && state.limit === undefined) {
				state.limit = classified.arguments.limit;
			}
			if (typeof classified.arguments.command === "string" && (!isStaleNonTerminal || !state.command)) {
				state.command = classified.arguments.command;
			}
			if (typeof classified.arguments.query === "string" && (!isStaleNonTerminal || !state.query)) {
				state.query = classified.arguments.query;
			}
			if (typeof classified.arguments.agentRole === "string" && (!isStaleNonTerminal || !state.agentRole)) {
				state.agentRole = classified.arguments.agentRole;
			}
			if (typeof classified.arguments.tool === "string" && (!isStaleNonTerminal || !state.tool)) {
				state.tool = classified.arguments.tool;
			}
			const nextArgs = isStaleNonTerminal
				? { ...classifiedArgs, ...state.args }
				: { ...state.args, ...classifiedArgs };
			if (preserveRichTitle && state.title) {
				nextArgs.title = state.title;
			}
			state.args = nextArgs;
		}

		if (payload.content && payload.content.length > 0) {
			const merged = mergeContentItems(payload.content);
			if (merged.blocks.length > 0 && (!isStaleNonTerminal || state.contentBlocks.length === 0)) {
				state.contentBlocks = merged.blocks;
			}
			if (merged.diffs.length > 0 && (!isStaleNonTerminal || state.diffs.length === 0)) {
				state.diffs = merged.diffs;
			}
		}

		const rawText = formatRawOutputFallback(payload.rawOutput);
		if (rawText && (!isStaleNonTerminal || !state.rawOutputText)) {
			state.rawOutputText = rawText;
		}

		if (isTerminal) {
			state.completed = true;
			state.failed = payload.status === "failed";
			if (state.resolveCompletion) {
				const resolver = state.resolveCompletion;
				state.resolveCompletion = undefined;
				resolver(this.buildToolResult(state));
			}
		} else if (state.onUpdate && !state.completed) {
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
		return this.enqueueUiDialog(async (): Promise<AcpRequestPermissionResult> => {
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

			const isUserInput = isAntigravityUserInputRequest(params);
			const promptTitle = isUserInput
				? boundHeadText(
						params.toolCall?.title?.trim() || "Choose an option",
						QUESTION_TEXT_LIMIT,
					)
				: `Approve: ${buildApprovalPromptTitle(params, callState)}`;

			const optionEntries = params.options.map((opt) => {
				const rawLabel = opt.name?.trim() || opt.optionId;
				const boundedBase = boundHeadText(rawLabel, OPTION_LABEL_LIMIT);
				const warning = isUserInput ? undefined : extractSecurityWarning(opt);
				const baseLabel = warning ? `${boundedBase} — Warning: ${warning}` : boundedBase;
				return {
					baseLabel,
					disambiguator: opt.optionId?.trim() ?? "",
				};
			});
			const labels = disambiguateLabels(optionEntries);
			const optionByLabel = new Map<string, AcpPermissionOption>();
			for (let i = 0; i < params.options.length; i++) {
				optionByLabel.set(labels[i], params.options[i]);
			}

			const selectedLabel = await uiCtx.ui.select(promptTitle, labels, { signal });
			if (!selectedLabel) {
				return { outcome: { outcome: "cancelled" } };
			}

			const chosen = optionByLabel.get(selectedLabel);
			if (!chosen) return { outcome: { outcome: "cancelled" } };
			return {
				outcome: {
					outcome: "selected",
					optionId: chosen.optionId,
				},
			};
		});
	}

	/** 处理 ACP `elicitation/create` 结构化提问请求（与权限弹窗共用 FIFO 互斥锁） */
	handleElicitationRequest(
		params: AcpElicitationCreateParams,
	): Promise<AcpElicitationCreateResult> {
		return this.enqueueUiDialog(async (): Promise<AcpElicitationCreateResult> => {
			const uiCtx = this.fallbackUiContext;
			if (!uiCtx || !uiCtx.hasUI) {
				throw new Error("Interactive UI unavailable in current mode");
			}

			const signal = uiCtx.signal;
			if (signal?.aborted) {
				return { action: "cancel" };
			}
			if (params.mode === "url" && params.url) {
				const confirmed = await uiCtx.ui.confirm(
					params.message || "Confirm external authorization",
					`Confirm once you have completed this step: ${params.url}`,
					{ signal },
				);
				return { action: confirmed ? "accept" : "decline" };
			}

			const props = params.requestedSchema?.properties;
			if (!props || Object.keys(props).length === 0) {
				const answer = await uiCtx.ui.input(params.message || "Your answer", undefined, { signal });
				if (answer === undefined) {
					return { action: "cancel" };
				}
				return {
					action: "accept",
					content: { response: answer },
				};
			}

			const required = new Set(
				Array.isArray(params.requestedSchema?.required)
					? params.requestedSchema.required.filter((key) => typeof key === "string")
					: [],
			);

			// Pair optional single-choice `<id>` fields with optional `<id>__other` / `<id>_other` string fields.
			const companions = new Map<string, string>();
			const propEntries = Object.entries(props);
			for (const [key, propSchema] of propEntries) {
				if (required.has(key)) continue;
				if (!extractSingleChoiceOptions(propSchema)) continue;
				const companionId = [`${key}__other`, `${key}_other`].find((candidate) => {
					if (!Object.hasOwn(props, candidate) || required.has(candidate)) return false;
					return isPlainTextField(props[candidate]);
				});
				if (companionId !== undefined) {
					companions.set(key, companionId);
				}
			}
			const foldedCompanions = new Set(companions.values());
			const visibleEntries = propEntries.filter(([key]) => !foldedCompanions.has(key));
			const isSingleFieldForm = visibleEntries.length === 1;

			const contentEntries: Array<[string, unknown]> = [];
			for (const [key, propSchema] of visibleEntries) {
				const isRequired = required.has(key);
				const promptTitle = formatElicitationPromptTitle(params.message, key, propSchema);

				const multiOptions = extractMultiChoiceOptions(propSchema);
				if (multiOptions) {
					const minItems =
						typeof propSchema.minItems === "number" &&
						Number.isFinite(propSchema.minItems) &&
						propSchema.minItems > 0
							? Math.trunc(propSchema.minItems)
							: 0;
					const maxItems =
						typeof propSchema.maxItems === "number" &&
						Number.isFinite(propSchema.maxItems) &&
						propSchema.maxItems >= 0
							? Math.trunc(propSchema.maxItems)
							: Infinity;

					if (maxItems === 0 || minItems > maxItems || minItems > multiOptions.length) {
						if (isRequired) return { action: "cancel" };
						continue;
					}

					const selected = new Set<number>();
					if (Array.isArray(propSchema.default)) {
						for (const item of propSchema.default) {
							if (typeof item !== "string" || selected.size >= maxItems) continue;
							const idx = multiOptions.findIndex((opt) => opt.value === item);
							if (idx >= 0) selected.add(idx);
						}
					}

					const canSkip = !isRequired || minItems === 0;
					const loopTitle = `${promptTitle}${formatMultiSelectHint(minItems, maxItems)}`;
					let cancelledForm = false;

					while (true) {
						type MultiSelectAction =
							| { kind: "toggle"; index: number }
							| { kind: "done" }
							| { kind: "skip" };
						const actionByLabel = new Map<string, MultiSelectAction>();
						const menuLabels: string[] = [];

						for (let idx = 0; idx < multiOptions.length; idx++) {
							const itemLabel = `${selected.has(idx) ? "[x]" : "[ ]"} ${multiOptions[idx].label}`;
							menuLabels.push(itemLabel);
							actionByLabel.set(itemLabel, { kind: "toggle", index: idx });
						}

						const doneLabel = `Done (${selected.size} selected)`;
						menuLabels.push(doneLabel);
						actionByLabel.set(doneLabel, { kind: "done" });

						if (canSkip) {
							menuLabels.push("Skip");
							actionByLabel.set("Skip", { kind: "skip" });
						}

						const picked = await uiCtx.ui.select(loopTitle, menuLabels, { signal });
						if (picked === undefined) {
							if (signal?.aborted || isRequired || isSingleFieldForm) {
								cancelledForm = true;
							}
							break;
						}

						const action = actionByLabel.get(picked);
						if (!action) {
							if (isRequired || isSingleFieldForm) {
								cancelledForm = true;
							}
							break;
						}

						if (action.kind === "skip") {
							if (isRequired && minItems === 0) {
								contentEntries.push([key, []]);
							}
							break;
						}

						if (action.kind === "done") {
							if (selected.size < minItems) {
								uiCtx.ui.notify?.(
									`Select at least ${minItems} ${minItems === 1 ? "option" : "options"}.`,
									"warning",
								);
								continue;
							}
							const values = multiOptions
								.filter((_, idx) => selected.has(idx))
								.map((opt) => opt.value);
							contentEntries.push([key, values]);
							break;
						}

						if (selected.has(action.index)) {
							selected.delete(action.index);
						} else if (selected.size >= maxItems) {
							uiCtx.ui.notify?.(
								`Select at most ${maxItems} ${maxItems === 1 ? "option" : "options"}.`,
								"warning",
							);
						} else {
							selected.add(action.index);
						}
					}

					if (cancelledForm) {
						return { action: "cancel" };
					}
					continue;
				}

				const singleOptions = extractSingleChoiceOptions(propSchema);
				if (singleOptions) {
					const companionId = companions.get(key);
					const optionByLabel = new Map<string, ElicitationChoiceOption>();
					const displayChoices: string[] = [];
					const usedLabels = new Set<string>();
					for (const opt of singleOptions) {
						displayChoices.push(opt.label);
						optionByLabel.set(opt.label, opt);
						usedLabels.add(opt.label);
					}

					let otherLabel: string | undefined;
					if (companionId !== undefined) {
						otherLabel = uniqueMenuLabel("Other (enter custom text)", usedLabels);
						displayChoices.push(otherLabel);
						usedLabels.add(otherLabel);
					}

					let skipLabel: string | undefined;
					if (!isRequired) {
						skipLabel = uniqueMenuLabel("(Skip)", usedLabels);
						displayChoices.push(skipLabel);
						usedLabels.add(skipLabel);
					}

					const picked = await uiCtx.ui.select(promptTitle, displayChoices, { signal });
					if (picked === undefined) {
						if (signal?.aborted || isRequired || isSingleFieldForm) {
							return { action: "cancel" };
						}
						continue;
					}

					if (skipLabel !== undefined && picked === skipLabel) {
						continue;
					}

					if (companionId !== undefined && otherLabel !== undefined && picked === otherLabel) {
						const companionSchema = props[companionId];
						const companionHeading = companionSchema?.title?.trim() || "Other";
						const otherPrompt = `${promptTitle} — ${companionHeading}`;
						const customValue = await uiCtx.ui.input(
							otherPrompt,
							companionSchema?.default !== undefined ? String(companionSchema.default) : undefined,
							{ signal },
						);
						if (customValue === undefined) {
							if (signal?.aborted || isSingleFieldForm) {
								return { action: "cancel" };
							}
							continue;
						}
						if (customValue.trim().length > 0) {
							contentEntries.push([companionId, customValue]);
						}
						continue;
					}

					const matched = optionByLabel.get(picked);
					contentEntries.push([key, matched ? matched.value : picked]);
					continue;
				}

				if (propSchema.type === "boolean") {
					const boolChoices = isRequired ? ["Yes", "No"] : ["Yes", "No", "(Skip)"];
					const picked = await uiCtx.ui.select(promptTitle, boolChoices, { signal });
					if (picked === undefined) {
						if (signal?.aborted || isRequired || isSingleFieldForm) {
							return { action: "cancel" };
						}
						continue;
					}
					if (!isRequired && picked === "(Skip)") {
						continue;
					}
					contentEntries.push([key, picked === "Yes"]);
					continue;
				}

				const rawInput = await uiCtx.ui.input(
					promptTitle,
					propSchema.default !== undefined ? String(propSchema.default) : undefined,
					{ signal },
				);
				if (rawInput === undefined) {
					if (signal?.aborted || isRequired || isSingleFieldForm) {
						return { action: "cancel" };
					}
					continue;
				}

				if (propSchema.type === "number" || propSchema.type === "integer") {
					const trimmed = rawInput.trim();
					if (trimmed.length === 0) {
						if (!isRequired) continue;
						return { action: "cancel" };
					}
					const num = Number(trimmed);
					const validNumber =
						propSchema.type === "integer" ? Number.isInteger(num) : Number.isFinite(num);
					contentEntries.push([key, validNumber ? num : rawInput]);
				} else {
					if (!isRequired && rawInput.trim().length === 0) {
						continue;
					}
					contentEntries.push([key, rawInput]);
				}
			}

			return {
				action: "accept",
				content: Object.fromEntries(contentEntries),
			};
		});
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
					args: state.args,
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
