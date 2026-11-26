/**
 * Reads what Antigravity does between Pi turns from agy's own local files.
 *
 * agy runs long commands and `schedule` timers as background tasks. When one ends,
 * agy gets a message and starts a turn by itself, without a prompt from the client.
 * ACP clients see nothing of that turn, so the bridge reads agy's per-conversation
 * files below `<app data>/brain/<conversation>/.system_generated/`:
 * `logs/transcript_full.jsonl` (one JSON object per step; `transcript.jsonl` holds the
 * same steps with long fields cut in the middle), `messages/*.json` (task
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
	/** True when `transcript.jsonl` shortened at least one field (`truncated_fields`). */
	truncated?: boolean;
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
	kind: "command" | "timer" | "cron";
	/** Command line, or the timer/cron prompt. */
	description: string;
	/** agy's short label for the command (`toolSummary`), or the cron expression (`*\/5 * * * *`). */
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
		truncated: Array.isArray(obj.truncated_fields) && obj.truncated_fields.length > 0,
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

const TERMINAL_CONTENT_PATTERN = /^Task id "[^"]*" (?:finished|was cancell?ed)/i;
const TERMINAL_TITLE_PATTERN = /(?:finished|was cancell?ed|timer has expired)\s*$/i;
const CONTENT_CANCELED_PATTERN = /^(?:Task id "[^"]*"|Task|Timer) was cancell?ed\b/i;

/** Whether a task note reports the end of the task rather than progress. */
export function isTerminalNote(title: string | undefined, content: string): boolean {
	return TERMINAL_CONTENT_PATTERN.test(content.trim()) || TERMINAL_TITLE_PATTERN.test(title ?? "");
}

const BACKGROUND_TASK_PATTERN = /background task with task id:\s*(\S+)/;
const TASK_DESCRIPTION_PATTERN = /Task Description:\s*([\s\S]*?)(?:\n\s*Task logs are available at:|$)/;
const TIMER_PATTERN = /^Timer:\s*([^,\n]+?)(?:,\s*Prompt:\s*([\s\S]*))?$/;
const CRON_PATTERN = /^Cron:\s*([^,\n]+?)(?:,\s*Prompt:\s*([\s\S]*))?$/i;
const TASK_CANCELLED_PATTERN = /^Task "([^"]+)" cancell?ed\.?$/i;
const TASK_NOT_RUNNING_PATTERN = /cannot kill task "([^"]+)": task is not running \(status:\s*([^)]+)\)/i;
const TASK_STATUS_PATTERN = /^Task:\s*(\S+)\r?\nStatus:\s*(\S+)/;
const NO_RUNNING_TASKS_PATTERN = /^No background tasks are currently running\.?$/;
const RUNNING_TASKS_LIST_PATTERN = /^You have (\d+) background task\(s\) currently running:\r?\n([\s\S]+)$/;
const EXIT_CODE_PATTERN = /Command exited with code (-?\d+)/;
const MESSAGE_LINE_PATTERN = /(?:^|\r?\n|<SYSTEM_MESSAGE>\s*)(\[Message\][^\r\n]*)/g;

const TERMINAL_TASK_STATUSES = new Set([
	"DONE",
	"COMPLETED",
	"COMPLETE",
	"FINISHED",
	"SUCCEEDED",
	"SUCCESS",
	"FAILED",
	"FAILURE",
	"ERROR",
	"CANCELLED",
	"CANCELED",
	"KILLED",
	"STOPPED",
	"ABORTED",
	"EXPIRED",
	"TIMED_OUT",
	"TIMEOUT",
]);

const CANCELED_STEP_STATUSES = new Set(["CANCELED", "CANCELLED", "ABORTED"]);
const ERROR_OR_CANCELED_STEP_STATUSES = new Set(["CANCELED", "CANCELLED", "ABORTED", "ERROR"]);

function isTerminalTaskStatus(status: string): boolean {
	const normalized = status.trim().toUpperCase().replace(/^TASK_STATUS_/, "");
	return TERMINAL_TASK_STATUSES.has(normalized);
}

