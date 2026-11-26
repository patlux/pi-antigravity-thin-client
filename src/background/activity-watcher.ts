import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	type AgyActivity,
	type AutonomousTurn,
	type BackgroundTask,
	deriveAgyActivity,
	deriveSubagentStatus,
	lastLogLine,
	parseSubagentRecord,
	parseTaskMessage,
	parseTranscriptLine,
	type SubagentRecord,
	type SubagentStatus,
	type TaskMessage,
	type TranscriptStep,
} from "./agy-activity.ts";

/** How long a finished task stays in the snapshot so the widget can show its result. */
const FINISHED_TASK_LINGER_MS = 8_000;
const LOG_TAIL_BYTES = 4_096;
const DEFAULT_POLL_MS = 1_000;
/** How long to wait for `transcript_full.jsonl` when a newly finished turn was truncated in `transcript.jsonl`. */
const TRUNCATED_FULL_WAIT_MS = 2_000;
const TRUNCATED_FULL_WAIT_POLLS = 2;

/**
 * Reads a conversation's growing transcript incrementally; tolerates a partial last
 * line. agy writes each step twice: `transcript.jsonl` shortens long fields in the
 * middle (`<truncated N bytes>`, listed in `truncated_fields`), and
 * `transcript_full.jsonl` keeps them whole. The reader prefers the full file when
 * non-empty and falls back to the short one while the full file does not exist or is empty.
 */
class TranscriptReader {
	readonly steps = new Map<number, TranscriptStep>();
	private offset = 0;
	private partialLine = "";
	private decoder = new StringDecoder("utf8");
	private readonly logsDir: string;
	private file: string | undefined;

	/** `logsDir`: `<conversation>/.system_generated/logs` */
	constructor(logsDir: string) {
		this.logsDir = logsDir;
	}

	get usingFullTranscript(): boolean {
		return this.file !== undefined && path.basename(this.file) === "transcript_full.jsonl";
	}

	private selectFile(): { file: string; size: number } | undefined {
		const fullFile = path.join(this.logsDir, "transcript_full.jsonl");
		const shortFile = path.join(this.logsDir, "transcript.jsonl");
		let fullSize: number | undefined;
		try {
			fullSize = fs.statSync(fullFile).size;
		} catch {
			// Full transcript does not exist yet.
		}
		if (fullSize !== undefined && fullSize > 0) {
			return { file: fullFile, size: fullSize };
		}
		try {
			const shortSize = fs.statSync(shortFile).size;
			return { file: shortFile, size: shortSize };
		} catch {
			// Short transcript does not exist.
		}
		if (fullSize !== undefined) {
			return { file: fullFile, size: fullSize };
		}
		return undefined;
	}

	private resetState(): void {
		this.offset = 0;
		this.partialLine = "";
		this.decoder = new StringDecoder("utf8");
		this.steps.clear();
	}

	read(): void {
		const selected = this.selectFile();
		if (!selected) return;
		const { file, size } = selected;
		if (file !== this.file) {
			// First read, or the full transcript appeared: read it from the start.
			this.file = file;
			this.resetState();
		}
		if (size < this.offset) {
			// agy rewrote the file: start over.
			this.resetState();
		}
		if (size === this.offset) return;
		const length = size - this.offset;
		const buffer = Buffer.alloc(length);
		const fd = fs.openSync(file, "r");
		let bytesRead = 0;
		try {
			bytesRead = fs.readSync(fd, buffer, 0, length, this.offset);
		} finally {
			fs.closeSync(fd);
		}
		if (bytesRead <= 0) return;
		this.offset += bytesRead;
		const chunk = this.partialLine + this.decoder.write(buffer.subarray(0, bytesRead));
		const lines = chunk.split("\n");
		this.partialLine = lines.pop() ?? "";
		for (const line of lines) {
			const step = parseTranscriptLine(line);
			if (step) this.steps.set(step.index, step);
		}
	}
}

/** Adds new `messages/*.json` notes of a conversation to `cache` (keyed by file name). */
function readTaskMessages(dir: string, cache: Map<string, TaskMessage>): void {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".json") || name === "read.json" || cache.has(name)) continue;
		try {
			const message = parseTaskMessage(fs.readFileSync(path.join(dir, name), "utf8"));
			if (message) cache.set(name, message);
		} catch {
			// A file still being written is read again on the next poll.
		}
	}
}

export interface ActivitySnapshot {
	agySessionId: string;
	/** Running tasks and tasks that finished during the last few seconds. */
	tasks: BackgroundTask[];
	/** Working subagents and subagents that went idle or were stopped a few seconds ago. */
	subagents?: SubagentStatus[];
	/** Last output line per running command task. */
	logTails: Map<string, string>;
	/** A turn agy is taking on its own right now. */
	runningTurn?: AutonomousTurn;
}

export interface ActivityWatcherOptions {
	agySessionId: string;
	/** `<app data>/brain/<conversation>/.system_generated` */
	systemDir: string;
	/** False once agy's process is gone: its tasks cannot run any more. */
	isAlive: () => boolean;
	onSnapshot: (snapshot: ActivitySnapshot) => void;
	/** Called once per finished or interrupted autonomous turn. */
	onTurnFinished: (turn: AutonomousTurn) => void;
	/** Turns already recorded in the Pi session (by start step). */
	alreadyRecorded?: (startStep: number) => boolean;
	pollMs?: number;
	now?: () => number;
}

