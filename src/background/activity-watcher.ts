import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AgyActivity,
	type AutonomousTurn,
	type BackgroundTask,
	deriveAgyActivity,
	lastLogLine,
	parseTaskMessage,
	parseTranscriptLine,
	type TaskMessage,
	type TranscriptStep,
} from "./agy-activity.ts";

/** How long a finished task stays in the snapshot so the widget can show its result. */
const FINISHED_TASK_LINGER_MS = 8_000;
const LOG_TAIL_BYTES = 4_096;
const DEFAULT_POLL_MS = 1_000;

export interface ActivitySnapshot {
	agySessionId: string;
	/** Running tasks and tasks that finished during the last few seconds. */
	tasks: BackgroundTask[];
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
	private readonly steps = new Map<number, TranscriptStep>();
	private readonly messages = new Map<string, TaskMessage>();
	private readonly emittedTurns = new Set<number>();
	private transcriptOffset = 0;
	private partialLine = "";
	private baselineStep: number | undefined;
	private timer: NodeJS.Timeout | undefined;
	private lastSnapshotKey = "";
	private activity: AgyActivity = { tasks: [], turns: [], lastUserInputStep: -1 };

	constructor(options: ActivityWatcherOptions) {
		this.options = options;
		this.agySessionId = options.agySessionId;
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
		this.readTranscript();
		this.readMessages();
		this.activity = deriveAgyActivity([...this.steps.values()], [...this.messages.values()]);
		if (this.baselineStep === undefined) {
			// Turns from before this watcher started were missed long ago; do not replay them.
			this.baselineStep = this.activity.lastUserInputStep;
		}
		return this.activity;
	}

	/** The background task agy started for this command line, if any. */
	findCommandTask(command: string): BackgroundTask | undefined {
		const wanted = command.trim();
		const tasks = this.refresh().tasks.filter(
			(task) => task.kind === "command" && task.description === wanted,
		);
		return tasks.at(-1);
	}

	/** The most recent timer agy set. */
	latestTimer(): BackgroundTask | undefined {
		return this.refresh().tasks.filter((task) => task.kind === "timer").at(-1);
	}

	poll(): void {
		let activity: AgyActivity;
		try {
			activity = this.refresh();
		} catch {
			return;
		}
		const baseline = this.baselineStep ?? -1;
		for (const turn of activity.turns) {
			if (turn.state === "running" || turn.startStep <= baseline) continue;
			if (this.emittedTurns.has(turn.startStep)) continue;
			this.emittedTurns.add(turn.startStep);
			if (this.options.alreadyRecorded?.(turn.startStep)) continue;
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
			logTails,
			runningTurn,
		};
		const key = JSON.stringify({
			tasks: tasks.map((task) => [task.taskId, task.finished?.outcome]),
			tails: [...logTails.entries()],
			turn: runningTurn ? [runningTurn.startStep, runningTurn.actions.length] : undefined,
		});
		// The widget animates elapsed times itself; only report changed content.
		if (key === this.lastSnapshotKey) return;
		this.lastSnapshotKey = key;
		this.options.onSnapshot(snapshot);
	}

	private readTranscript(): void {
		const file = path.join(this.options.systemDir, "logs", "transcript.jsonl");
		let size: number;
		try {
			size = fs.statSync(file).size;
		} catch {
			return;
		}
		if (size < this.transcriptOffset) {
			// agy rewrote the file: start over.
			this.transcriptOffset = 0;
			this.partialLine = "";
			this.steps.clear();
		}
		if (size === this.transcriptOffset) return;
		const length = size - this.transcriptOffset;
		const buffer = Buffer.alloc(length);
		const fd = fs.openSync(file, "r");
		try {
			fs.readSync(fd, buffer, 0, length, this.transcriptOffset);
		} finally {
			fs.closeSync(fd);
		}
		this.transcriptOffset = size;
		const chunk = this.partialLine + buffer.toString("utf8");
		const lines = chunk.split("\n");
		this.partialLine = lines.pop() ?? "";
		for (const line of lines) {
			const step = parseTranscriptLine(line);
			if (step) this.steps.set(step.index, step);
		}
	}

	private readMessages(): void {
		const dir = path.join(this.options.systemDir, "messages");
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json") || name === "read.json" || this.messages.has(name)) continue;
			try {
				const message = parseTaskMessage(fs.readFileSync(path.join(dir, name), "utf8"));
				if (message) this.messages.set(name, message);
			} catch {
				// A file still being written is read again on the next poll.
			}
		}
	}

	private readLogTail(taskId: string): string | undefined {
		const file = path.join(this.options.systemDir, "tasks", `${taskId}.log`);
		try {
			const size = fs.statSync(file).size;
			if (size === 0) return undefined;
			const length = Math.min(size, LOG_TAIL_BYTES);
			const buffer = Buffer.alloc(length);
			const fd = fs.openSync(file, "r");
			try {
				fs.readSync(fd, buffer, 0, length, size - length);
			} finally {
				fs.closeSync(fd);
			}
			return lastLogLine(buffer.toString("utf8"));
		} catch {
			return undefined;
		}
	}
}