function isCanceledStepStatus(status: string): boolean {
	return CANCELED_STEP_STATUSES.has(status.trim().toUpperCase());
}

function isErrorOrCanceledStepStatus(status: string): boolean {
	return ERROR_OR_CANCELED_STEP_STATUSES.has(status.trim().toUpperCase());
}

function isInheritModel(model: string | undefined): boolean {
	return model !== undefined && model.trim().toLowerCase() === "inherit";
}

interface DeliveredMessage {
	timestampMs?: number;
	sender: string;
	content: string;
}

function parseSystemMessages(stepContent: string): DeliveredMessage[] {
	const headers: Array<{
		start: number;
		end: number;
		sender: string;
		timestampMs?: number;
		firstContentLine: string;
	}> = [];
	for (const match of stepContent.matchAll(MESSAGE_LINE_PATTERN)) {
		if (match.index === undefined) continue;
		const headerLine = match[1];
		const contentMatch = /\bcontent=/.exec(headerLine);
		const metaPart = contentMatch ? headerLine.slice(0, contentMatch.index) : headerLine;
		const sender = /\bsender=(\S+)/.exec(metaPart)?.[1];
		if (!sender) continue;
		const timestampRaw = /\btimestamp=(\S+)/.exec(metaPart)?.[1];
		const firstContentLine = contentMatch
			? headerLine.slice(contentMatch.index + contentMatch[0].length)
			: "";
		headers.push({
			start: match.index,
			end: match.index + match[0].length,
			sender,
			timestampMs: parseTimeMs(timestampRaw),
			firstContentLine,
		});
	}
	const messages: DeliveredMessage[] = [];
	for (let i = 0; i < headers.length; i++) {
		const current = headers[i];
		const nextStart = i + 1 < headers.length ? headers[i + 1].start : stepContent.length;
		let tail = stepContent.slice(current.end, nextStart);
		const closeMatch = /\r?\n<\/SYSTEM_MESSAGE>/.exec(tail);
		if (closeMatch) {
			tail = tail.slice(0, closeMatch.index);
		}
		messages.push({
			timestampMs: current.timestampMs,
			sender: current.sender,
			content: `${current.firstContentLine}${tail}`.trim(),
		});
	}
	return messages;
}

const DURATION_UNIT_SECONDS: Record<string, number> = {
	d: 86_400,
	h: 3_600,
	m: 60,
	s: 1,
};

/** Parses agy timer durations such as `30s`, `35m`, `2m 30s`, `1h 5m`. */
export function parseDurationSeconds(text: string): number | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const tokenPattern = /(\d+)\s*([dhms])/gi;
	let total = 0;
	let cursor = 0;
	for (const match of trimmed.matchAll(tokenPattern)) {
		if (match.index === undefined) return undefined;
		if (trimmed.slice(cursor, match.index).trim().length > 0) return undefined;
		const value = Number.parseInt(match[1], 10);
		const unit = DURATION_UNIT_SECONDS[match[2].toLowerCase()];
		if (!Number.isFinite(value) || unit === undefined) return undefined;
		total += value * unit;
		cursor = match.index + match[0].length;
	}
	if (cursor === 0 || trimmed.slice(cursor).trim().length > 0) return undefined;
	return total;
}

/** Compact duration: `30 s`, `2m 30s`, `35m`, `1h 5m`. */
export function formatDuration(totalSeconds: number): string {
	const total = Math.max(0, Math.floor(totalSeconds));
	if (total < 60) return `${total} s`;
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const seconds = total % 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0) parts.push(`${seconds}s`);
	return parts.join(" ");
}

function outcomeFromTaskStatus(status: string, kind: BackgroundTask["kind"]): TaskOutcome {
	const upper = status.trim().toUpperCase();
	if (upper.includes("CANCEL") || upper.includes("KILL") || upper.includes("ABORT")) return "canceled";
	if (upper.includes("EXPIRE")) return "expired";
	if (upper.includes("FAIL") || upper.includes("ERROR") || upper.includes("TIMED_OUT") || upper.includes("TIMEOUT")) {
		return kind === "timer" ? "expired" : "failed";
	}
	if (kind === "timer") return "expired";
	return "ok";
}

