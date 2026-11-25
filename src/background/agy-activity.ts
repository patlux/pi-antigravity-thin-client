/**
 * Reads what Antigravity does between Pi turns from agy's own local files.
 *
 * agy runs long commands and `schedule` timers as background tasks. When one ends,
 * agy gets a message and starts a turn by itself, without a prompt from the client.
 * ACP clients see nothing of that turn, so the bridge reads agy's per-conversation
 * files below `<app data>/brain/<conversation>/.system_generated/`:
 * `logs/transcript.jsonl` (one JSON object per step), `messages/*.json` (task
 * results) and `tasks/task-N.log` (live output). The format is agy-internal; every
 * parser here is defensive and returns nothing it cannot read.
 *
 * Reading these files sends nothing to agy or Google.
 */

export interface TranscriptToolCall {
	name: string;
	/** agy stores each argument as a JSON-encoded string; decoded where possible. */
	args: Record<string, string>;
}

export interface TranscriptStep {
	index: number;
	createdAtMs?: number;
	source: string;
	type: string;
	status: string;
	content: string;
	toolCalls: TranscriptToolCall[];
	/** Model that produced a `PLANNER_RESPONSE`, e.g. `gemini-4-neon-high`. */
	model?: string;
}

export interface TaskMessage {
	id: string;
	/** Full sender: `<conversation>/task-N` for a task, a conversation id for an agent. */
	senderId: string;
	/** `task-N` when a background task sent it; undefined for subagents and other agents. */
	taskId?: string;
	title?: string;
	content: string;
	timestampMs?: number;
	toolCallId?: string;
	/** False for progress notes such as "still running after 600s". */
	terminal: boolean;
}

export type TaskOutcome = "ok" | "failed" | "canceled" | "expired";
/** `running`: a progress note about a task that has not ended. */
export type TriggerOutcome = TaskOutcome | "running";

export interface BackgroundTask {
	/** `task-N`; N is the transcript step that went to the background. */
	taskId: string;
	stepIndex: number;
	kind: "command" | "timer";
	/** Command line, or the timer prompt. */
	description: string;
	/** agy's short label for the command (`toolSummary`), when known. */
	summary?: string;
	timerSeconds?: number;
	startedAtMs?: number;
	finished?: {
		outcome: TaskOutcome;
		title?: string;
		exitCode?: number;
		atMs?: number;
	};
}

export interface AutonomousTrigger {
	taskId?: string;
	/** Conversation id of the agent (e.g. a subagent) whose message woke agy up. */
	agentId?: string;
	/** First line of that agent's message. */
	preview?: string;
	title?: string;
	outcome?: TriggerOutcome;
	exitCode?: number;
	kind?: BackgroundTask["kind"];
}

export interface AutonomousAction {
	name: string;
	summary: string;
}

export interface AutonomousTurn {
	/** Transcript step of the message that woke agy up. */
	startStep: number;
	/** Model agy answered with in this turn, e.g. `gemini-4-neon-high`. */
	model?: string;
	endStep?: number;
	startedAtMs?: number;
	endedAtMs?: number;
	/** `running` until agy answers without tool calls; `interrupted` when a prompt arrived first. */
	state: "running" | "done" | "interrupted";
	triggers: AutonomousTrigger[];
	actions: AutonomousAction[];
	/** agy's text answers in this turn, in order. */
	texts: string[];
}

export interface AgyActivity {
	tasks: BackgroundTask[];
	turns: AutonomousTurn[];
	/** Highest step index of a prompt sent by the client, or -1. */
	lastUserInputStep: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseTimeMs(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

function decodeArgument(raw: unknown): string | undefined {
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	if (typeof raw !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "string") return parsed;
		if (typeof parsed === "number" || typeof parsed === "boolean") return String(parsed);
		return raw;
	} catch {
		return raw;
	}
}

/** Parses one line of `transcript.jsonl`; undefined for anything unexpected. */
export function parseTranscriptLine(line: string): TranscriptStep | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	const obj = asRecord(parsed);
	if (!obj || typeof obj.step_index !== "number" || !Number.isSafeInteger(obj.step_index)) {
		return undefined;
	}
	const toolCalls: TranscriptToolCall[] = [];
	if (Array.isArray(obj.tool_calls)) {
		for (const rawCall of obj.tool_calls) {
			const call = asRecord(rawCall);
			const name = asString(call?.name);
			if (!call || !name) continue;
			const args: Record<string, string> = {};
			const rawArgs = asRecord(call.args);
			if (rawArgs) {
				for (const [key, value] of Object.entries(rawArgs)) {
					const decoded = decodeArgument(value);
					if (decoded !== undefined) args[key] = decoded;
				}
			}
			toolCalls.push({ name, args });
		}
	}
	return {
		index: obj.step_index,
		createdAtMs: parseTimeMs(obj.created_at),
		source: asString(obj.source) ?? "",
		type: asString(obj.type) ?? "",
		status: asString(obj.status) ?? "",
		content: typeof obj.content === "string" ? obj.content : "",
		toolCalls,
		model: asString(obj.model),
	};
}