/**
 * Polls one agy conversation's local files and reports background tasks and
 * autonomous turns. Read-only: it never writes to agy's files or talks to agy.
 */
export class AgyActivityWatcher {
	readonly agySessionId: string;
	private readonly options: ActivityWatcherOptions;
	private readonly transcript: TranscriptReader;
	private readonly messages = new Map<string, TaskMessage>();
	private readonly subagentRecords = new Map<string, SubagentRecord>();
	private readonly subagentReaders = new Map<string, TranscriptReader>();
	private readonly subagentMessages = new Map<string, Map<string, TaskMessage>>();
	private readonly emittedTurns = new Set<number>();
	private readonly truncatedTurnWait = new Map<number, { firstSeenAtMs: number; polls: number }>();
	private baselineStep: number | undefined;
	private timer: NodeJS.Timeout | undefined;
	private lastSnapshotKey = "";
	private activity: AgyActivity = { tasks: [], turns: [], lastUserInputStep: -1 };

	constructor(options: ActivityWatcherOptions) {
		this.options = options;
		this.agySessionId = options.agySessionId;
		this.transcript = new TranscriptReader(path.join(options.systemDir, "logs"));
	}

	start(): void {
		if (this.timer) return;
		this.poll();
		this.timer = setInterval(() => this.poll(), this.options.pollMs ?? DEFAULT_POLL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Reads new data now and returns the current activity (also used for tool cards). */
	refresh(): AgyActivity {
		this.transcript.read();
		this.readMessages();
		this.activity = deriveAgyActivity([...this.transcript.steps.values()], [...this.messages.values()]);
		if (this.baselineStep === undefined) {
			// Already-finished turns from before this watcher started must not be replayed as new cards.
			let baseline = this.activity.lastUserInputStep;
			for (const turn of this.activity.turns) {
				if (turn.state !== "running" && turn.startStep > baseline) {
					baseline = turn.startStep;
				}
			}
			this.baselineStep = baseline;
		}
		return this.activity;
	}

	private isRecent(atMs: number | undefined): boolean {
		if (atMs === undefined) return true;
		const now = this.options.now?.() ?? Date.now();
		return now - atMs < FINISHED_TASK_LINGER_MS;
	}

	private pickRecentTask(candidates: readonly BackgroundTask[]): BackgroundTask | undefined {
		const active = candidates.filter((task) => !task.finished);
		if (active.length > 0) return active.at(-1);
		for (let i = candidates.length - 1; i >= 0; i--) {
			const task = candidates[i];
			if (task.finished && this.isRecent(task.finished.atMs)) return task;
		}
		return undefined;
	}

	/** The background task agy started for this command line, if any. */
	findCommandTask(command: string): BackgroundTask | undefined {
		const wanted = command.trim();
		const tasks = this.refresh().tasks.filter(
			(task) => task.kind === "command" && task.description === wanted,
		);
		return this.pickRecentTask(tasks);
	}

	/** Subagents agy started in this conversation, newest last. */
	subagents(): SubagentStatus[] {
		this.transcript.read();
		this.readSubagentRecords();
		const parentSteps = [...this.transcript.steps.values()];
		const brainDir = path.dirname(path.dirname(this.options.systemDir));
		const result: SubagentStatus[] = [];
		for (const record of this.subagentRecords.values()) {
			let reader = this.subagentReaders.get(record.conversationId);
			if (!reader) {
				reader = new TranscriptReader(path.join(brainDir, record.conversationId, ".system_generated", "logs"));
				this.subagentReaders.set(record.conversationId, reader);
			}
			let messages = this.subagentMessages.get(record.conversationId);
			if (!messages) {
				messages = new Map();
				this.subagentMessages.set(record.conversationId, messages);
			}
			try {
				reader.read();
				readTaskMessages(path.join(brainDir, record.conversationId, ".system_generated", "messages"), messages);
			} catch {
				// Read again on the next poll.
			}
			result.push(
				deriveSubagentStatus(record, [...reader.steps.values()], parentSteps, [...messages.values()]),
			);
		}
		return result.sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));
	}

	/** The subagent started for this role, newest first. */
	findSubagent(role: string | undefined): SubagentStatus | undefined {
		const all = this.subagents();
		const matching = role ? all.filter((status) => status.role === role) : all;
		const working = matching.filter((status) => status.state === "working");
		if (working.length > 0) return working.at(-1);
		for (let i = matching.length - 1; i >= 0; i--) {
			const status = matching[i];
			if (this.isRecent(status.lastAtMs)) return status;
		}
		return undefined;
	}

	/** The most recent timer agy set. */
	latestTimer(): BackgroundTask | undefined {
		const timers = this.refresh().tasks.filter((task) => task.kind === "timer");
		return this.pickRecentTask(timers);
	}