function parseStepBody(content: string): { body: string; completedAtMs?: number } {
	let completedAtMs: number | undefined;
	const lines = content.split(/\r?\n/);
	let start = 0;
	while (start < lines.length) {
		const line = lines[start].trim();
		const completed = /^Completed At:\s*(.+)$/.exec(line);
		if (completed) {
			completedAtMs = parseTimeMs(completed[1].trim()) ?? completedAtMs;
			start++;
			continue;
		}
		if (/^Created At:\s*.+$/.test(line)) {
			start++;
			continue;
		}
		break;
	}
	return { body: lines.slice(start).join("\n").trim(), completedAtMs };
}

function parseRunningTaskList(body: string): Set<string> | undefined {
	if (NO_RUNNING_TASKS_PATTERN.test(body)) {
		return new Set();
	}
	const match = RUNNING_TASKS_LIST_PATTERN.exec(body);
	if (!match) return undefined;
	const expectedCount = Number.parseInt(match[1], 10);
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[2].trim());
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length !== expectedCount) return undefined;
	const running = new Set<string>();
	for (const entry of parsed) {
		const rawId = asString(asRecord(entry)?.taskId);
		const id = rawId ? shortTaskId(rawId) : undefined;
		if (!id) return undefined;
		running.add(id);
	}
	return running;
}

function findScheduleCall(
	calls: readonly TranscriptToolCall[],
	prompt: string | undefined,
): TranscriptToolCall | undefined {
	const schedules = calls.filter((call) => call.name === "schedule");
	if (schedules.length === 0) return undefined;
	if (prompt !== undefined) {
		const trimmed = prompt.trim();
		const exact = schedules.find((call) => call.args.Prompt?.trim() === trimmed);
		if (exact) return exact;
	}
	return schedules.length === 1 ? schedules[0] : undefined;
}

function findCronScheduleCall(
	calls: readonly TranscriptToolCall[],
	description: string,
): TranscriptToolCall | undefined {
	const cronCalls = calls.filter((call) => call.name === "schedule" && Boolean(call.args.CronExpression?.trim()));
	if (cronCalls.length === 0) return undefined;
	const trimmed = description.trim();
	const exactPrompt = cronCalls.find((call) => call.args.Prompt?.trim() === trimmed);
	if (exactPrompt) return exactPrompt;
	const containsExpr = cronCalls.find((call) => {
		const expr = call.args.CronExpression?.trim();
		return expr !== undefined && expr.length > 0 && trimmed.includes(expr);
	});
	if (containsExpr) return containsExpr;
	const hasRunCommand = calls.some((call) => call.name === "run_command");
	return !hasRunCommand && cronCalls.length === 1 ? cronCalls[0] : undefined;
}

function taskContentHeader(content: string): string {
	const match = /(?:^|\r?\n)Command output:/i.exec(content);
	return (match ? content.slice(0, match.index) : content).trim();
}

