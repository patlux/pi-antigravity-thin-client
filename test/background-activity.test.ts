import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { type ActivitySnapshot, AgyActivityWatcher } from "../src/background/activity-watcher.ts";
import {
	type AutonomousTurn,
	deriveAgyActivity,
	lastLogLine,
	parseTaskMessage,
	parseTranscriptLine,
	type TranscriptStep,
} from "../src/background/agy-activity.ts";
import { AgyTurnMirrorBroker, classifyAgyToolCall } from "../src/tools/agy-mirror-tools.ts";
import {
	describeTrigger,
	LIVE_STALE_MS,
	renderActivityLines,
	renderAutonomousEntry,
	type ThemeLike,
	toAutonomousEntryData,
} from "../src/ui/background-activity.ts";
import { interactiveContext } from "./human-input.ts";

const CONV = "0f0f0f0f-1111-2222-3333-444444444444";
const BRAIN = "/home/user/.gemini/antigravity-cli/brain";

/** Transcript lines in agy's format (abridged from a real run of the test prompt). */
function transcriptLines(): string[] {
	const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
	return [
		line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T13:54:21Z", content: "<USER_REQUEST>\nStarte `sleep 60; echo fertig` im Hintergrund\n</USER_REQUEST>" }),
		line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T13:54:22Z", tool_calls: [{ name: "run_command", args: { CommandLine: "\"sleep 60; echo fertig\"", WaitMsBeforeAsync: "500", toolSummary: "\"Background sleep task\"" } }] }),
		line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-25T13:54:25Z", content: `Created At: 2026-11-25T14:54:25+01:00\nTool is running as a background task with task id: ${CONV}/task-2\nTask Description: sleep 60; echo fertig\nTask logs are available at: file://${BRAIN}/${CONV}/.system_generated/tasks/task-2.log` }),
		line({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T13:54:27Z", content: "Läuft als Hintergrund-Task." }),
		line({ step_index: 4, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T13:54:40Z", content: "<USER_REQUEST>\nTimer auf 30 Sekunden\n</USER_REQUEST>" }),
		line({ step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T13:54:41Z", tool_calls: [{ name: "schedule", args: { DurationSeconds: "30", Prompt: "\"Der Timer ist abgelaufen.\"" } }] }),
		line({ step_index: 6, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-25T13:54:46Z", content: `Created At: 2026-11-25T14:54:46+01:00\nTool is running as a background task with task id: ${CONV}/task-6\nTask Description: Timer: 30s, Prompt: Der Timer ist abgelaufen.\nTask logs are available at: file://${BRAIN}/${CONV}/.system_generated/tasks/task-6.log` }),
		line({ step_index: 7, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T13:54:46Z", content: "Timer gestellt." }),
		line({ step_index: 8, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-25T13:55:16Z", content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-25T13:55:16Z sender=${CONV}/task-6 priority=MESSAGE_PRIORITY_HIGH content=Der Timer ist abgelaufen.\n</SYSTEM_MESSAGE>` }),
		line({ step_index: 9, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T13:55:16Z", content: "Der 30-Sekunden-Timer ist abgelaufen." }),
		line({ step_index: 10, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-25T13:55:26Z", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-25T13:55:26Z sender=${CONV}/task-2 priority=MESSAGE_PRIORITY_HIGH content=Task id "${CONV}/task-2" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>` }),
		line({ step_index: 11, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T13:55:26Z", content: "Der Hintergrund-Task ist fertig. Ausgabe: fertig" }),
	];
}

function messageFiles(): Record<string, string> {
	return {
		"aaa.json": JSON.stringify({ id: "aaa", recipient: CONV, sender: `${CONV}/task-6`, priority: "MESSAGE_PRIORITY_HIGH", timestamp: "2026-11-25T13:55:16Z", renderDetails: { messageTitle: "30s timer: Timer has expired" }, content: "Der Timer ist abgelaufen." }),
		"bbb.json": JSON.stringify({ id: "bbb", recipient: CONV, sender: `${CONV}/task-2`, priority: "MESSAGE_PRIORITY_HIGH", timestamp: "2026-11-25T13:55:26Z", renderDetails: { messageTitle: "Background sleep task finished" }, content: `Task id "${CONV}/task-2" finished with result:\nCommand exited with code 0.\n\nCommand output:\nfertig\r\n`, sourceMetadata: { tool: { toolCall: { id: "call_1719221803947476421", name: "run_command" } } } }),
		"read.json": JSON.stringify({ aaa: true, bbb: true }),
	};
}

function steps(lines: string[]): TranscriptStep[] {
	return lines.map(parseTranscriptLine).filter((step): step is TranscriptStep => step !== undefined);
}

const plainTheme: ThemeLike = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

describe("agy activity from local files", () => {
	it("parses steps, decodes tool arguments and skips broken lines", () => {
		const parsed = steps([...transcriptLines(), "{not json", ""]);
		assert.equal(parsed.length, 12);
		assert.deepEqual(parsed[1].toolCalls[0], {
			name: "run_command",
			args: { CommandLine: "sleep 60; echo fertig", WaitMsBeforeAsync: "500", toolSummary: "Background sleep task" },
		});
	});

	it("finds background tasks, their results and the turns agy took on its own", () => {
		const messages = Object.values(messageFiles())
			.map(parseTaskMessage)
			.filter((message) => message !== undefined);
		assert.equal(messages.length, 2, "read.json is no task message");
		const activity = deriveAgyActivity(steps(transcriptLines()), messages);

		assert.deepEqual(
			activity.tasks.map((task) => [task.taskId, task.kind, task.description, task.summary, task.timerSeconds, task.finished?.outcome, task.finished?.exitCode]),
			[
				["task-2", "command", "sleep 60; echo fertig", "Background sleep task", undefined, "ok", 0],
				["task-6", "timer", "Der Timer ist abgelaufen.", undefined, 30, "expired", undefined],
			],
		);
		assert.equal(activity.lastUserInputStep, 4);
		assert.deepEqual(
			activity.turns.map((turn) => [turn.startStep, turn.state, turn.triggers.map((t) => t.taskId), turn.texts]),
			[
				[8, "done", ["task-6"], ["Der 30-Sekunden-Timer ist abgelaufen."]],
				[10, "done", ["task-2"], ["Der Hintergrund-Task ist fertig. Ausgabe: fertig"]],
			],
		);
	});

	it("treats a task as running until its message arrives", () => {
		const activity = deriveAgyActivity(steps(transcriptLines().slice(0, 8)), []);
		assert.deepEqual(
			activity.tasks.map((task) => [task.taskId, task.finished]),
			[
				["task-2", undefined],
				["task-6", undefined],
			],
		);
		assert.deepEqual(activity.turns, []);
	});

	it("keeps an autonomous turn running until agy answers and marks a prompt as interruption", () => {
		const lines = transcriptLines().slice(0, 9);
		lines.push(
			JSON.stringify({ step_index: 9, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "", tool_calls: [{ name: "manage_task", args: { Action: "\"status\"", TaskId: `"${CONV}/task-2"` } }] }),
		);
		const running = deriveAgyActivity(steps(lines), []);
		assert.equal(running.turns.length, 1);
		assert.equal(running.turns[0].state, "running");
		assert.deepEqual(running.turns[0].actions, [{ name: "manage_task", summary: "status task-2" }]);

		lines.push(JSON.stringify({ step_index: 10, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "stand?" }));
		const interrupted = deriveAgyActivity(steps(lines), []);
		assert.equal(interrupted.turns[0].state, "interrupted");
		assert.equal(interrupted.turns[0].endStep, 9);
	});

	it("keeps a task running after a progress note and shows that note as trigger", () => {
		const lines = transcriptLines().slice(0, 4);
		lines.push(
			JSON.stringify({ step_index: 4, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-25T14:04:25Z", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-25T14:04:25Z sender=${CONV}/task-2 priority=MESSAGE_PRIORITY_HIGH content=Background command is still running after 600s: sleep 60; echo fertig\n</SYSTEM_MESSAGE>` }),
			JSON.stringify({ step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Läuft noch." }),
		);
		const progress = parseTaskMessage(
			JSON.stringify({ id: "ccc", sender: `${CONV}/task-2`, timestamp: "2026-11-25T14:04:25.150Z", renderDetails: { messageTitle: "Background sleep task: Notification timeout reached" }, content: "Background command is still running after 600s: sleep 60; echo fertig" }),
		);
		assert.ok(progress);
		assert.equal(progress.terminal, false);
		const activity = deriveAgyActivity(steps(lines), [progress]);
		assert.equal(activity.tasks[0].finished, undefined);
		assert.deepEqual(activity.turns[0].triggers, [
			{ taskId: "task-2", title: "Background sleep task: Notification timeout reached", outcome: "running", exitCode: undefined, kind: "command" },
		]);
	});

	it("names a subagent whose message woke agy up", () => {
		const sub = "9a9a9a9a-5555-6666-7777-888888888888";
		const lines = transcriptLines().slice(0, 4);
		lines.push(
			JSON.stringify({ step_index: 4, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-25T14:00:00Z", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-25T14:00:00Z sender=${sub} priority=MESSAGE_PRIORITY_HIGH content=Datei angelegt.\n</SYSTEM_MESSAGE>` }),
			JSON.stringify({ step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Der Subagent ist fertig." }),
		);
		const note = parseTaskMessage(JSON.stringify({ id: "ddd", sender: sub, timestamp: "2026-11-25T14:00:00.200Z", renderDetails: { messageTitle: "writer: Datei angelegt" }, content: "Datei angelegt." }));
		assert.ok(note);
		assert.equal(note.taskId, undefined);
		const turn = deriveAgyActivity(steps(lines), [note]).turns[0];
		assert.deepEqual(turn.triggers, [{ agentId: sub, title: "writer: Datei angelegt" }]);
		assert.equal(describeTrigger(turn.triggers[0], plainTheme), "✉ Subagent 9a9a9a9a · writer: Datei angelegt");
	});

	it("ignores reminders and messages that arrive inside a prompted turn", () => {
		const lines = [
			JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "los" }),
			JSON.stringify({ step_index: 1, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: "<SYSTEM_MESSAGE> Reminder: work efficiently. </SYSTEM_MESSAGE>" }),
			JSON.stringify({ step_index: 2, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=x sender=${CONV}/task-9 priority=MESSAGE_PRIORITY_LOW content=canceled\n</SYSTEM_MESSAGE>` }),
			JSON.stringify({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "fertig" }),
		];
		assert.deepEqual(deriveAgyActivity(steps(lines), []).turns, []);
	});

	it("reads the last visible log line through progress redraws and ANSI codes", () => {
		assert.equal(lastLogLine("Compiling a\r\nBuilding 1/6\r\u001b[32mBuilding 5/6\u001b[0m\r\n\r\n"), "Building 5/6");
		assert.equal(lastLogLine(""), undefined);
	});
});

describe("AgyActivityWatcher", () => {
	function writeBrain(dir: string, lines: string[], messages: Record<string, string>): void {
		fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
		fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
		fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
		fs.writeFileSync(path.join(dir, "logs", "transcript.jsonl"), lines.map((l) => `${l}\n`).join(""));
		for (const [name, json] of Object.entries(messages)) {
			fs.writeFileSync(path.join(dir, "messages", name), json);
		}
	}

	it("reports running tasks with their log tail, then each autonomous turn once", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-brain-"));
		try {
			const all = transcriptLines();
			writeBrain(dir, all.slice(0, 8), {});
			fs.writeFileSync(path.join(dir, "tasks", "task-2.log"), "step 1\r\nstep 2\r\n");
			const snapshots: ActivitySnapshot[] = [];
			const finished: AutonomousTurn[] = [];
			const now = Date.parse("2026-11-25T13:55:00Z");
			const watcher = new AgyActivityWatcher({
				agySessionId: CONV,
				systemDir: dir,
				isAlive: () => true,
				onSnapshot: (snapshot) => snapshots.push(snapshot),
				onTurnFinished: (turn) => finished.push(turn),
				now: () => now,
			});

			watcher.poll();
			const first = snapshots.at(-1);
			assert.ok(first);
			assert.deepEqual(first.tasks.map((task) => task.taskId), ["task-2", "task-6"]);
			assert.equal(first.logTails.get("task-2"), "step 2");
			assert.equal(watcher.findCommandTask("sleep 60; echo fertig")?.taskId, "task-2");
			assert.equal(watcher.latestTimer()?.taskId, "task-6");

			// agy appends the wake-ups; a partial last line is completed on the next poll.
			const rest = all.slice(8).map((l) => `${l}\n`).join("");
			const cut = rest.length - 10;
			fs.appendFileSync(path.join(dir, "logs", "transcript.jsonl"), rest.slice(0, cut));
			for (const [name, json] of Object.entries(messageFiles())) {
				fs.writeFileSync(path.join(dir, "messages", name), json);
			}
			watcher.poll();
			assert.deepEqual(finished.map((turn) => turn.startStep), [8]);
			fs.appendFileSync(path.join(dir, "logs", "transcript.jsonl"), rest.slice(cut));
			watcher.poll();
			watcher.poll();
			assert.deepEqual(finished.map((turn) => turn.startStep), [8, 10]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not replay turns from before it started or turns the session already has", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-brain-"));
		try {
			const lines = transcriptLines();
			// A later prompt: both earlier autonomous turns happened before the watcher.
			lines.push(JSON.stringify({ step_index: 12, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "weiter" }));
			writeBrain(dir, lines, messageFiles());
			const finished: number[] = [];
			const watcher = new AgyActivityWatcher({
				agySessionId: CONV,
				systemDir: dir,
				isAlive: () => true,
				onSnapshot: () => {},
				onTurnFinished: (turn) => finished.push(turn.startStep),
				alreadyRecorded: (step) => step === 15,
			});
			watcher.poll();
			assert.deepEqual(finished, []);

			fs.appendFileSync(
				path.join(dir, "logs", "transcript.jsonl"),
				[
					JSON.stringify({ step_index: 13, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "ok" }),
					JSON.stringify({ step_index: 15, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: `[Message] timestamp=x sender=${CONV}/task-14 priority=HIGH content=done` }),
					JSON.stringify({ step_index: 16, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "schon gezeigt" }),
				]
					.map((l) => `${l}\n`)
					.join(""),
			);
			watcher.poll();
			assert.deepEqual(finished, [], "a turn already recorded in the session is not added again");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("hides running tasks once agy's process is gone", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-brain-"));
		try {
			writeBrain(dir, transcriptLines().slice(0, 8), {});
			const snapshots: ActivitySnapshot[] = [];
			const watcher = new AgyActivityWatcher({
				agySessionId: CONV,
				systemDir: dir,
				isAlive: () => false,
				onSnapshot: (snapshot) => snapshots.push(snapshot),
				onTurnFinished: () => {},
			});
			watcher.poll();
			assert.deepEqual(snapshots.at(-1)?.tasks ?? [], []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("background activity display", () => {
	it("renders the widget lines for a running command, a timer and an autonomous turn", () => {
		const now = Date.parse("2026-11-25T13:55:05Z");
		const activity = deriveAgyActivity(steps(transcriptLines().slice(0, 8)), []);
		const lines = renderActivityLines(
			{
				agySessionId: CONV,
				tasks: activity.tasks,
				logTails: new Map([["task-2", "step 2"]]),
				runningTurn: { startStep: 9, startedAtMs: now - 3_000, state: "running", triggers: [], actions: [{ name: "manage_task", summary: "" }], texts: [] },
			},
			now,
			0,
			plainTheme,
		);
		assert.deepEqual(lines, [
			"Antigravity · 2 Hintergrund-Tasks",
			" ⠋ task-2  Background sleep task  0:40  step 2",
			" ⠋ task-6  Timer 30 s  0:19  noch 11 s",
			" ⠋ arbeitet selbstständig  0:03  1 Tool-Aufruf",
		]);
	});

	it("shows what agy streams on its own, until it goes quiet", () => {
		const now = Date.parse("2026-11-25T13:55:05Z");
		const base = { agySessionId: CONV, tasks: [], logTails: new Map<string, string>() };
		const live = { startedAtMs: now - 4_000, lastAtMs: now - 500, text: "Erste Zeile\nDer Timer ist abgelaufen.", toolCalls: 1, thinking: false };
		assert.deepEqual(renderActivityLines({ ...base, live }, now, 1, plainTheme), [
			"Antigravity",
			" ⠙ arbeitet selbstständig  0:04  1 Tool-Aufruf  Der Timer ist abgelaufen.",
		]);
		assert.match(renderActivityLines({ ...base, live: { ...live, tool: "Run manage_task" } }, now, 1, plainTheme)[1], /→ Run manage_task$/);
		assert.deepEqual(renderActivityLines({ ...base, live: { ...live, lastAtMs: now - LIVE_STALE_MS - 1 } }, now, 1, plainTheme), []);
	});

	it("renders an autonomous card with trigger, answer and collapsed tool calls", () => {
		const messages = Object.values(messageFiles())
			.map(parseTaskMessage)
			.filter((message) => message !== undefined);
		const turn = deriveAgyActivity(steps(transcriptLines()), messages).turns[1];
		const data = toAutonomousEntryData(CONV, { ...turn, actions: [{ name: "run_command", summary: "echo hi" }] });
		const collapsed = renderAutonomousEntry(data, false, plainTheme, (text) => new Text(text, 0, 0)).render(80).join("\n");
		assert.match(collapsed, /Antigravity · selbstständig/);
		assert.match(collapsed, /✓ task-2 · Background sleep task finished \(Exit 0\)/);
		assert.match(collapsed, /Ausgabe: fertig/);
		assert.match(collapsed, /1 Tool-Aufruf/);
		assert.doesNotMatch(collapsed, /echo hi/);
		const expanded = renderAutonomousEntry(data, true, plainTheme, (text) => new Text(text, 0, 0)).render(80).join("\n");
		assert.match(expanded, /→ run_command echo hi/);
	});
});

describe("mirror tool cards for agy's own tools", () => {
	it("shows schedule and manage_task as agy tools, not shell commands", () => {
		assert.deepEqual(classifyAgyToolCall({ title: "Run schedule", kind: "other" }), {
			mirrorToolName: "agy_tool",
			arguments: { title: "Run schedule", kind: "other", tool: "schedule" },
		});
		assert.equal(classifyAgyToolCall({ title: "Run manage_task", kind: "other" }).mirrorToolName, "agy_tool");
		assert.equal(
			classifyAgyToolCall({ title: "sleep 60", kind: "execute", rawInput: { CommandLine: "sleep 60" } }).mirrorToolName,
			"agy_bash",
		);
	});

	it("explains a call that agy finished without output", async () => {
		const broker = new AgyTurnMirrorBroker();
		const seen: unknown[] = [];
		broker.setEmptyResultNote((context) => {
			seen.push(context);
			return context.command ? "⏳ Läuft im Hintergrund als task-2." : undefined;
		});
		broker.registerOrUpdateCall(CONV, {
			toolCallId: "call_1",
			title: "sleep 60; echo fertig",
			kind: "execute",
			rawInput: { CommandLine: "sleep 60; echo fertig" },
			status: "completed",
		});
		assert.equal(broker.isTracking("call_1"), true);
		const result = await broker.executeMirrorCall("call_1", undefined, undefined, interactiveContext(os.tmpdir()));
		assert.deepEqual(result.content, [{ type: "text", text: "⏳ Läuft im Hintergrund als task-2." }]);
		assert.deepEqual(seen, [
			{ agySessionId: CONV, kind: "execute", title: "sleep 60; echo fertig", command: "sleep 60; echo fertig", toolName: undefined },
		]);
		assert.equal(broker.isTracking("call_1"), false);
	});
});