	private hasTruncatedPlannerStep(turn: AutonomousTurn): boolean {
		const endStep = turn.endStep ?? Number.POSITIVE_INFINITY;
		for (const step of this.transcript.steps.values()) {
			if (
				step.type === "PLANNER_RESPONSE" &&
				step.index > turn.startStep &&
				step.index <= endStep &&
				step.truncated
			) {
				return true;
			}
		}
		return false;
	}

	private shouldDeferTruncatedTurn(turn: AutonomousTurn, now: number): boolean {
		if (this.transcript.usingFullTranscript || !this.hasTruncatedPlannerStep(turn)) {
			this.truncatedTurnWait.delete(turn.startStep);
			return false;
		}
		const existing = this.truncatedTurnWait.get(turn.startStep);
		if (!existing) {
			this.truncatedTurnWait.set(turn.startStep, { firstSeenAtMs: now, polls: 1 });
			return true;
		}
		existing.polls++;
		const waitedMs = Math.max(0, now - existing.firstSeenAtMs);
		if (waitedMs >= TRUNCATED_FULL_WAIT_MS || existing.polls > TRUNCATED_FULL_WAIT_POLLS) {
			this.truncatedTurnWait.delete(turn.startStep);
			return false;
		}
		return true;
	}

	poll(): void {
		let activity: AgyActivity;
		try {
			activity = this.refresh();
		} catch {
			return;
		}
		const now = this.options.now?.() ?? Date.now();
		const baseline = this.baselineStep ?? -1;
		for (const turn of activity.turns) {
			if (turn.state === "running" || turn.startStep <= baseline) continue;
			if (this.emittedTurns.has(turn.startStep)) continue;
			if (this.options.alreadyRecorded?.(turn.startStep)) {
				this.emittedTurns.add(turn.startStep);
				this.truncatedTurnWait.delete(turn.startStep);
				continue;
			}
			if (this.shouldDeferTruncatedTurn(turn, now)) continue;
			this.emittedTurns.add(turn.startStep);
			this.options.onTurnFinished(turn);
		}
		this.publishSnapshot(activity);
	}

	private publishSnapshot(activity: AgyActivity): void {
		const now = this.options.now?.() ?? Date.now();
		const alive = this.options.isAlive();
		const tasks = activity.tasks.filter((task) => {
			if (!task.finished) return alive;
			return now - (task.finished.atMs ?? 0) < FINISHED_TASK_LINGER_MS;
		});
		let subagents: SubagentStatus[] = [];
		try {
			subagents = this.subagents().filter((status) => {
				if (status.state === "working") return alive;
				return now - (status.lastAtMs ?? 0) < FINISHED_TASK_LINGER_MS;
			});
		} catch {
			subagents = [];
		}
		const logTails = new Map<string, string>();
		for (const task of tasks) {
			if (task.kind !== "command" || task.finished) continue;
			const tail = this.readLogTail(task.taskId);
			if (tail) logTails.set(task.taskId, tail);
		}
		const runningTurn = alive
			? activity.turns.find(
					(turn) => turn.state === "running" && turn.startStep > (this.baselineStep ?? -1),
				)
			: undefined;
		const snapshot: ActivitySnapshot = {
			agySessionId: this.agySessionId,
			tasks,
			subagents,
			logTails,
			runningTurn,
		};
		const key = JSON.stringify({
			tasks: tasks.map((task) => [
				task.taskId,
				task.kind,
				task.timerSeconds,
				task.summary,
				task.description,
				task.finished?.outcome,
				task.finished?.exitCode,
			]),
			subagents: subagents.map((status) => [status.conversationId, status.state, status.activity, status.model]),
			tails: [...logTails.entries()],
			turn: runningTurn ? [runningTurn.startStep, runningTurn.actions.length] : undefined,
		});
		// The widget animates elapsed times itself; only report changed content.
		if (key === this.lastSnapshotKey) return;
		this.lastSnapshotKey = key;
		this.options.onSnapshot(snapshot);
	}

	private readSubagentRecords(): void {
		const dir = path.join(this.options.systemDir, "subagents");
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			try {
				const record = parseSubagentRecord(fs.readFileSync(path.join(dir, name), "utf8"));
				// The state changes (alive → killed), so read the record every time.
				if (record) this.subagentRecords.set(record.conversationId, record);
			} catch {
				// A file still being written is read again on the next poll.
			}
		}
	}

	private readMessages(): void {
		readTaskMessages(path.join(this.options.systemDir, "messages"), this.messages);
	}

	private readLogTail(taskId: string): string | undefined {
		const file = path.join(this.options.systemDir, "tasks", `${taskId}.log`);
		try {
			const size = fs.statSync(file).size;
			if (size === 0) return undefined;
			const length = Math.min(size, LOG_TAIL_BYTES);
			const buffer = Buffer.alloc(length);
			const fd = fs.openSync(file, "r");
			let bytesRead = 0;
			try {
				bytesRead = fs.readSync(fd, buffer, 0, length, size - length);
			} finally {
				fs.closeSync(fd);
			}
			if (bytesRead <= 0) return undefined;
			return lastLogLine(buffer.subarray(0, bytesRead).toString("utf8"));
		} catch {
			return undefined;
		}
	}
}