function outcomeOf(title: string | undefined, content: string, kind: BackgroundTask["kind"] | undefined) {
	const header = taskContentHeader(content);
	const exitMatch = EXIT_CODE_PATTERN.exec(header);
	const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : undefined;
	let outcome: TaskOutcome;
	if (/was cancell?ed/i.test(title ?? "") || CONTENT_CANCELED_PATTERN.test(header)) {
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
		(args.CronExpression ? `cron ${args.CronExpression}` : undefined) ??
		(args.TaskId && args.Action ? `${args.Action} ${shortTaskId(args.TaskId) ?? args.TaskId}` : undefined) ??
		"";
	return { name: call.name, summary: summary.replace(/\s+/g, " ").trim() };
}

function isMessageDelivery(step: TranscriptStep): boolean {
	return step.type === "SYSTEM_MESSAGE" && parseSystemMessages(step.content).length > 0;
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
	const noteAt = (senderId: string, atMs: number | undefined, deliveredContent?: string) => {
		if (atMs === undefined) return undefined;
		const matching = notesBySender
			.get(senderId)
			?.filter((note) => note.timestampMs !== undefined && Math.abs(note.timestampMs - atMs) < 1_000);
		if (!matching || matching.length === 0) return undefined;
		if (matching.length === 1 || !deliveredContent) return matching[0];
		return (
			matching.find(
				(note) => note.content.trim() === deliveredContent || note.content.trim().startsWith(deliveredContent),
			) ?? matching[0]
		);
	};

	const tasks: BackgroundTask[] = [];
	const tasksById = new Map<string, BackgroundTask>();
	const taskKinds = new Map<string, BackgroundTask["kind"]>();
	const timerConditions = new Map<string, string>();
	const finishTask = (
		task: BackgroundTask | undefined,
		outcome: TaskOutcome,
		atMs: number | undefined,
		exitCode?: number,
	) => {
		if (!task || task.finished) return;
		task.finished = { outcome, exitCode, atMs };
	};
	let lastPlannerCalls: TranscriptToolCall[] = [];
	let lastPlannerStepIndex: number | undefined;
	for (const step of ordered) {
		if (step.type === "USER_INPUT") {
			lastPlannerCalls = [];
			lastPlannerStepIndex = undefined;
			continue;
		}
		if (step.type === "PLANNER_RESPONSE") {
			lastPlannerCalls = step.toolCalls;
			lastPlannerStepIndex = step.index;
			continue;
		}
		if (step.type === "SYSTEM_MESSAGE") {
			const deliveredList = parseSystemMessages(step.content);
			if (deliveredList.length === 0) continue;
			for (const delivered of deliveredList) {
				const sender = delivered.sender;
				const atMs = delivered.timestampMs ?? step.createdAtMs;
				const senderTaskId = shortTaskId(sender);
				if (senderTaskId) {
					const task = tasksById.get(senderTaskId);
					if (task && !task.finished && (isTerminalNote(undefined, delivered.content) || task.kind === "timer")) {
						const { outcome, exitCode } = outcomeOf(undefined, delivered.content, task.kind);
						finishTask(task, outcome, atMs, exitCode);
					}
				}
				for (const [timerId, condition] of timerConditions) {
					if (timerId === senderTaskId) continue;
					const timerTask = tasksById.get(timerId);
					if (!timerTask || timerTask.finished || timerTask.stepIndex >= step.index) continue;
					const conditionTaskId = shortTaskId(condition);
					const matches =
						condition === "any" ||
						sender === condition ||
						(conditionTaskId !== undefined && senderTaskId === conditionTaskId);
					if (matches) {
						finishTask(timerTask, "canceled", atMs);
					}
				}
			}
			continue;
		}
		if (step.status === "RUNNING") {
			const idMatch = BACKGROUND_TASK_PATTERN.exec(step.content);
			const taskId = idMatch ? shortTaskId(idMatch[1]) : undefined;
			if (!taskId) continue;
			const description = (TASK_DESCRIPTION_PATTERN.exec(step.content)?.[1] ?? "").trim();
			const timerMatch = TIMER_PATTERN.exec(description);
			const cronMatch = !timerMatch ? CRON_PATTERN.exec(description) : undefined;
			const parsedTimerSeconds = timerMatch ? parseDurationSeconds(timerMatch[1]) : undefined;
			const scheduleCall = timerMatch
				? findScheduleCall(lastPlannerCalls, timerMatch[2])
				: cronMatch
					? (lastPlannerCalls.find(
							(call) =>
								call.name === "schedule" && call.args.CronExpression?.trim() === cronMatch[1].trim(),
						) ?? findScheduleCall(lastPlannerCalls, cronMatch[2]))
					: undefined;
			const argSeconds = scheduleCall?.args.DurationSeconds
				? Number.parseInt(scheduleCall.args.DurationSeconds, 10)
				: undefined;
			const timerSeconds =
				parsedTimerSeconds ??
				(argSeconds !== undefined && Number.isFinite(argSeconds) ? argSeconds : undefined);
			const commandCall = lastPlannerCalls.find(
				(call) => call.name === "run_command" && call.args.CommandLine?.trim() === description,
			);
			const fallbackCronCall =
				!timerMatch && !cronMatch && !commandCall
					? findCronScheduleCall(lastPlannerCalls, description)
					: undefined;
			const cronExpression =
				cronMatch?.[1].trim() ||
				(cronMatch ? scheduleCall?.args.CronExpression?.trim() : undefined) ||
				fallbackCronCall?.args.CronExpression?.trim();
			let kind: BackgroundTask["kind"];
			let taskDescription: string;
			let summary: string | undefined;
			if (timerMatch && timerSeconds !== undefined) {
				kind = "timer";
				taskDescription = (timerMatch[2] ?? "").trim();
			} else if (cronMatch) {
				kind = "cron";
				taskDescription = (cronMatch[2] ?? scheduleCall?.args.Prompt ?? "").trim();
				summary = cronExpression || undefined;
			} else if (fallbackCronCall) {
				kind = "cron";
				taskDescription = (fallbackCronCall.args.Prompt ?? description).trim();
				summary = cronExpression || undefined;
			} else {
				kind = "command";
				taskDescription = description;
				summary = commandCall?.args.toolSummary;
			}
			const task: BackgroundTask = {
				taskId,
				stepIndex: step.index,
				kind,
				description: taskDescription,
				summary,
				timerSeconds: kind === "timer" ? timerSeconds : undefined,
				startedAtMs: step.createdAtMs,
			};
			const end = endOf(taskId);
			if (end) {
				const { outcome, exitCode } = outcomeOf(end.title, end.content, kind);
				task.finished = { outcome, title: end.title, exitCode, atMs: end.timestampMs };
			}
			if (kind === "timer") {
				const condition = scheduleCall?.args.TimerCondition?.trim();
				if (condition && condition.toLowerCase() !== "never") {
					timerConditions.set(taskId, condition);
				}
			}
			taskKinds.set(taskId, kind);
			tasksById.set(taskId, task);
			tasks.push(task);
			continue;
		}
		if (step.type !== "GENERIC") continue;
		const manageCalls = lastPlannerCalls.filter((call) => call.name === "manage_task");
		if (manageCalls.length === 0) continue;
		const { body, completedAtMs } = parseStepBody(step.content);
		const atMs = completedAtMs ?? step.createdAtMs;

		const cancelled = TASK_CANCELLED_PATTERN.exec(body);
		if (cancelled) {
			const id = shortTaskId(cancelled[1]);
			if (id) finishTask(tasksById.get(id), "canceled", atMs);
			continue;
		}
		const notRunning = TASK_NOT_RUNNING_PATTERN.exec(body);
		if (notRunning) {
			const id = shortTaskId(notRunning[1]);
			const task = id ? tasksById.get(id) : undefined;
			if (task) finishTask(task, outcomeFromTaskStatus(notRunning[2], task.kind), atMs);
			continue;
		}
		const statusMatch = TASK_STATUS_PATTERN.exec(body);
		if (statusMatch) {
			if (isTerminalTaskStatus(statusMatch[2])) {
				const id = shortTaskId(statusMatch[1]);
				const task = id ? tasksById.get(id) : undefined;
				if (task) finishTask(task, outcomeFromTaskStatus(statusMatch[2], task.kind), atMs);
			}
			continue;
		}
		if (lastPlannerStepIndex !== undefined && manageCalls.some((call) => call.args.Action === "list")) {
			const running = parseRunningTaskList(body);
			if (running) {
				for (const task of tasks) {
					if (task.finished || task.stepIndex >= lastPlannerStepIndex) continue;
					if (!running.has(task.taskId)) {
						finishTask(task, task.kind === "timer" || task.kind === "cron" ? "canceled" : "ok", atMs);
					}
				}
			}
		}
	}

	const turns: AutonomousTurn[] = [];
	let lastUserInputStep = -1;
	let inTurn = false;
	let current: AutonomousTurn | undefined;
	const closeCurrent = (
		state: AutonomousTurn["state"],
		endStep: number,
		endedAtMs?: number,
		allowEmpty = state === "done",
	) => {
		if (!current) return;
		current.state = state;
		current.endStep = endStep;
		current.endedAtMs = endedAtMs;
		if (current.texts.length > 0 || current.actions.length > 0 || allowEmpty) {
			turns.push(current);
		}
		current = undefined;
	};

	for (const step of ordered) {
		if (step.type === "USER_INPUT") {
			lastUserInputStep = step.index;
			closeCurrent("interrupted", step.index - 1, step.createdAtMs);
			inTurn = !isCanceledStepStatus(step.status);
			continue;
		}
		if (step.type === "GENERIC" && isCanceledStepStatus(step.status)) {
			closeCurrent("interrupted", step.index, step.createdAtMs, false);
			inTurn = false;
			continue;
		}
		if (step.type === "SYSTEM_MESSAGE") {
			const deliveredList = parseSystemMessages(step.content);
			if (deliveredList.length === 0) continue;
			const triggers: AutonomousTrigger[] = [];
			for (const delivered of deliveredList) {
				const sender = delivered.sender;
				const taskId = shortTaskId(sender);
				const kind = taskId ? taskKinds.get(taskId) : undefined;
				const note = noteAt(sender, delivered.timestampMs, delivered.content);
				const title = note?.title;
				if (taskId) {
					const content = note?.content ?? delivered.content;
					const terminal = note ? note.terminal : isTerminalNote(undefined, content) || kind === "timer";
					const result = terminal ? outcomeOf(title, content, kind) : undefined;
					triggers.push({
						taskId,
						title,
						outcome: terminal ? result?.outcome : "running",
						exitCode: result?.exitCode,
						kind,
					});
				} else {
					// A subagent (or another agent) sent agy a message.
					const preview = firstLine(note?.content ?? delivered.content);
					triggers.push({ agentId: sender, title, ...(preview ? { preview } : {}) });
				}
			}
			if (triggers.length > 0) {
				if (current) {
					current.triggers.push(...triggers);
				} else if (!inTurn) {
					current = {
						startStep: step.index,
						startedAtMs: step.createdAtMs,
						state: "running",
						triggers,
						actions: [],
						texts: [],
					};
					inTurn = true;
				}
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
		const failedOrCanceled = isErrorOrCanceledStepStatus(step.status);
		if (step.toolCalls.length === 0 || failedOrCanceled) {
			closeCurrent("done", step.index, step.createdAtMs, !failedOrCanceled);
			inTurn = false;
		}
	}
	if (current) {
		turns.push(current);
	}

	return { tasks, turns, lastUserInputStep };
}

const OSC_SEQUENCE_PATTERN = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_SEQUENCE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const STRAY_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Last visible line of a task log: carriage-return progress, ANSI/OSC codes and control chars removed. */
export function lastLogLine(logText: string): string | undefined {
	const cleaned = logText
		.replace(OSC_SEQUENCE_PATTERN, "")
		.replace(CSI_SEQUENCE_PATTERN, "")
		.replace(STRAY_CONTROL_PATTERN, "");
	const lines = cleaned
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

function describePendingTask(task: BackgroundTask): string {
	if (task.kind === "timer") {
		return `waiting for timer ${task.timerSeconds !== undefined ? formatDuration(task.timerSeconds) : "?"}`;
	}
	if (task.kind === "cron") {
		return `waiting for cron ${task.summary ?? task.description}`;
	}
	return `waiting for ${task.summary ?? task.description}`;
}

function summarizeToolCallsActivity(calls: readonly TranscriptToolCall[]): string {
	const action = summarizeAction(calls[0]);
	const more = calls.length > 1 ? ` (+${calls.length - 1})` : "";
	return `→ ${action.name}${action.summary ? ` ${action.summary}` : ""}${more}`;
}

function latestStepModel(planners: readonly TranscriptStep[]): string | undefined {
	return [...planners].reverse().find((step) => step.model)?.model;
}

function maxTime(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return Math.max(a, b);
}

function earliestMessageTime(messages: readonly TaskMessage[]): number | undefined {
	let earliest: number | undefined;
	for (const message of messages) {
		if (message.timestampMs === undefined) continue;
		if (earliest === undefined || message.timestampMs < earliest) {
			earliest = message.timestampMs;
		}
	}
	return earliest;
}

function latestMessageTime(messages: readonly TaskMessage[], terminalOnly = false): number | undefined {
	let latest: number | undefined;
	for (const message of messages) {
		if (terminalOnly && !message.terminal) continue;
		if (message.timestampMs === undefined) continue;
		if (latest === undefined || message.timestampMs > latest) {
			latest = message.timestampMs;
		}
	}
	return latest;
}

function hasTrailingMessageOrInput(ordered: readonly TranscriptStep[], afterIndex: number): boolean {
	return ordered.some(
		(step) => step.index > afterIndex && (isMessageDelivery(step) || step.type === "USER_INPUT"),
	);
}

function hasRunningStepFrom(ordered: readonly TranscriptStep[], fromIndex: number): boolean {
	return ordered.some((step) => step.index >= fromIndex && step.status === "RUNNING");
}

function hasNewerNonTaskMessage(messages: readonly TaskMessage[], referenceMs: number | undefined): boolean {
	if (referenceMs === undefined) return false;
	return messages.some(
		(message) => !message.taskId && message.timestampMs !== undefined && message.timestampMs > referenceMs + 1_000,
	);
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
	const waitingText = waitingFor ? describePendingTask(waitingFor) : undefined;
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
			activity = summarizeToolCallsActivity(lastPlanner.toolCalls);
		}
	} else if (hasTrailingMessageOrInput(ordered, lastPlanner.index)) {
		// A message or prompt arrived after its last answer: it works again.
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
	const rawRequestedModel = spawn?.Model?.trim();
	const inheritsParentModel = isInheritModel(rawRequestedModel);
	const requestedModel = rawRequestedModel && !inheritsParentModel ? rawRequestedModel : undefined;
	const ownModel = latestStepModel(planners);
	const parentModel =
		!ownModel && (inheritsParentModel || (typeName === "self" && !rawRequestedModel))
			? [...parentSteps]
					.filter((step) => step.type === "PLANNER_RESPONSE" && step.model)
					.sort((a, b) => b.index - a.index)[0]?.model
			: undefined;
	const latestOwnMessageMs = latestMessageTime(ownMessages, true);
	const lastAtMs = maxTime(last?.createdAtMs, latestOwnMessageMs);
	return {
		conversationId: record.conversationId,
		role: record.role ?? spawn?.Role,
		typeName,
		model: ownModel ?? parentModel,
		...(parentModel ? { modelFromParent: true } : {}),
		requestedModel,
		prompt: spawn?.Prompt,
		state,
		activity,
		toolCalls: planners.reduce((sum, step) => sum + step.toolCalls.length, 0),
		startedAtMs: ordered[0]?.createdAtMs,
		lastAtMs,
	};
}

const SWARM_CONVERSATION_ID_PATTERN = /^[\w-]+$/;
const ACTIVE_SWARM_PHASES = new Set(["STARTING", "RUNNING", "WORKING"]);

/** One non-coordinator entry of `<parent>/.system_generated/swarm/members.json`. */
export interface SwarmMemberRecord {
	name: string;
	conversationId: string;
	role: string;
	desiredState?: string;
	phase?: string;
	wakeMode?: string;
	requestedModel?: string;
}

export interface SwarmMemberStatus {
	name: string;
	conversationId: string;
	role: string;
	state: "working" | "parked" | "idle" | "killed";
	model?: string;
	requestedModel?: string;
	activity?: string;
	startedAtMs?: number;
	lastAtMs?: number;
}

/** Parses `<systemDir>/swarm/members.json`, skipping coordinator and invalid entries. */
export function parseSwarmMembersFile(raw: string): SwarmMemberRecord[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const obj = asRecord(parsed);
	const members = asRecord(obj?.members);
	if (!members) return [];
	const records: SwarmMemberRecord[] = [];
	for (const [rawName, rawEntry] of Object.entries(members)) {
		const name = rawName.trim();
		if (!name) continue;
		const entry = asRecord(rawEntry);
		if (!entry) continue;
		const conversationId = asString(entry.conversation_id)?.trim();
		if (!conversationId || !SWARM_CONVERSATION_ID_PATTERN.test(conversationId)) continue;
		const role = asString(entry.role)?.trim() || "worker";
		if (role === "coordinator") continue;
		const desiredState = asString(entry.desired_state)?.trim() || undefined;
		const phase = asString(entry.phase)?.trim() || undefined;
		const wakeMode = asString(entry.wake_mode)?.trim() || undefined;
		const requestedModel = asString(entry.model)?.trim() || undefined;
		records.push({
			name,
			conversationId,
			role,
			...(desiredState ? { desiredState } : {}),
			...(phase ? { phase } : {}),
			...(wakeMode ? { wakeMode } : {}),
			...(requestedModel ? { requestedModel } : {}),
		});
	}
	return records;
}

/** Derives one swarm worker's current status from its roster entry, transcript steps and inbox messages. */
export function deriveSwarmMemberStatus(
	member: SwarmMemberRecord,
	steps: readonly TranscriptStep[],
	messages: readonly TaskMessage[] = [],
): SwarmMemberStatus {
	const ordered = [...steps].sort((a, b) => a.index - b.index);
	const planners = ordered.filter((step) => step.type === "PLANNER_RESPONSE");
	const lastPlanner = planners.at(-1);
	const last = ordered.at(-1);
	const pending = deriveAgyActivity(ordered, messages).tasks.filter((task) => !task.finished);
	const waitingFor = pending.at(-1);
	const waitingText = waitingFor ? describePendingTask(waitingFor) : undefined;

	const killed = member.desiredState === "KILLED" || member.phase === "KILLED";
	const parked = !killed && (member.wakeMode === "mentions" || member.wakeMode === "anything");

	let state: SwarmMemberStatus["state"];
	let activity: string | undefined;

	if (killed) {
		state = "killed";
		activity = "stopped";
	} else if (parked) {
		state = "parked";
		const lastAnswer =
			lastPlanner && lastPlanner.toolCalls.length === 0 ? firstLine(lastPlanner.content) : undefined;
		activity = waitingText ?? lastAnswer ?? "waiting on board";
	} else if (ordered.length === 0) {
		const starting =
			messages.length > 0 ||
			member.wakeMode === "working" ||
			(member.phase !== undefined && ACTIVE_SWARM_PHASES.has(member.phase.toUpperCase()));
		state = starting ? "working" : "idle";
		activity = starting ? "starting …" : undefined;
	} else if (!lastPlanner) {
		state = "working";
		activity = "starting …";
	} else if (lastPlanner.toolCalls.length > 0 && !isErrorOrCanceledStepStatus(lastPlanner.status)) {
		state = "working";
		if (waitingFor && waitingText && waitingFor.stepIndex > lastPlanner.index) {
			activity = waitingText;
		} else if (last && last.index > lastPlanner.index && last.type !== "GENERIC") {
			activity = "thinking …";
		} else {
			activity = summarizeToolCallsActivity(lastPlanner.toolCalls);
		}
	} else if (hasRunningStepFrom(ordered, lastPlanner.index)) {
		state = "working";
		activity = waitingText ?? "thinking …";
	} else if (
		hasTrailingMessageOrInput(ordered, lastPlanner.index) ||
		hasNewerNonTaskMessage(messages, last?.createdAtMs)
	) {
		state = "working";
		activity = "thinking …";
	} else if (waitingText) {
		state = "working";
		activity = waitingText;
	} else {
		state = "idle";
		activity = firstLine(lastPlanner.content);
	}

	const ownModel = latestStepModel(planners);
	const requestedModel = member.requestedModel;
	const startedAtMs = ordered[0]?.createdAtMs ?? earliestMessageTime(messages);
	const lastAtMs = maxTime(last?.createdAtMs, latestMessageTime(messages));

	return {
		name: member.name,
		conversationId: member.conversationId,
		role: member.role,
		state,
		...(ownModel ? { model: ownModel } : {}),
		...(requestedModel ? { requestedModel } : {}),
		...(activity ? { activity } : {}),
		...(startedAtMs !== undefined ? { startedAtMs } : {}),
		...(lastAtMs !== undefined ? { lastAtMs } : {}),
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