/** Last path segment of a task id such as `<conversation>/task-12`. */
function shortTaskId(fullId: string): string | undefined {
	const match = /(task-\d+)$/.exec(fullId.trim());
	return match?.[1];
}

/** Parses one `messages/<uuid>.json` file of a conversation. */
export function parseTaskMessage(json: string): TaskMessage | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}
	const obj = asRecord(parsed);
	const id = asString(obj?.id);
	const sender = asString(obj?.sender)?.trim();
	if (!obj || !id || !sender) return undefined;
	const taskId = shortTaskId(sender);
	const toolCall = asRecord(asRecord(asRecord(obj.sourceMetadata)?.tool)?.toolCall);
	const title = asString(asRecord(obj.renderDetails)?.messageTitle);
	const content = asString(obj.content) ?? "";
	return {
		id,
		senderId: sender,
		taskId,
		title,
		content,
		timestampMs: parseTimeMs(obj.timestamp),
		toolCallId: asString(toolCall?.id),
		terminal: isTerminalNote(title, content),
	};
}

const TERMINAL_CONTENT_PATTERN = /^Task id "[^"]*" (?:finished|was cancell?ed)/;
const TERMINAL_TITLE_PATTERN = /(?:finished|was cancell?ed|timer has expired)\s*$/i;

/** Whether a task note reports the end of the task rather than progress. */
export function isTerminalNote(title: string | undefined, content: string): boolean {
	return TERMINAL_CONTENT_PATTERN.test(content.trim()) || TERMINAL_TITLE_PATTERN.test(title ?? "");
}

const BACKGROUND_TASK_PATTERN = /background task with task id:\s*(\S+)/;
const TASK_DESCRIPTION_PATTERN = /Task Description:\s*([\s\S]*?)(?:\n\s*Task logs are available at:|$)/;
const TIMER_PATTERN = /^Timer:\s*(\d+)\s*s(?:,\s*Prompt:\s*([\s\S]*))?$/;
const EXIT_CODE_PATTERN = /Command exited with code (-?\d+)/;
const MESSAGE_HEADER_PATTERN = /\[Message\][^\n]*?\btimestamp=(\S+)[^\n]*?\bsender=(\S+)[^\n]*?\bcontent=([\s\S]*?)(?:\n<\/SYSTEM_MESSAGE>|$)/;
const MESSAGE_SENDER_PATTERN = /\[Message\][^\n]*?\bsender=(\S+)/;

function outcomeOf(title: string | undefined, content: string, kind: BackgroundTask["kind"] | undefined) {
	const exitMatch = EXIT_CODE_PATTERN.exec(content);
	const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : undefined;
	let outcome: TaskOutcome;
	if (/was cancell?ed/i.test(title ?? "") || /was cancell?ed/i.test(content)) {
		outcome = "canceled";
	} else if (kind === "timer" || /timer has expired/i.test(title ?? "")) {
		outcome = "expired";
	} else if (exitCode !== undefined && exitCode !== 0) {
		outcome = "failed";
	} else {
		outcome = "ok";
	}
	return { outcome, exitCode };
}

/** First non-empty line as plain text: Markdown links keep their label, code marks go. */
/**
 * Text for one terminal row: line breaks, tabs and the spaces around them become one
 * space. agy's titles and command lines can span several lines.
 */
export function singleLine(text: string): string {
	return text.replace(/\s*[\r\n\t\f\v\u2028\u2029]\s*/g, " ");
}

