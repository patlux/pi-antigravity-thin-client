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
	deriveSubagentStatus,
	firstLine,
	formatDuration,
	lastLogLine,
	parseDurationSeconds,
	parseSubagentRecord,
	parseTaskMessage,
	parseTranscriptLine,
	splitAgyModel,
	type TranscriptStep,
} from "../src/background/agy-activity.ts";
import { AgyTurnMirrorBroker, classifyAgyToolCall } from "../src/tools/agy-mirror-tools.ts";
import {
	describeTrigger,
	LIVE_STALE_MS,
	formatAgyModel,
	senderRole,
	setAgyModelNames,
	subagentStartNote,
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
		const note = parseTaskMessage(JSON.stringify({ id: "ddd", sender: sub, timestamp: "2026-11-25T14:00:00.200Z", renderDetails: { messageTitle: "Message from File Creator Subagent (self)" }, content: "Die Datei wurde angelegt.\nDetails folgen." }));
		assert.ok(note);
		assert.equal(note.taskId, undefined);
		const turn = deriveAgyActivity(steps(lines), [note]).turns[0];
		assert.deepEqual(turn.triggers, [{ agentId: sub, title: "Message from File Creator Subagent (self)", preview: "Die Datei wurde angelegt." }]);
		assert.equal(describeTrigger(turn.triggers[0], plainTheme), "✉ File Creator Subagent 9a9a9a9a: Die Datei wurde angelegt.");
		assert.equal(senderRole("Message from Reviewer"), "Reviewer");
		assert.equal(senderRole("something else"), undefined);
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

	it("turns the first line of an answer into plain text", () => {
		assert.equal(
			firstLine("\n Die Datei [/tmp/a.txt](file:///tmp/a.txt) enthält `hallo`.\nmehr"),
			"Die Datei /tmp/a.txt enthält hallo.",
		);
		assert.equal(firstLine("x".repeat(200), 10), `${"x".repeat(9)}…`);
	});

	it("reads the last visible log line through progress redraws and ANSI codes", () => {
		assert.equal(lastLogLine("Compiling a\r\nBuilding 1/6\r\u001b[32mBuilding 5/6\u001b[0m\r\n\r\n"), "Building 5/6");
		assert.equal(lastLogLine(""), undefined);
	});

	it("parses multi-unit timer durations and formats them compactly", () => {
		assert.equal(parseDurationSeconds("30s"), 30);
		assert.equal(parseDurationSeconds("35m"), 2100);
		assert.equal(parseDurationSeconds("2m 30s"), 150);
		assert.equal(parseDurationSeconds("1h 5m 10s"), 3910);
		assert.equal(parseDurationSeconds("1d 2h"), 93_600);
		assert.equal(parseDurationSeconds("30s extra"), undefined);
		assert.equal(parseDurationSeconds(""), undefined);

		assert.equal(formatDuration(30), "30 s");
		assert.equal(formatDuration(150), "2m 30s");
		assert.equal(formatDuration(2100), "35m");
		assert.equal(formatDuration(3910), "1h 5m 10s");

		const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
		const lines = [
			line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T12:04:03Z", tool_calls: [{ name: "schedule", args: { DurationSeconds: "2100", Prompt: "\"Check probe progress, download results.\"" } }] }),
			line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T12:04:19Z", content: `Created At: 2026-11-26T13:04:19+01:00\nTool is running as a background task with task id: ${CONV}/task-2\nTask Description: Timer: 35m, Prompt: Check probe progress, download results.\nTask logs are available at: file://${BRAIN}/${CONV}/.system_generated/tasks/task-2.log` }),
			line({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T12:05:00Z", tool_calls: [{ name: "schedule", args: { DurationSeconds: "150", Prompt: "\"Check VM start\"" } }] }),
			line({ step_index: 4, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T12:05:02Z", content: `Created At: 2026-11-26T13:05:02+01:00\nTool is running as a background task with task id: ${CONV}/task-4\nTask Description: Timer: 2m 30s, Prompt: Check VM start\nTask logs are available at: file://${BRAIN}/${CONV}/.system_generated/tasks/task-4.log` }),
		];
		const activity = deriveAgyActivity(steps(lines), []);
		assert.deepEqual(
			activity.tasks.map((task) => [task.taskId, task.kind, task.timerSeconds, task.description]),
			[
				["task-2", "timer", 2100, "Check probe progress, download results."],
				["task-4", "timer", 150, "Check VM start"],
			],
		);
	});

	it("marks a timer finished when manage_task kill cancels it without a message file", () => {
		const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
		const lines = [
			line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T12:04:03Z", tool_calls: [{ name: "schedule", args: { DurationSeconds: "2100", Prompt: "\"Check probe progress\"" } }] }),
			line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T12:04:19Z", content: `Created At: 2026-11-26T13:04:19+01:00\nTool is running as a background task with task id: ${CONV}/task-2\nTask Description: Timer: 35m, Prompt: Check probe progress\nTask logs are available at: file://${BRAIN}/${CONV}/.system_generated/tasks/task-2.log` }),
			line({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T12:27:26Z", tool_calls: [{ name: "manage_task", args: { Action: "\"kill\"", TaskId: `"${CONV}/task-2"` } }, { name: "run_command", args: { CommandLine: "\"sleep 60\"", toolSummary: "\"Restart job\"" } }] }),
			line({ step_index: 4, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T12:27:38Z", content: `Created At: 2026-11-26T13:27:38+01:00\nCompleted At: 2026-11-26T13:27:50+01:00\nTask "${CONV}/task-2" cancelled.` }),
			line({ step_index: 5, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T12:27:48Z", content: `Created At: 2026-11-26T13:27:48+01:00\nTool is running as a background task with task id: ${CONV}/task-5\nTask Description: sleep 60\nTask logs are available at: file://${BRAIN}/${CONV}/.system_generated/tasks/task-5.log` }),
		];
		const activity = deriveAgyActivity(steps(lines), []);
		assert.equal(activity.tasks[0].kind, "timer");
		assert.deepEqual(activity.tasks[0].finished, {
			outcome: "canceled",
			exitCode: undefined,
			atMs: Date.parse("2026-11-26T13:27:50+01:00"),
		});
		assert.equal(activity.tasks[1].taskId, "task-5");
		assert.equal(activity.tasks[1].finished, undefined);
	});

	it("reconciles finished tasks from manage_task status, kill errors and list", () => {
		const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
		const lines = [
			line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:00Z", tool_calls: [{ name: "run_command", args: { CommandLine: "\"job-a\"" } }, { name: "run_command", args: { CommandLine: "\"job-b\"" } }, { name: "run_command", args: { CommandLine: "\"job-c\"" } }] }),
			line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:01Z", content: `Tool is running as a background task with task id: ${CONV}/task-2\nTask Description: job-a` }),
			line({ step_index: 3, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:01Z", content: `Tool is running as a background task with task id: ${CONV}/task-3\nTask Description: job-b` }),
			line({ step_index: 4, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:01Z", content: `Tool is running as a background task with task id: ${CONV}/task-4\nTask Description: job-c` }),
			// A plain run_command outputting the list text must not clear running tasks.
			line({ step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:05Z", tool_calls: [{ name: "run_command", args: { CommandLine: "\"echo No background tasks are currently running.\"" } }] }),
			line({ step_index: 6, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T10:00:05Z", content: "No background tasks are currently running." }),
			// manage_task status DONE finishes task-2, while RUNNING leaves task-3 open.
			line({ step_index: 7, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:01:00Z", tool_calls: [{ name: "manage_task", args: { Action: "\"status\"", TaskId: `"${CONV}/task-2"` } }, { name: "manage_task", args: { Action: "\"status\"", TaskId: `"${CONV}/task-3"` } }] }),
			line({ step_index: 8, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T10:01:01Z", content: `Task: ${CONV}/task-2\nStatus: DONE\nLog: file:///x` }),
			line({ step_index: 9, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T10:01:01Z", content: `Task: ${CONV}/task-3\nStatus: RUNNING\nLog: file:///x` }),
			// manage_task kill on an already-finished task marks task-3 finished.
			line({ step_index: 10, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:02:00Z", tool_calls: [{ name: "manage_task", args: { Action: "\"kill\"", TaskId: `"${CONV}/task-3"` } }] }),
			line({ step_index: 11, source: "MODEL", type: "GENERIC", status: "ERROR", created_at: "2026-11-26T10:02:01Z", content: `Encountered error in step execution: cannot kill task "${CONV}/task-3": task is not running (status: DONE)` }),
		];
		const mid = deriveAgyActivity(steps(lines), []);
		assert.equal(mid.tasks[0].finished?.outcome, "ok");
		assert.equal(mid.tasks[1].finished?.outcome, "ok");
		assert.equal(mid.tasks[2].finished, undefined);

		// manage_task list returning empty clears earlier task-4, but not task-13 started in the same planner turn.
		lines.push(
			line({ step_index: 12, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:03:00Z", tool_calls: [{ name: "manage_task", args: { Action: "\"list\"" } }, { name: "run_command", args: { CommandLine: "\"job-d\"" } }] }),
			line({ step_index: 13, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:03:01Z", content: `Tool is running as a background task with task id: ${CONV}/task-13\nTask Description: job-d` }),
			line({ step_index: 14, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T10:03:02Z", content: "Created At: 2026-11-26T10:03:01Z\nCompleted At: 2026-11-26T10:03:02Z\nNo background tasks are currently running." }),
		);
		const afterList = deriveAgyActivity(steps(lines), []);
		assert.equal(afterList.tasks[2].finished?.outcome, "ok");
		assert.equal(afterList.tasks[3].taskId, "task-13");
		assert.equal(afterList.tasks[3].finished, undefined);

		// A truncated list JSON must be ignored rather than dropping running tasks.
		lines.push(
			line({ step_index: 15, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:04:00Z", tool_calls: [{ name: "manage_task", args: { Action: "\"list\"" } }] }),
			line({ step_index: 16, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T10:04:01Z", content: `You have 1 background task(s) currently running:\n[{"taskId":"${CONV}/task-13","description":"trun` }),
		);
		assert.equal(deriveAgyActivity(steps(lines), []).tasks[3].finished, undefined);
	});

	it("marks a conditional timer canceled early when a matching message arrives", () => {
		const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
		const lines = [
			line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:00Z", tool_calls: [{ name: "run_command", args: { CommandLine: "\"build\"" } }] }),
			line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:01Z", content: `Tool is running as a background task with task id: ${CONV}/task-2\nTask Description: build` }),
			line({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:02Z", tool_calls: [{ name: "schedule", args: { DurationSeconds: "240", Prompt: "\"Check build\"", TimerCondition: `"${CONV}/task-2"` } }] }),
			line({ step_index: 4, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:03Z", content: `Tool is running as a background task with task id: ${CONV}/task-4\nTask Description: Timer: 4m, Prompt: Check build` }),
			// User prompts do not cancel TimerCondition timers.
			line({ step_index: 5, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-26T10:00:30Z", content: "status?" }),
		];
		assert.equal(deriveAgyActivity(steps(lines), []).tasks[1].finished, undefined);

		// A message from task-2 cancels task-4 early.
		lines.push(
			line({ step_index: 6, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-26T10:01:00Z", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T10:01:00Z sender=${CONV}/task-2 priority=MESSAGE_PRIORITY_HIGH content=Task id "${CONV}/task-2" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>` }),
		);
		const after = deriveAgyActivity(steps(lines), []);
		assert.equal(after.tasks[0].finished?.outcome, "ok");
		assert.equal(after.tasks[1].finished?.outcome, "canceled");
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

	it("takes agy's answer whole from transcript_full.jsonl, not cut from transcript.jsonl", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-brain-"));
		try {
			const answer = `Alle Punkte sind umgesetzt.\n\n${"- Prüfung & Rollout: ok\n".repeat(300)}Ende der Antwort.`;
			const cut = `${answer.slice(0, 2000)}\n<truncated ${answer.length - 4000} bytes>\n${answer.slice(-2000)}`;
			const all = transcriptLines();
			const last = (content: string, truncated: boolean) =>
				JSON.stringify({ step_index: 11, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T13:55:26Z", content, ...(truncated ? { truncated_fields: ["content"] } : {}) });
			// As agy writes them: the short transcript first, the full one a moment later.
			writeBrain(dir, [...all.slice(0, 11), last(cut, true)], messageFiles());
			const finished: AutonomousTurn[] = [];
			const watcher = new AgyActivityWatcher({
				agySessionId: CONV,
				systemDir: dir,
				isAlive: () => true,
				onSnapshot: () => {},
				onTurnFinished: (turn) => finished.push(turn),
			});
			// Falls back to transcript.jsonl while transcript_full.jsonl is missing.
			assert.equal(watcher.refresh().turns.at(-1)?.texts[0], cut);

			fs.writeFileSync(
				path.join(dir, "logs", "transcript_full.jsonl"),
				[...all.slice(0, 11), last(answer, false)].map((l) => `${l}\n`).join(""),
			);
			const turn = watcher.refresh().turns.at(-1);
			assert.equal(turn?.texts[0], answer);
			assert.doesNotMatch(turn?.texts[0] ?? "", /<truncated \d+ bytes>/);
			assert.deepEqual(watcher.refresh().turns.map((t) => t.startStep), [8, 10], "switching files keeps each turn once");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("hides a killed timer after the linger window even without a message file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-brain-"));
		try {
			const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
			const lines = [
				line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T12:04:03Z", tool_calls: [{ name: "schedule", args: { DurationSeconds: "2100", Prompt: "\"Check job\"" } }] }),
				line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T12:04:19Z", content: `Created At: 2026-11-26T13:04:19+01:00\nTool is running as a background task with task id: ${CONV}/task-2\nTask Description: Timer: 35m, Prompt: Check job` }),
				line({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T12:27:26Z", tool_calls: [{ name: "manage_task", args: { Action: "\"kill\"", TaskId: `"${CONV}/task-2"` } }] }),
				line({ step_index: 4, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T12:27:38Z", content: `Created At: 2026-11-26T13:27:38+01:00\nCompleted At: 2026-11-26T13:27:50+01:00\nTask "${CONV}/task-2" cancelled.` }),
			];
			writeBrain(dir, lines, {});
			let now = Date.parse("2026-11-26T13:27:53+01:00");
			const snapshots: ActivitySnapshot[] = [];
			const watcher = new AgyActivityWatcher({
				agySessionId: CONV,
				systemDir: dir,
				isAlive: () => true,
				onSnapshot: (snapshot) => snapshots.push(snapshot),
				onTurnFinished: () => {},
				now: () => now,
			});
			watcher.poll();
			assert.deepEqual(snapshots.at(-1)?.tasks.map((t) => [t.taskId, t.finished?.outcome]), [["task-2", "canceled"]]);
			now = Date.parse("2026-11-26T13:28:05+01:00");
			watcher.poll();
			assert.deepEqual(snapshots.at(-1)?.tasks, []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Parent and subagent files as agy 1.5.13 wrote them for the subagent test prompt (abridged). */
const SUB = "0db6b1dc-5462-49b5-b08c-c41c13d5d95b";
function parentSpawnLines(): string[] {
	const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
	return [
		line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T14:45:40Z", content: "<USER_REQUEST>starte bitte einen subagent …</USER_REQUEST>" }),
		line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T14:46:04Z", model: "gemini-4-neon-high", tool_calls: [{ name: "invoke_subagent", args: { Prompt: "\"Lege die Datei `/tmp/agy-test/hallo.txt` mit dem Inhalt `hallo` an.\"", Role: "\"File Creator Subagent\"", TypeName: "\"self\"" } }] }),
		line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-25T14:46:07Z", content: `Created the following subagent:\n{\n  "conversationId":  "${SUB}"\n}` }),
		line({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T14:46:08Z", model: "gemini-4-neon-high", content: "Der Subagent wurde gestartet." }),
	];
}
function subagentLines(): string[] {
	const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
	return [
		line({ step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-25T14:46:28Z", content: `[Message] timestamp=2026-11-25T14:46:08Z sender=${CONV} priority=MESSAGE_PRIORITY_HIGH content=Lege die Datei an.` }),
		line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T14:46:28Z", model: "gemini-4-neon-high", tool_calls: [{ name: "write_file", args: { Content: "\"hallo\"", Overwrite: "true", Path: "\"/tmp/agy-test/hallo.txt\"" } }] }),
		line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-25T14:46:34Z", content: "Created file" }),
		line({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T14:46:35Z", model: "gemini-4-neon-high", tool_calls: [{ name: "send_message", args: { Message: "\"Die Datei wurde angelegt.\"", Recipient: `"${CONV}"` } }] }),
		line({ step_index: 4, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-25T14:46:39Z", content: "Message sent" }),
		line({ step_index: 5, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-25T14:46:41Z", content: "<SYSTEM_MESSAGE> Reminder </SYSTEM_MESSAGE>" }),
		line({ step_index: 6, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T14:46:41Z", model: "gemini-4-neon-high", content: "Die Datei wurde angelegt und der Parent-Agent benachrichtigt." }),
	];
}
const SUB_RECORD = JSON.stringify({ conversationId: SUB, subagentDescriptor: { typeName: "self", role: "File Creator Subagent" }, state: "SUBAGENT_STATE_ALIVE", spawnStepIndex: 2, workspaceUris: ["file:///tmp/agy-test"] });

describe("agy subagents", () => {
	it("reads the subagent record agy keeps next to the parent", () => {
		assert.deepEqual(parseSubagentRecord(SUB_RECORD), {
			conversationId: SUB,
			role: "File Creator Subagent",
			typeName: "self",
			state: "SUBAGENT_STATE_ALIVE",
			spawnStepIndex: 2,
		});
		assert.equal(parseSubagentRecord("{}"), undefined);
	});

	it("tells what a subagent runs: its model, task and current tool, then its answer", () => {
		const record = parseSubagentRecord(SUB_RECORD);
		assert.ok(record);
		const parent = steps(parentSpawnLines());
		const working = deriveSubagentStatus(record, steps(subagentLines().slice(0, 2)), parent);
		assert.equal(working.state, "working");
		assert.equal(working.activity, "→ write_file /tmp/agy-test/hallo.txt");
		assert.equal(working.model, "gemini-4-neon-high");
		assert.equal(working.prompt, "Lege die Datei `/tmp/agy-test/hallo.txt` mit dem Inhalt `hallo` an.");
		assert.equal(working.typeName, "self");

		assert.equal(deriveSubagentStatus(record, steps(subagentLines().slice(0, 3)), parent).activity, "→ write_file /tmp/agy-test/hallo.txt");
		assert.equal(deriveSubagentStatus(record, steps(subagentLines().slice(0, 6)), parent).activity, "thinking …");
		const starting = deriveSubagentStatus(record, [], parent);
		assert.equal(starting.activity, "starting …");
		// A `self` subagent runs on the parent's model and reasoning level until it answers.
		assert.deepEqual([starting.model, starting.modelFromParent], ["gemini-4-neon-high", true]);

		const done = deriveSubagentStatus(record, steps(subagentLines()), parent);
		assert.equal(done.state, "idle");
		assert.equal(done.activity, "Die Datei wurde angelegt und der Parent-Agent benachrichtigt.");
		assert.equal(done.toolCalls, 2);
		assert.equal(done.lastAtMs, Date.parse("2026-11-25T14:46:41Z"));

		const killed = deriveSubagentStatus({ ...record, state: "SUBAGENT_STATE_KILLED" }, steps(subagentLines().slice(0, 2)), parent);
		assert.equal(killed.state, "killed");
	});

	it("shows a subagent that waits for its own timer as waiting, not as done", () => {
		const record = parseSubagentRecord(SUB_RECORD);
		assert.ok(record);
		const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
		const own = [
			...subagentLines().slice(0, 3),
			line({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T15:01:44Z", tool_calls: [{ name: "schedule", args: { DurationSeconds: "10" } }] }),
			line({ step_index: 4, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-25T15:01:48Z", content: `Tool is running as a background task with task id: ${SUB}/task-4\nTask Description: Timer: 10s, Prompt: weiter\nTask logs are available at: file:///x` }),
			line({ step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T15:01:48Z", content: "Warte auf den 10-Sekunden-Timer." }),
		];
		const waiting = deriveSubagentStatus(record, steps(own), []);
		assert.deepEqual([waiting.state, waiting.activity], ["working", "waiting for timer 10 s"]);
		// agy writes the answer that ends the turn later; the timer already counts.
		const lagging = [...own.slice(0, 5), line({ step_index: 6, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-25T15:01:48Z", content: "<SYSTEM_MESSAGE> Reminder </SYSTEM_MESSAGE>" })];
		assert.equal(deriveSubagentStatus(record, steps(lagging), []).activity, "waiting for timer 10 s");
		const expired = parseTaskMessage(JSON.stringify({ id: "t", sender: `${SUB}/task-4`, timestamp: "2026-11-25T15:01:58Z", renderDetails: { messageTitle: "10s timer: Timer has expired" }, content: "weiter" }));
		assert.ok(expired);
		assert.equal(deriveSubagentStatus(record, steps(own), [], [expired]).state, "idle");
		const canceled = [
			...own,
			line({ step_index: 6, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T15:01:50Z", tool_calls: [{ name: "manage_task", args: { Action: "\"kill\"", TaskId: `"${SUB}/task-4"` } }] }),
			line({ step_index: 7, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-25T15:01:51Z", content: `Task "${SUB}/task-4" cancelled.` }),
			line({ step_index: 8, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T15:01:52Z", content: "Timer abgebrochen." }),
		];
		assert.equal(deriveSubagentStatus(record, steps(canceled), []).state, "idle");
	});

	it("writes the invoke_subagent card: who, which model, which task", () => {
		const args = { agentRole: "File Creator Subagent", agentType: "self", prompt: "Lege die Datei an.\nDanach melden." };
		assert.equal(
			subagentStartNote(args, undefined),
			"🤖 Subagent \"File Creator Subagent\" started · same model as the main agent\nThe Antigravity panel above the editor shows what it is doing.\n\nTask:\nLege die Datei an.\nDanach melden.",
		);
		const record = parseSubagentRecord(SUB_RECORD);
		assert.ok(record);
		const started = deriveSubagentStatus(record, steps(subagentLines().slice(0, 2)), steps(parentSpawnLines()));
		assert.match(subagentStartNote(args, started), /^🤖 Subagent "File Creator Subagent" started · 0db6b1dc · Gemini 4 Neon · Reasoning high\n/);
		assert.match(subagentStartNote({ agentRole: "x", model: "flash" }, undefined), /^🤖 Subagent "x" started · flash \(requested\)\n/);
		assert.match(subagentStartNote({ agentRole: "a, b", agentCount: 2 }, undefined), /^🤖 2 subagents \(a, b\) started\n/);
	});

	it("follows the subagents of the watched conversation and shows them in the widget", () => {
		const brain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-brain-sub-"));
		try {
			const parentDir = path.join(brain, CONV, ".system_generated");
			const childDir = path.join(brain, SUB, ".system_generated");
			fs.mkdirSync(path.join(parentDir, "logs"), { recursive: true });
			fs.mkdirSync(path.join(parentDir, "subagents"), { recursive: true });
			fs.mkdirSync(path.join(childDir, "logs"), { recursive: true });
			fs.writeFileSync(path.join(parentDir, "logs", "transcript.jsonl"), parentSpawnLines().map((l) => `${l}\n`).join(""));
			fs.writeFileSync(path.join(parentDir, "subagents", `${SUB}.json`), SUB_RECORD);
			fs.writeFileSync(path.join(childDir, "logs", "transcript.jsonl"), subagentLines().slice(0, 2).map((l) => `${l}\n`).join(""));

			const snapshots: ActivitySnapshot[] = [];
			const watcher = new AgyActivityWatcher({
				agySessionId: CONV,
				systemDir: parentDir,
				isAlive: () => true,
				onSnapshot: (snapshot) => snapshots.push(snapshot),
				onTurnFinished: () => {},
				now: () => Date.parse("2026-11-25T14:46:30Z"),
			});
			watcher.poll();
			const snapshot = snapshots.at(-1);
			assert.ok(snapshot);
			assert.deepEqual(snapshot.subagents?.map((status) => [status.role, status.state, status.activity]), [
				["File Creator Subagent", "working", "→ write_file /tmp/agy-test/hallo.txt"],
			]);
			assert.equal(watcher.findSubagent("File Creator Subagent")?.conversationId, SUB);

			const lines = renderActivityLines(snapshot, Date.parse("2026-11-25T14:46:30Z"), 0, plainTheme);
			assert.deepEqual(lines, [
				"Antigravity · 1 subagent",
				" ⠋ 0db6b1dc  File Creator Subagent  0:02  Gemini 4 Neon · Reasoning high  → write_file /tmp/agy-test/hallo.txt",
			]);

			fs.appendFileSync(path.join(childDir, "logs", "transcript.jsonl"), subagentLines().slice(2).map((l) => `${l}\n`).join(""));
			watcher.poll();
			const idle = snapshots.at(-1)?.subagents?.[0];
			assert.equal(idle?.state, "idle");
			assert.match(
				renderActivityLines({ ...snapshot, subagents: idle ? [idle] : [] }, Date.parse("2026-11-25T14:46:43Z"), 0, plainTheme)[1],
				/✓ 0db6b1dc {2}File Creator Subagent {2}0:13 {2}Gemini 4 Neon · Reasoning high {2}done: Die Datei wurde angelegt/,
			);
		} finally {
			fs.rmSync(brain, { recursive: true, force: true });
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
			"Antigravity · 2 background tasks",
			" ⠋ task-2  Background sleep task  0:40  step 2",
			" ⠋ task-6  Timer 30 s  0:19  11 s left",
			" ⠋ working on its own  0:03  1 tool call",
		]);
		const longTimerNow = Date.parse("2026-11-26T12:04:38Z");
		const longTimerLines = renderActivityLines(
			{
				agySessionId: CONV,
				tasks: [
					{ taskId: "task-456", stepIndex: 456, kind: "timer", description: "Check job progress", timerSeconds: 2100, startedAtMs: Date.parse("2026-11-26T12:04:19Z") },
					{ taskId: "task-457", stepIndex: 457, kind: "timer", description: "Check job progress", timerSeconds: 2100, startedAtMs: Date.parse("2026-11-26T12:04:19Z"), finished: { outcome: "canceled", atMs: longTimerNow } },
				],
				logTails: new Map(),
			},
			longTimerNow,
			0,
			plainTheme,
		);
		assert.deepEqual(longTimerLines, [
			"Antigravity · 1 background task",
			" ⠋ task-456  Timer 35m  0:19  34m 41s left",
			" ⊘ task-457  Timer 35m  0:19  canceled",
		]);
	});

	it("shows what agy streams on its own, until it goes quiet", () => {
		const now = Date.parse("2026-11-25T13:55:05Z");
		const base = { agySessionId: CONV, tasks: [], logTails: new Map<string, string>() };
		const live = { startedAtMs: now - 4_000, lastAtMs: now - 500, text: "Erste Zeile\nDer Timer ist abgelaufen.", toolCalls: 1, thinking: false };
		assert.deepEqual(renderActivityLines({ ...base, live }, now, 1, plainTheme), [
			"Antigravity",
			" ⠙ working on its own  0:04  1 tool call  Der Timer ist abgelaufen.",
		]);
		assert.match(renderActivityLines({ ...base, live: { ...live, tool: "Run manage_task" } }, now, 1, plainTheme)[1], /→ Run manage_task$/);
		assert.deepEqual(renderActivityLines({ ...base, live: { ...live, lastAtMs: now - LIVE_STALE_MS - 1 } }, now, 1, plainTheme), []);
	});

	it("keeps every widget line on one terminal row when agy runs a multi-line command", () => {
		// agy's ACP title of a run_command is the whole command line, newlines included
		// (seen live on 2026-11-25: a heredoc with `lsof -iTCP:9222` and `PID_BEFORE=$(…)`).
		// A line break inside one widget line puts Pi's row count off, and parts of the
		// command stay on the editor border.
		const now = Date.parse("2026-11-25T13:55:05Z");
		const command = 'echo "=== BEFORE ==="\nlsof -nP -a -iTCP:9222 -sTCP:LISTEN\r\nPID_BEFORE=$(lsof -t -a -iTCP:9222 -sTCP:LISTEN)\tdone';
		const lines = renderActivityLines(
			{
				agySessionId: CONV,
				tasks: [{ taskId: "task-7", kind: "command", description: "Check the port\nand the PID", stepIndex: 1, startedAtMs: now - 2_000 }],
				logTails: new Map([["task-7", "=== BEFORE ===\nCOMMAND PID"]]),
				live: { startedAtMs: now - 4_000, lastAtMs: now - 500, text: "", toolCalls: 1, thinking: false, tool: command },
			},
			now,
			0,
			plainTheme,
		);
		for (const line of lines) assert.doesNotMatch(line, /[\r\n\t]/, JSON.stringify(line));
		assert.match(lines.at(-1) ?? "", /→ echo "=== BEFORE ===" lsof -nP -a -iTCP:9222 -sTCP:LISTEN PID_BEFORE=\$\(lsof -t -a -iTCP:9222 -sTCP:LISTEN\) done$/);
		assert.match(lines[1], /Check the port and the PID .*=== BEFORE === COMMAND PID$/);
	});

	it("names model and reasoning level", () => {
		assert.deepEqual(splitAgyModel("gemini-4-neon-xhigh"), { baseId: "gemini-4-neon", reasoning: "xhigh" });
		assert.deepEqual(splitAgyModel("gemini-3.8-flash-low"), { baseId: "gemini-3.8-flash", reasoning: "low" });
		assert.deepEqual(splitAgyModel("gemini-pro-orchestrator"), { baseId: "gemini-pro-orchestrator" });
		assert.equal(formatAgyModel("gemini-3.8-flash-low"), "Gemini 3.8 Flash · Reasoning low");
		setAgyModelNames((baseId) => (baseId === "gemini-pro-orchestrator-neon" ? "Orchestrator (Neon)" : undefined));
		try {
			assert.equal(formatAgyModel("gemini-pro-orchestrator-neon"), "Orchestrator (Neon)");
		} finally {
			setAgyModelNames(() => undefined);
		}
		assert.equal(formatAgyModel(undefined), undefined);
	});

	it("renders an autonomous card with trigger, answer and collapsed tool calls", () => {
		const messages = Object.values(messageFiles())
			.map(parseTaskMessage)
			.filter((message) => message !== undefined);
		const turn = deriveAgyActivity(steps(transcriptLines()), messages).turns[1];
		const data = toAutonomousEntryData(CONV, { ...turn, model: "gemini-4-neon-xhigh", actions: [{ name: "run_command", summary: "echo hi" }] });
		const collapsed = renderAutonomousEntry(data, false, plainTheme, (text) => new Text(text, 0, 0)).render(120).join("\n");
		assert.match(collapsed, /Antigravity · on its own · \d\d:\d\d:\d\d · Gemini 4 Neon · Reasoning xhigh/);
		assert.match(collapsed, /✓ task-2 · Background sleep task finished \(Exit 0\)/);
		assert.match(collapsed, /Ausgabe: fertig/);
		assert.match(collapsed, /1 tool call/);
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
		// The ACP tool_call agy 1.5.13 sent for the subagent test prompt.
		assert.deepEqual(
			classifyAgyToolCall({
				title: "Run invoke_subagent",
				kind: "other",
				rawInput: { Prompt: "Lege die Datei an.", Role: "File Creator Subagent", TypeName: "self" },
			}),
			{
				mirrorToolName: "agy_subagent",
				arguments: {
					title: "Run invoke_subagent",
					kind: "other",
					agentRole: "File Creator Subagent",
					tool: "invoke_subagent",
					agentType: "self",
					prompt: "Lege die Datei an.",
				},
			},
		);
		const batch = classifyAgyToolCall({
			title: "Run invoke_subagent",
			kind: "other",
			rawInput: { Subagents: [{ Role: "a", Prompt: "x" }, { Role: "b", Prompt: "y" }] },
		});
		assert.equal(batch.arguments.agentCount, 2);
		assert.equal(batch.arguments.agentRole, "a, b");
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
			{
				agySessionId: CONV,
				kind: "execute",
				title: "sleep 60; echo fertig",
				command: "sleep 60; echo fertig",
				toolName: undefined,
				args: { title: "sleep 60; echo fertig", kind: "execute", command: "sleep 60; echo fertig" },
			},
		]);
		assert.equal(broker.isTracking("call_1"), false);
	});
});