export function firstLine(text: string, max = 160): string | undefined {
	const line = text
		.split("\n")
		.map((part) =>
			part
				.replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
				.replace(/`/g, "")
				.trim(),
		)
		.find((part) => part.length > 0);
	if (!line) return undefined;
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function summarizeAction(call: TranscriptToolCall): AutonomousAction {
	const args = call.args;
	const summary =
		args.toolSummary ??
		args.CommandLine ??
		args.Path ??
		args.AbsolutePath ??
		args.TargetFile ??
		args.Query ??
		(args.DurationSeconds ? `${args.DurationSeconds} s` : undefined) ??
		(args.TaskId && args.Action ? `${args.Action} ${shortTaskId(args.TaskId) ?? args.TaskId}` : undefined) ??
		"";
	return { name: call.name, summary: summary.replace(/\s+/g, " ").trim() };
}

function isMessageDelivery(step: TranscriptStep): boolean {
	return step.type === "SYSTEM_MESSAGE" && step.content.includes("[Message]");
}

/**
 * Derives background tasks and the turns agy took on its own.
 *
 * A turn ends with a model response without tool calls. A message delivered after
 * such an end starts an autonomous turn; a prompt from the client (`USER_INPUT`)
 * interrupts it. Messages delivered inside a running turn only add triggers.
 */
export function deriveAgyActivity(
	steps: readonly TranscriptStep[],
	messages: readonly TaskMessage[],
): AgyActivity {
	const ordered = [...steps].sort((a, b) => a.index - b.index);
	// Notes per task in time order; the first terminal one ends the task.
	const notesByTask = new Map<string, TaskMessage[]>();
	const notesBySender = new Map<string, TaskMessage[]>();
	const addNote = (map: Map<string, TaskMessage[]>, key: string, message: TaskMessage) => {
		const notes = map.get(key) ?? [];
		notes.push(message);
		map.set(key, notes);
	};
	for (const message of messages) {
		if (message.taskId) addNote(notesByTask, message.taskId, message);
		addNote(notesBySender, message.senderId, message);
	}
	for (const notes of [...notesByTask.values(), ...notesBySender.values()]) {
		notes.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
	}
	const endOf = (taskId: string) => notesByTask.get(taskId)?.find((note) => note.terminal);
	/** The note delivered in a transcript step: same sender, same second. */
	const noteAt = (senderId: string, atMs: number | undefined) =>
		atMs === undefined
			? undefined
			: notesBySender
					.get(senderId)
					?.find((note) => note.timestampMs !== undefined && Math.abs(note.timestampMs - atMs) < 1_000);

	const tasks: BackgroundTask[] = [];
	const taskKinds = new Map<string, BackgroundTask["kind"]>();
	let lastPlannerCalls: TranscriptToolCall[] = [];
	for (const step of ordered) {
		if (step.type === "PLANNER_RESPONSE") {
			lastPlannerCalls = step.toolCalls;
			continue;
		}
		if (step.status !== "RUNNING") continue;
		const idMatch = BACKGROUND_TASK_PATTERN.exec(step.content);
		const taskId = idMatch ? shortTaskId(idMatch[1]) : undefined;
		if (!taskId) continue;
		const description = (TASK_DESCRIPTION_PATTERN.exec(step.content)?.[1] ?? "").trim();
		const timer = TIMER_PATTERN.exec(description);
		const kind: BackgroundTask["kind"] = timer ? "timer" : "command";
		const summary = lastPlannerCalls.find(
			(call) => call.name === "run_command" && call.args.CommandLine?.trim() === description,
		)?.args.toolSummary;
		const task: BackgroundTask = {
			taskId,
			stepIndex: step.index,
			kind,
			description: timer ? (timer[2] ?? "").trim() : description,
			summary,
			timerSeconds: timer ? Number.parseInt(timer[1], 10) : undefined,
			startedAtMs: step.createdAtMs,
		};
		const end = endOf(taskId);
		if (end) {
			const { outcome, exitCode } = outcomeOf(end.title, end.content, kind);
			task.finished = { outcome, title: end.title, exitCode, atMs: end.timestampMs };
		}
		taskKinds.set(taskId, kind);
		tasks.push(task);
	}

	const turns: AutonomousTurn[] = [];
	let lastUserInputStep = -1;
	let inTurn = false;
	let current: AutonomousTurn | undefined;
	const closeCurrent = (state: AutonomousTurn["state"], endStep: number, endedAtMs?: number) => {
		if (!current) return;
		current.state = state;
		current.endStep = endStep;
		current.endedAtMs = endedAtMs;
		if (current.texts.length > 0 || current.actions.length > 0 || state === "done") {
			turns.push(current);
		}
		current = undefined;
	};

	for (const step of ordered) {
		if (step.type === "USER_INPUT") {
			lastUserInputStep = step.index;
			closeCurrent("interrupted", step.index - 1, step.createdAtMs);
			inTurn = true;
			continue;
		}
		if (isMessageDelivery(step)) {
			const header = MESSAGE_HEADER_PATTERN.exec(step.content);
			const sender = header?.[2] ?? MESSAGE_SENDER_PATTERN.exec(step.content)?.[1];
			const taskId = sender ? shortTaskId(sender) : undefined;
			const kind = taskId ? taskKinds.get(taskId) : undefined;
			const deliveredContent = (header?.[3] ?? "").trim();
			const note = sender ? noteAt(sender, parseTimeMs(header?.[1])) : undefined;
			const title = note?.title;
			let trigger: AutonomousTrigger;
			if (taskId) {
				const content = note?.content ?? deliveredContent;
				const terminal = note ? note.terminal : isTerminalNote(undefined, content) || kind === "timer";
				const result = terminal ? outcomeOf(title, content, kind) : undefined;
				trigger = {
					taskId,
					title,
					outcome: terminal ? result?.outcome : "running",
					exitCode: result?.exitCode,
					kind,
				};
			} else {
				// A subagent (or another agent) sent agy a message.
				const preview = firstLine(note?.content ?? deliveredContent);
				trigger = { agentId: sender, title, ...(preview ? { preview } : {}) };
			}
			if (current) {
				current.triggers.push(trigger);
			} else if (!inTurn) {
				current = {
					startStep: step.index,
					startedAtMs: step.createdAtMs,
					state: "running",
					triggers: [trigger],
					actions: [],
					texts: [],
				};
				inTurn = true;
			}
			continue;
		}
		if (step.type !== "PLANNER_RESPONSE") continue;
		const text = step.content.trim();
		if (current) {
			if (step.model) current.model = step.model;
			if (text) current.texts.push(text);
			current.actions.push(...step.toolCalls.map(summarizeAction));
		}
		if (step.toolCalls.length === 0) {
			closeCurrent("done", step.index, step.createdAtMs);
			inTurn = false;
		}
	}
	if (current) {
		turns.push(current);
	}

	return { tasks, turns, lastUserInputStep };
}

/** Last visible line of a task log: carriage-return progress and ANSI codes removed. */
export function lastLogLine(logText: string): string | undefined {
	const withoutAnsi = logText.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
	const lines = withoutAnsi
		.split("\n")
		.map((line) => {
			const parts = line.split("\r");
			for (let i = parts.length - 1; i >= 0; i--) {
				if (parts[i].trim()) return parts[i].trim();
			}
			return "";
		})
		.filter((line) => line.length > 0);
	return lines.at(-1);
}

const REASONING_SUFFIX = /^(.+)-(minimal|low|medium|high|xhigh|max)$/;

/** `gemini-4-neon-high` → base model `gemini-4-neon`, reasoning level `high`. */
export function splitAgyModel(id: string): { baseId: string; reasoning?: string } {
	const match = REASONING_SUFFIX.exec(id.trim());
	return match ? { baseId: match[1], reasoning: match[2] } : { baseId: id.trim() };
}

/** One entry of `<parent>/.system_generated/subagents/<id>.json`. */
export interface SubagentRecord {
	conversationId: string;
	role?: string;
	typeName?: string;
	/** `SUBAGENT_STATE_ALIVE`, `SUBAGENT_STATE_KILLED`, ... */
	state: string;
	/** Parent transcript step that reported the spawn. */
	spawnStepIndex?: number;
}

export function parseSubagentRecord(json: string): SubagentRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}
	const obj = asRecord(parsed);
	const conversationId = asString(obj?.conversationId);
	if (!obj || !conversationId) return undefined;
	const descriptor = asRecord(obj.subagentDescriptor);
	return {
		conversationId,
		role: asString(descriptor?.role),
		typeName: asString(descriptor?.typeName),
		state: asString(obj.state) ?? "",
		spawnStepIndex: typeof obj.spawnStepIndex === "number" ? obj.spawnStepIndex : undefined,
	};
}

export interface SubagentStatus {
	conversationId: string;
	role?: string;
	typeName?: string;
	/**
	 * Model and reasoning level it runs on (`gemini-4-neon-high`): from its own
	 * transcript, before its first answer from the parent when it runs as `self`.
	 */
	model?: string;
	/** True while `model` is the parent's (a `self` subagent before its first answer). */
	modelFromParent?: boolean;
	/** Model the parent asked for (`invoke_subagent` `Model`), if any. */
	requestedModel?: string;
	/** Task the parent gave it (`invoke_subagent` `Prompt`). */
	prompt?: string;
	/** `working` until it answers without tool calls; `idle` then; `killed` when stopped. */
	state: "working" | "idle" | "killed";
	/** What it does right now, or its last answer when idle. */
	activity?: string;
	toolCalls: number;
	startedAtMs?: number;
	lastAtMs?: number;
}

/**
 * Status of one subagent from its own transcript. The spawn arguments come from
 * the parent's `invoke_subagent` call, matched by role (a call may start several).
 */
export function deriveSubagentStatus(
	record: SubagentRecord,
	ownSteps: readonly TranscriptStep[],
	parentSteps: readonly TranscriptStep[],
	ownMessages: readonly TaskMessage[] = [],
): SubagentStatus {
	const ordered = [...ownSteps].sort((a, b) => a.index - b.index);
	const planners = ordered.filter((step) => step.type === "PLANNER_RESPONSE");
	const lastPlanner = planners.at(-1);
	const last = ordered.at(-1);
	let state: SubagentStatus["state"];
	let activity: string | undefined;
	// A timer or command it moved to the background wakes it up again later.
	const pending = deriveAgyActivity(ordered, ownMessages).tasks.filter((task) => !task.finished);
	const waitingFor = pending.at(-1);
	const waitingText = waitingFor
		? waitingFor.kind === "timer"
			? `waiting for timer ${waitingFor.timerSeconds ?? "?"} s`
			: `waiting for ${waitingFor.summary ?? waitingFor.description}`
		: undefined;
	if (record.state === "SUBAGENT_STATE_KILLED") {
		state = "killed";
		activity = "stopped";
	} else if (!lastPlanner) {
		state = "working";
		activity = "starting …";
	} else if (lastPlanner.toolCalls.length > 0) {
		state = "working";
		if (waitingFor && waitingText && waitingFor.stepIndex > lastPlanner.index) {
			// Its last tool call went to the background (agy writes the answer that
			// ends the turn a little later).
			activity = waitingText;
		} else if (last && last.index > lastPlanner.index && last.type !== "GENERIC") {
			activity = "thinking …";
		} else {
			const action = summarizeAction(lastPlanner.toolCalls[0]);
			const more = lastPlanner.toolCalls.length > 1 ? ` (+${lastPlanner.toolCalls.length - 1})` : "";
			activity = `→ ${action.name}${action.summary ? ` ${action.summary}` : ""}${more}`;
		}
	} else if (last && last.index > lastPlanner.index) {
		// A message arrived after its last answer: it works again.
		state = "working";
		activity = "thinking …";
	} else if (waitingText) {
		// An answer without tool calls ends its turn, but it still waits for a timer
		// or background command: it is not done.
		state = "working";
		activity = waitingText;
	} else {
		state = "idle";
		activity = firstLine(lastPlanner.content);
	}

	const spawn = spawnArguments(record, parentSteps);
	const typeName = record.typeName ?? spawn?.TypeName;
	const ownModel = [...planners].reverse().find((step) => step.model)?.model;
	const parentModel =
		!ownModel && typeName === "self" && !spawn?.Model
			? [...parentSteps]
					.filter((step) => step.type === "PLANNER_RESPONSE" && step.model)
					.sort((a, b) => b.index - a.index)[0]?.model
			: undefined;
	return {
		conversationId: record.conversationId,
		role: record.role ?? spawn?.Role,
		typeName,
		model: ownModel ?? parentModel,
		...(parentModel ? { modelFromParent: true } : {}),
		requestedModel: spawn?.Model,
		prompt: spawn?.Prompt,
		state,
		activity,
		toolCalls: planners.reduce((sum, step) => sum + step.toolCalls.length, 0),
		startedAtMs: ordered[0]?.createdAtMs,
		lastAtMs: last?.createdAtMs,
	};
}

function spawnArguments(
	record: SubagentRecord,
	parentSteps: readonly TranscriptStep[],
): Record<string, string> | undefined {
	const spawnStep = record.spawnStepIndex;
	if (spawnStep === undefined) return undefined;
	const planner = [...parentSteps]
		.filter(
			(step) =>
				step.type === "PLANNER_RESPONSE" &&
				step.index < spawnStep &&
				step.toolCalls.some((call) => call.name === "invoke_subagent"),
		)
		.sort((a, b) => b.index - a.index)[0];
	const calls = planner?.toolCalls.filter((call) => call.name === "invoke_subagent") ?? [];
	return calls.find((call) => call.args.Role === record.role)?.args ?? (calls.length === 1 ? calls[0].args : undefined);
}
