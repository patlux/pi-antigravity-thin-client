import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type ActivitySnapshot, AgyActivityWatcher } from "../src/background/activity-watcher.ts";
import {
	type AutonomousTurn,
	deriveAgyActivity,
	deriveSubagentStatus,
	deriveSwarmMemberStatus,
	firstLine,
	formatDuration,
	lastLogLine,
	parseDurationSeconds,
	parseSubagentRecord,
	parseSwarmMembersFile,
	parseTaskMessage,
	parseTranscriptLine,
	splitAgyModel,
	type SwarmMemberStatus,
	type TranscriptStep,
} from "../src/background/agy-activity.ts";
import {
	BackgroundActivityController,
	type BackgroundCoordinatorLike,
} from "../src/background/background-controller.ts";
import { DEFAULT_BRIDGE_CONFIG } from "../src/config.ts";
import { AgyTurnMirrorBroker, classifyAgyToolCall } from "../src/tools/agy-mirror-tools.ts";
import { withoutTimestampHeader } from "../src/tools/agy-renderers.ts";
import {
	AUTONOMOUS_ENTRY_TYPE,
	BackgroundActivityView,
	describeTrigger,
	formatAgyModel,
	isAutonomousEntryData,
	LIVE_STALE_MS,
	renderActivityLines,
	renderAutonomousEntry,
	senderRole,
	setAgyModelNames,
	subagentModelLabel,
	subagentStartNote,
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

	it("parses multiple [Message] blocks in one SYSTEM_MESSAGE step for tasks, timers and triggers", () => {
		const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
		const sub = "7c7c7c7c-1111-2222-3333-444444444444";
		const lines = [
			line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-26T10:00:00Z", content: "start jobs" }),
			line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:01Z", tool_calls: [{ name: "run_command", args: { CommandLine: "\"job-1\"" } }, { name: "run_command", args: { CommandLine: "\"job-2\"" } }, { name: "schedule", args: { DurationSeconds: "120", Prompt: "\"Wait for job-2\"", TimerCondition: `"${CONV}/task-3"` } }] }),
			line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:02Z", content: `Tool is running as a background task with task id: ${CONV}/task-2\nTask Description: job-1` }),
			line({ step_index: 3, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:02Z", content: `Tool is running as a background task with task id: ${CONV}/task-3\nTask Description: job-2` }),
			line({ step_index: 4, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:02Z", content: `Tool is running as a background task with task id: ${CONV}/task-4\nTask Description: Timer: 2m, Prompt: Wait for job-2` }),
			line({ step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:03Z", content: "Started." }),
			line({
				step_index: 6,
				source: "SYSTEM",
				type: "SYSTEM_MESSAGE",
				status: "DONE",
				created_at: "2026-11-26T10:00:30Z",
				content:
					`<SYSTEM_MESSAGE>\n` +
					`[Message] timestamp=2026-11-26T10:00:29Z sender=${CONV}/task-2 priority=MESSAGE_PRIORITY_HIGH content=Task id "${CONV}/task-2" finished with result:\nCommand exited with code 0.\n` +
					`[Message] timestamp=2026-11-26T10:00:30Z sender=${CONV}/task-3 priority=MESSAGE_PRIORITY_HIGH content=Task id "${CONV}/task-3" finished with result:\nCommand exited with code 2.\n` +
					`</SYSTEM_MESSAGE>The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n` +
					`<SYSTEM_MESSAGE>\n` +
					`[Message] timestamp=2026-11-26T10:00:30Z sender=${sub} priority=MESSAGE_PRIORITY_HIGH content=Subagent finished cleanly.\n` +
					`</SYSTEM_MESSAGE>`,
			}),
			line({ step_index: 7, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:31Z", content: "All handled." }),
		];
		const activity = deriveAgyActivity(steps(lines), []);
		assert.deepEqual(
			activity.tasks.map((task) => [task.taskId, task.finished?.outcome, task.finished?.exitCode]),
			[
				["task-2", "ok", 0],
				["task-3", "failed", 2],
				["task-4", "canceled", undefined],
			],
		);
		assert.equal(activity.turns.length, 1);
		assert.deepEqual(activity.turns[0].triggers, [
			{ taskId: "task-2", title: undefined, outcome: "ok", exitCode: 0, kind: "command" },
			{ taskId: "task-3", title: undefined, outcome: "failed", exitCode: 2, kind: "command" },
			{ agentId: sub, title: undefined, preview: "Subagent finished cleanly." },
		]);
	});

	it("does not misclassify a successful command as canceled when its stdout mentions cancellation", () => {
		const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
		const lines = [
			line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-26T10:00:00Z", content: "run" }),
			line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:01Z", tool_calls: [{ name: "run_command", args: { CommandLine: "\"check-builds\"" } }, { name: "run_command", args: { CommandLine: "\"long-job\"" } }] }),
			line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:02Z", content: `Tool is running as a background task with task id: ${CONV}/task-2\nTask Description: check-builds` }),
			line({ step_index: 3, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:02Z", content: `Tool is running as a background task with task id: ${CONV}/task-3\nTask Description: long-job` }),
			line({ step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:03Z", content: "Running." }),
		];
		const okMsg = parseTaskMessage(
			JSON.stringify({
				id: "m1",
				sender: `${CONV}/task-2`,
				timestamp: "2026-11-26T10:00:10Z",
				renderDetails: { messageTitle: "check-builds finished" },
				content: `Task id "${CONV}/task-2" finished with result:\nCommand exited with code 0.\n\nCommand output:\nPrevious job was cancelled.\nTask id "${CONV}/task-2" was cancelled in log output\nCommand exited with code 1`,
			}),
		);
		const canceledMsg = parseTaskMessage(
			JSON.stringify({
				id: "m2",
				sender: `${CONV}/task-3`,
				timestamp: "2026-11-26T10:00:12Z",
				renderDetails: { messageTitle: "long-job update" },
				content: `Task id "${CONV}/task-3" was cancelled.`,
			}),
		);
		assert.ok(okMsg && canceledMsg);
		const activity = deriveAgyActivity(steps(lines), [okMsg, canceledMsg]);
		assert.deepEqual(activity.tasks[0].finished, {
			outcome: "ok",
			title: "check-builds finished",
			exitCode: 0,
			atMs: Date.parse("2026-11-26T10:00:10Z"),
		});
		assert.equal(activity.tasks[1].finished?.outcome, "canceled");
	});

	it("resets inTurn after canceled or errored user turns without resetting on normal tool errors", () => {
		const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
		// 1. User turn whose PLANNER_RESPONSE errors out (even with tool_calls) must not swallow the next autonomous turn.
		const erroredPlanner = [
			line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "try" }),
			line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "ERROR", content: "", tool_calls: [{ name: "run_command", args: { CommandLine: "\"x\"" } }] }),
			line({ step_index: 2, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T10:01:00Z sender=${CONV}/task-9 priority=HIGH content=done\n</SYSTEM_MESSAGE>` }),
			line({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Autonomous reply after planner error." }),
		];
		assert.deepEqual(
			deriveAgyActivity(steps(erroredPlanner), []).turns.map((turn) => [turn.startStep, turn.state, turn.texts]),
			[[2, "done", ["Autonomous reply after planner error."]]],
		);

		// 2. Canceled USER_INPUT and canceled GENERIC reset inTurn.
		const canceledSteps = [
			line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "CANCELED", content: "abort immediately" }),
			line({ step_index: 1, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T10:02:00Z sender=${CONV}/task-1 priority=HIGH content=done\n</SYSTEM_MESSAGE>` }),
			line({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "After canceled user input." }),
			line({ step_index: 3, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "run tool" }),
			line({ step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "", tool_calls: [{ name: "run_command", args: { CommandLine: "\"sleep 60\"" } }] }),
			line({ step_index: 5, source: "MODEL", type: "GENERIC", status: "CANCELLED", content: "Aborted" }),
			line({ step_index: 6, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T10:03:00Z sender=${CONV}/task-2 priority=HIGH content=done\n</SYSTEM_MESSAGE>` }),
			line({ step_index: 7, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "After canceled tool." }),
		];
		assert.deepEqual(
			deriveAgyActivity(steps(canceledSteps), []).turns.map((turn) => [turn.startStep, turn.texts]),
			[
				[1, ["After canceled user input."]],
				[6, ["After canceled tool."]],
			],
		);

		// 3. Normal tool error (GENERIC status ERROR) keeps inTurn active because agy continues the user turn.
		const toolError = [
			line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "check" }),
			line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "", tool_calls: [{ name: "manage_task", args: { Action: "\"kill\"", TaskId: `"${CONV}/task-1"` } }] }),
			line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "ERROR", content: "task is not running" }),
			line({ step_index: 3, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T10:04:00Z sender=${CONV}/task-2 priority=HIGH content=done\n</SYSTEM_MESSAGE>` }),
			line({ step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Recovered in user turn." }),
		];
		assert.deepEqual(deriveAgyActivity(steps(toolError), []).turns, []);

		// 4. Autonomous turn whose PLANNER_RESPONSE fails with empty text and no actions is not emitted as empty done.
		const emptyErroredAuto = [
			line({ step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T10:05:00Z sender=${CONV}/task-2 priority=HIGH content=done\n</SYSTEM_MESSAGE>` }),
			line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "ABORTED", content: "" }),
			line({ step_index: 2, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T10:06:00Z sender=${CONV}/task-3 priority=HIGH content=done\n</SYSTEM_MESSAGE>` }),
			line({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Next autonomous turn works." }),
		];
		assert.deepEqual(
			deriveAgyActivity(steps(emptyErroredAuto), []).turns.map((turn) => [turn.startStep, turn.texts]),
			[[2, ["Next autonomous turn works."]]],
		);
	});

	it("classifies cron jobs cleanly, keeps them running across ticks and only finishes manage_task status on terminal states", () => {
		const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
		const lines = [
			line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:00Z", tool_calls: [{ name: "schedule", args: { CronExpression: "\"*/5 * * * *\"", Prompt: "\"Check deploy\"" } }, { name: "schedule", args: { CronExpression: "\"0 * * * *\"", Prompt: "\"Hourly check\"" } }, { name: "run_command", args: { CommandLine: "\"build\"" } }] }),
			line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:01Z", content: `Tool is running as a background task with task id: ${CONV}/task-2\nTask Description: Cron: */5 * * * *, Prompt: Check deploy` }),
			line({ step_index: 3, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:01Z", content: `Tool is running as a background task with task id: ${CONV}/task-3\nTask Description: Hourly check` }),
			line({ step_index: 4, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:01Z", content: `Tool is running as a background task with task id: ${CONV}/task-4\nTask Description: build` }),
			line({ step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:02Z", content: "Scheduled." }),
			// Cron tick wakes agy up without ending the recurring cron job.
			line({ step_index: 6, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-26T10:05:00Z", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T10:05:00Z sender=${CONV}/task-2 priority=MESSAGE_PRIORITY_HIGH content=Check deploy\n</SYSTEM_MESSAGE>` }),
			line({ step_index: 7, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:05:01Z", content: "Deploy healthy." }),
			// manage_task status with PENDING / QUEUED / IN_PROGRESS must NOT mark tasks finished.
			line({ step_index: 8, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:06:00Z", tool_calls: [{ name: "manage_task", args: { Action: "\"status\"", TaskId: `"${CONV}/task-4"` } }] }),
			line({ step_index: 9, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T10:06:01Z", content: `Task: ${CONV}/task-4\nStatus: PENDING` }),
			line({ step_index: 10, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T10:06:02Z", content: `Task: ${CONV}/task-4\nStatus: QUEUED` }),
			line({ step_index: 11, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T10:06:03Z", content: `Task: ${CONV}/task-4\nStatus: IN_PROGRESS` }),
		];
		const mid = deriveAgyActivity(steps(lines), []);
		assert.deepEqual(
			mid.tasks.map((task) => [task.taskId, task.kind, task.summary, task.description, task.finished]),
			[
				["task-2", "cron", "*/5 * * * *", "Check deploy", undefined],
				["task-3", "cron", "0 * * * *", "Hourly check", undefined],
				["task-4", "command", undefined, "build", undefined],
			],
		);
		assert.equal(describeTrigger(mid.turns[0].triggers[0], plainTheme), "⏳ task-2 · cron triggered");
		const widgetLines = renderActivityLines(
			{ agySessionId: CONV, tasks: mid.tasks.slice(0, 1), logTails: new Map() },
			Date.parse("2026-11-26T10:00:31Z"),
			0,
			plainTheme,
		);
		assert.deepEqual(widgetLines, [
			"Antigravity · 1 background task",
			" ⠋ task-2  Cron */5 * * * *  0:30  scheduled",
		]);

		// Terminal manage_task statuses finish tasks with the expected outcomes.
		lines.push(
			line({ step_index: 12, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T10:07:00Z", content: `Task: ${CONV}/task-4\nStatus: TIMED_OUT` }),
			line({ step_index: 13, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T10:07:01Z", content: `Task: ${CONV}/task-3\nStatus: CANCELLED` }),
		);
		const ended = deriveAgyActivity(steps(lines), []);
		assert.equal(ended.tasks[2].finished?.outcome, "failed");
		assert.equal(ended.tasks[1].finished?.outcome, "canceled");
	});

	it("strips OSC hyperlinks, titles and stray control characters in lastLogLine", () => {
		assert.equal(
			lastLogLine(
				"\u001b]0;cargo build\u0007Compiling \u001b]8;;https://example.com\u001b\\crate\u001b]8;;\u001b\\\r\n" +
					"\u001b[32mSee \u001b]8;;file:///tmp/a.rs\u0007a.rs\u001b]8;;\u0007\u001b[0m\u0007\u0000\u0008\u007f\r\n" +
					"\u001b]0;Window Title Only\u0007\r\n",
			),
			"See a.rs",
		);
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

	it("decodes multi-byte UTF-8 split across chunks, ignores 0-byte transcript_full.jsonl and resets decoder on rewind", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-brain-utf8-"));
		try {
			fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
			const shortFile = path.join(dir, "logs", "transcript.jsonl");
			const fullFile = path.join(dir, "logs", "transcript_full.jsonl");
			const line0 = `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "Grüße 🚀" })}\n`;
			const bytes = Buffer.from(line0, "utf8");
			const emojiByteIndex = bytes.indexOf(Buffer.from("🚀", "utf8"));
			assert.ok(emojiByteIndex > 0);
			// Split right inside the 4-byte UTF-8 sequence of 🚀.
			fs.writeFileSync(shortFile, bytes.subarray(0, emojiByteIndex + 2));

			const watcher = new AgyActivityWatcher({
				agySessionId: CONV,
				systemDir: dir,
				isAlive: () => true,
				onSnapshot: () => {},
				onTurnFinished: () => {},
			});
			watcher.refresh();

			// A 0-byte transcript_full.jsonl must not drop the active transcript.jsonl state.
			fs.writeFileSync(fullFile, "");
			fs.appendFileSync(shortFile, bytes.subarray(emojiByteIndex + 2));
			assert.equal(watcher.refresh().lastUserInputStep, 0);

			// Appending another split German umlaut still decodes cleanly without U+FFFD.
			const line1 = `${JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Prüfung überstanden ✅" })}\n`;
			const bytes1 = Buffer.from(line1, "utf8");
			const umlautIdx = bytes1.indexOf(Buffer.from("ü", "utf8"));
			fs.appendFileSync(shortFile, bytes1.subarray(0, umlautIdx + 1));
			watcher.refresh();
			fs.appendFileSync(shortFile, bytes1.subarray(umlautIdx + 1));
			// Now also verify switching once transcript_full.jsonl becomes non-empty.
			fs.writeFileSync(fullFile, `${line0}${line1}`);
			const step1 = JSON.stringify({ step_index: 2, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: `[Message] timestamp=2026-11-26T10:00:00Z sender=${CONV}/task-1 priority=HIGH content=ok` });
			const step2 = JSON.stringify({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Prüfung überstanden ✅" });
			fs.appendFileSync(fullFile, `${step1}\n${step2}\n`);
			const activity = watcher.refresh();
			assert.equal(activity.turns[0]?.texts[0], "Prüfung überstanden ✅");
			assert.doesNotMatch(activity.turns[0]?.texts[0] ?? "", /\uFFFD/);

			// Rewind (file shrunk while holding half a UTF-8 char) must reset decoder cleanly.
			const partialUtf8 = Buffer.from(`${JSON.stringify({ step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "ä" })}\n`, "utf8");
			fs.appendFileSync(fullFile, partialUtf8.subarray(0, partialUtf8.indexOf(0xc3) + 1));
			watcher.refresh();
			fs.writeFileSync(fullFile, `${line0}`);
			assert.equal(watcher.refresh().lastUserInputStep, 0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("waits briefly for transcript_full.jsonl when a newly finished autonomous turn is truncated, then falls back cleanly", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-brain-trunc-"));
		try {
			const all = transcriptLines();
			const answer = `Full answer.\n${"- detail line\n".repeat(250)}End.`;
			const cut = `${answer.slice(0, 100)}\n<truncated 3000 bytes>\n${answer.slice(-100)}`;
			const truncStep = JSON.stringify({
				step_index: 9,
				source: "MODEL",
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: "2026-11-25T13:55:16Z",
				content: cut,
				truncated_fields: ["content"],
			});
			const fullStep = JSON.stringify({
				step_index: 9,
				source: "MODEL",
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: "2026-11-25T13:55:16Z",
				content: answer,
			});
			assert.equal(parseTranscriptLine(truncStep)?.truncated, true);
			assert.equal(parseTranscriptLine(fullStep)?.truncated, false);

			// Case 1: transcript_full.jsonl arrives on the next poll -> emits the full answer, never the cut one.
			writeBrain(dir, all.slice(0, 8), {});
			let now = Date.parse("2026-11-25T13:55:16Z");
			const emitted1: AutonomousTurn[] = [];
			const watcher1 = new AgyActivityWatcher({
				agySessionId: CONV,
				systemDir: dir,
				isAlive: () => true,
				onSnapshot: () => {},
				onTurnFinished: (turn) => emitted1.push(turn),
				now: () => now,
			});
			watcher1.poll();
			fs.appendFileSync(path.join(dir, "logs", "transcript.jsonl"), `${all[8]}\n${truncStep}\n`);
			watcher1.poll();
			assert.equal(emitted1.length, 0, "defers truncated turn on first poll");
			fs.writeFileSync(
				path.join(dir, "logs", "transcript_full.jsonl"),
				[...all.slice(0, 9), fullStep].map((l) => `${l}\n`).join(""),
			);
			now += 500;
			watcher1.poll();
			assert.equal(emitted1.length, 1);
			assert.equal(emitted1[0].texts[0], answer);

			// Case 2: transcript_full.jsonl never arrives -> emits after 2s / 2 polls anyway.
			fs.rmSync(path.join(dir, "logs", "transcript_full.jsonl"));
			writeBrain(dir, all.slice(0, 8), {});
			let now2 = Date.parse("2026-11-25T13:55:16Z");
			const emitted2: AutonomousTurn[] = [];
			const watcher2 = new AgyActivityWatcher({
				agySessionId: CONV,
				systemDir: dir,
				isAlive: () => true,
				onSnapshot: () => {},
				onTurnFinished: (turn) => emitted2.push(turn),
				now: () => now2,
			});
			watcher2.poll();
			fs.appendFileSync(path.join(dir, "logs", "transcript.jsonl"), `${all[8]}\n${truncStep}\n`);
			watcher2.poll();
			assert.equal(emitted2.length, 0);
			now2 += 1_000;
			watcher2.poll();
			assert.equal(emitted2.length, 0);
			now2 += 1_000;
			watcher2.poll();
			assert.equal(emitted2.length, 1);
			assert.equal(emitted2[0].texts[0], cut);
			watcher2.poll();
			assert.equal(emitted2.length, 1, "never emits twice");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not replay already-finished autonomous turns on attach while still emitting running and future ones", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-brain-base-"));
		try {
			const all = transcriptLines();
			// Step 8..9 is an already-finished autonomous turn AFTER lastUserInputStep (4);
			// Step 10..11a is a still-running autonomous turn when the watcher attaches.
			const runningStep = JSON.stringify({
				step_index: 11,
				source: "MODEL",
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: "2026-11-25T13:55:26Z",
				content: "",
				tool_calls: [{ name: "manage_task", args: { Action: "\"list\"" } }],
			});
			writeBrain(dir, [...all.slice(0, 11), runningStep], messageFiles());
			const snapshots: ActivitySnapshot[] = [];
			const finished: number[] = [];
			const watcher = new AgyActivityWatcher({
				agySessionId: CONV,
				systemDir: dir,
				isAlive: () => true,
				onSnapshot: (snapshot) => snapshots.push(snapshot),
				onTurnFinished: (turn) => finished.push(turn.startStep),
			});
			watcher.poll();
			assert.deepEqual(finished, [], "already-finished turn at step 8 is not replayed");
			assert.equal(snapshots.at(-1)?.runningTurn?.startStep, 10, "still-running turn at step 10 is shown");

			// Now step 10's turn finishes, and a future turn at step 13 runs and finishes.
			fs.appendFileSync(
				path.join(dir, "logs", "transcript.jsonl"),
				[
					JSON.stringify({ step_index: 12, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Done 10." }),
					JSON.stringify({ step_index: 13, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: `[Message] timestamp=2026-11-25T13:56:00Z sender=${CONV}/task-9 priority=HIGH content=ok` }),
					JSON.stringify({ step_index: 14, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Done 13." }),
				]
					.map((l) => `${l}\n`)
					.join(""),
			);
			watcher.poll();
			assert.deepEqual(finished, [10, 13]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("re-emits snapshot when transcript_full.jsonl upgrades task summary/kind and filters ancient finished lookups", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-brain-key-"));
		try {
			const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
			const shortLines = [
				line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:00Z", tool_calls: [{ name: "run_command", args: { CommandLine: "\"sleep 60\"" } }] }),
				line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:01Z", content: `Tool is running as a background task with task id: ${CONV}/task-2\nTask Description: sleep 60` }),
			];
			const fullLines = [
				line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:00Z", tool_calls: [{ name: "run_command", args: { CommandLine: "\"sleep 60\"", toolSummary: "\"Long sleep\"" } }] }),
				line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:01Z", content: `Tool is running as a background task with task id: ${CONV}/task-2\nTask Description: sleep 60` }),
			];
			writeBrain(dir, shortLines, {});
			let now = Date.parse("2026-11-26T10:00:05Z");
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
			assert.equal(snapshots.length, 1);
			assert.equal(snapshots[0].tasks[0].summary, undefined);

			fs.writeFileSync(path.join(dir, "logs", "transcript_full.jsonl"), fullLines.map((l) => `${l}\n`).join(""));
			watcher.poll();
			assert.equal(snapshots.length, 2, "upgraded task summary triggers snapshot update");
			assert.equal(snapshots[1].tasks[0].summary, "Long sleep");

			// Add a second identical command that finished long ago; active task-2 is still preferred.
			fs.appendFileSync(
				path.join(dir, "logs", "transcript_full.jsonl"),
				[
					line({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T10:00:02Z", tool_calls: [{ name: "run_command", args: { CommandLine: "\"sleep 60\"" } }, { name: "schedule", args: { DurationSeconds: "10", Prompt: "\"old\"" } }] }),
					line({ step_index: 4, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:03Z", content: `Tool is running as a background task with task id: ${CONV}/task-4\nTask Description: sleep 60` }),
					line({ step_index: 5, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-26T10:00:03Z", content: `Tool is running as a background task with task id: ${CONV}/task-5\nTask Description: Timer: 10s, Prompt: old` }),
					line({ step_index: 6, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-26T10:00:04Z", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T10:00:04Z sender=${CONV}/task-4 priority=HIGH content=Task id "${CONV}/task-4" finished with result:\nCommand exited with code 0.\n[Message] timestamp=2026-11-26T10:00:04Z sender=${CONV}/task-5 priority=HIGH content=old\n</SYSTEM_MESSAGE>` }),
				]
					.map((l) => `${l}\n`)
					.join(""),
			);
			assert.equal(watcher.findCommandTask("sleep 60")?.taskId, "task-2", "prefers active command over newer finished one");
			assert.equal(watcher.latestTimer()?.taskId, "task-5", "returns recently finished timer within linger window");

			// Advance past linger window: finished timer is no longer returned.
			now = Date.parse("2026-11-26T10:01:00Z");
			assert.equal(watcher.latestTimer(), undefined, "ignores ancient finished timer");
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
		const afterExpired = deriveSubagentStatus(record, steps(own), [], [expired]);
		assert.equal(afterExpired.state, "idle");
		assert.equal(afterExpired.lastAtMs, Date.parse("2026-11-25T15:01:58Z"), "uses newer terminal ownMessage timestamp so subagent lingers cleanly");
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

	it("ignores non-message reminders after a finished subagent turn and resolves Model: inherit cleanly", () => {
		const record = parseSubagentRecord(SUB_RECORD);
		assert.ok(record);
		const line = (obj: Record<string, unknown>) => JSON.stringify(obj);

		// A trailing non-message reminder after the final answer keeps the subagent idle.
		const withTrailingReminder = [
			...subagentLines(),
			line({ step_index: 7, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-25T14:46:42Z", content: "<SYSTEM_MESSAGE> Reminder: work efficiently. </SYSTEM_MESSAGE>" }),
		];
		const stillIdle = deriveSubagentStatus(record, steps(withTrailingReminder), steps(parentSpawnLines()));
		assert.equal(stillIdle.state, "idle");
		assert.equal(stillIdle.activity, "Die Datei wurde angelegt und der Parent-Agent benachrichtigt.");

		// A real message delivery after the final answer wakes it back up.
		const withWakeup = [
			...withTrailingReminder,
			line({ step_index: 8, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-25T14:46:45Z", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-25T14:46:45Z sender=${CONV} priority=HIGH content=Bitte weiter.\n</SYSTEM_MESSAGE>` }),
		];
		const awake = deriveSubagentStatus(record, steps(withWakeup), steps(parentSpawnLines()));
		assert.deepEqual([awake.state, awake.activity], ["working", "thinking …"]);

		// Model: "inherit" (case-insensitive) resolves parentModel for any subagent type, never "inherit (requested)".
		const reviewerRecord = parseSubagentRecord(
			JSON.stringify({
				conversationId: SUB,
				subagentDescriptor: { typeName: "reviewer", role: "Code Reviewer" },
				state: "SUBAGENT_STATE_ALIVE",
				spawnStepIndex: 2,
			}),
		);
		assert.ok(reviewerRecord);
		const parentInherit = [
			line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "review" }),
			line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-xhigh", tool_calls: [{ name: "invoke_subagent", args: { Prompt: "\"Review PR\"", Role: "\"Code Reviewer\"", TypeName: "\"reviewer\"", Model: "\"INHERIT\"" } }] }),
			line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: `Created subagent ${SUB}` }),
		];
		const startingReviewer = deriveSubagentStatus(reviewerRecord, [], steps(parentInherit));
		assert.equal(startingReviewer.model, "gemini-4-neon-xhigh");
		assert.equal(startingReviewer.modelFromParent, true);
		assert.equal(startingReviewer.requestedModel, undefined);
		assert.equal(subagentModelLabel(startingReviewer), "Gemini 4 Neon · Reasoning xhigh");
		assert.equal(
			subagentModelLabel({ conversationId: SUB, state: "working", toolCalls: 0, requestedModel: "inherit" }),
			"same model as the main agent",
		);
		const startNote = subagentStartNote({ agentRole: "Code Reviewer", agentType: "reviewer", model: "Inherit" }, undefined);
		assert.match(startNote, /same model as the main agent/);
		assert.doesNotMatch(startNote, /inherit \(requested\)/i);
	});

	it("prefers working subagents over finished ones and ignores ancient finished subagents in findSubagent", () => {
		const brain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-brain-sub-recency-"));
		try {
			const oldSub = "11111111-1111-1111-1111-111111111111";
			const activeSub = "22222222-2222-2222-2222-222222222222";
			const parentDir = path.join(brain, CONV, ".system_generated");
			fs.mkdirSync(path.join(parentDir, "logs"), { recursive: true });
			fs.mkdirSync(path.join(parentDir, "subagents"), { recursive: true });
			fs.mkdirSync(path.join(brain, oldSub, ".system_generated", "logs"), { recursive: true });
			fs.mkdirSync(path.join(brain, activeSub, ".system_generated", "logs"), { recursive: true });
			fs.writeFileSync(path.join(parentDir, "logs", "transcript.jsonl"), parentSpawnLines().map((l) => `${l}\n`).join(""));
			fs.writeFileSync(
				path.join(parentDir, "subagents", `${oldSub}.json`),
				JSON.stringify({ conversationId: oldSub, subagentDescriptor: { typeName: "self", role: "Worker" }, state: "SUBAGENT_STATE_ALIVE", spawnStepIndex: 2 }),
			);
			fs.writeFileSync(
				path.join(brain, oldSub, ".system_generated", "logs", "transcript.jsonl"),
				`${JSON.stringify({ step_index: 0, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T14:46:41Z", content: "Old done" })}\n`,
			);

			let now = Date.parse("2026-11-25T14:50:00Z");
			const watcher = new AgyActivityWatcher({
				agySessionId: CONV,
				systemDir: parentDir,
				isAlive: () => true,
				onSnapshot: () => {},
				onTurnFinished: () => {},
				now: () => now,
			});
			assert.equal(watcher.findSubagent("Worker"), undefined, "ancient idle subagent is ignored");

			now = Date.parse("2026-11-25T14:46:45Z");
			assert.equal(watcher.findSubagent("Worker")?.conversationId, oldSub, "recent idle subagent within linger window is returned");

			// Add a working subagent with an earlier startedAtMs so oldSub sorts after it; findSubagent still prefers working.
			fs.writeFileSync(
				path.join(parentDir, "subagents", `${activeSub}.json`),
				JSON.stringify({ conversationId: activeSub, subagentDescriptor: { typeName: "self", role: "Worker" }, state: "SUBAGENT_STATE_ALIVE", spawnStepIndex: 2 }),
			);
			fs.writeFileSync(
				path.join(brain, activeSub, ".system_generated", "logs", "transcript.jsonl"),
				`${JSON.stringify({ step_index: 0, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T14:46:00Z", tool_calls: [{ name: "write_file", args: { Path: "\"/tmp/x\"" } }] })}\n`,
			);
			assert.equal(watcher.findSubagent("Worker")?.conversationId, activeSub, "prefers working subagent over newer idle one");
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

		// The answer stands below the box, outside its background.
		const boxedTheme: ThemeLike = { ...plainTheme, bg: (_color, text) => `«${text}»` };
		const lines = renderAutonomousEntry(data, false, boxedTheme, (text) => new Text(text, 1, 0)).render(120);
		const answerRow = lines.findIndex((line) => line.includes("Ausgabe: fertig"));
		const toolRow = lines.findIndex((line) => line.includes("1 tool call"));
		assert.ok(toolRow >= 0 && answerRow > toolRow, JSON.stringify(lines));
		assert.ok(lines[toolRow].startsWith("«"), "tool calls stay in the box");
		assert.ok(!lines[answerRow].includes("«"), "the answer has no box background");
		assert.ok(lines.slice(0, toolRow + 1).every((line) => line.startsWith("«")));

		// Without an answer the card is the box alone.
		const silent = renderAutonomousEntry({ ...data, text: "" }, false, boxedTheme, (text) => new Text(text, 1, 0)).render(120);
		assert.ok(silent.every((line) => line.startsWith("«")), JSON.stringify(silent));
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

	it("keeps a shell command a command when its line mentions a workflow or subagent", () => {
		// The run_command agy 1.5.13 sent on 2026-11-26; it was shown as a subagent.
		const cmd = `RUN_ID=$(gh run list --workflow="Cargo Deny" --limit 1 --json databaseId --jq '.[0].databaseId')\necho "Cargo Deny run: $RUN_ID"\ngh run view "$RUN_ID" --log-failed | tail -n 45`;
		assert.equal(classifyAgyToolCall({ title: cmd, kind: "execute", rawInput: { CommandLine: cmd } }).mirrorToolName, "agy_bash");
		assert.equal(classifyAgyToolCall({ title: "pi-subagents --list", kind: "execute" }).mirrorToolName, "agy_bash");
		assert.equal(classifyAgyToolCall({ title: "Start subagent", kind: "other" }).mirrorToolName, "agy_subagent");
	});

	it("drops agy's timestamp lines from a command card", () => {
		assert.equal(
			withoutTimestampHeader("Created At: 2026-11-26T20:59:02+01:00\nCompleted At: 2026-11-26T20:59:07+01:00\nCommand exited with code 0.\n\nCommand output:\nok"),
			"Command exited with code 0.\n\nCommand output:\nok",
		);
		assert.equal(withoutTimestampHeader("plain output\nCreated At: x"), "plain output\nCreated At: x");
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

function isTestExtensionContext(value: object): value is ExtensionContext {
	return "hasUI" in value && "cwd" in value && "ui" in value && "sessionManager" in value;
}

function createControllerUiContext(cwd: string, piSessionId: string) {
	const widgets: Array<{ key: string; active: boolean }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const notifications: Array<{ text: string; level: string }> = [];
	const stub = {
		hasUI: true,
		cwd,
		model: { provider: "antigravity", id: "gemini-4-neon" },
		sessionManager: {
			getSessionId: () => piSessionId,
			getEntries: () => [],
		},
		ui: {
			setWidget: (key: string, factory: unknown) => {
				widgets.push({ key, active: factory !== undefined });
			},
			setStatus: (key: string, text: string | undefined) => {
				statuses.push({ key, text });
			},
			notify: (text: string, level: string) => {
				notifications.push({ text, level });
			},
		},
	};
	if (!isTestExtensionContext(stub)) {
		throw new Error("controller UI stub incomplete");
	}
	return { ctx: stub, widgets, statuses, notifications };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("native agy swarm member tracking", () => {
	it("parses members.json defensively, skipping coordinator, invalid IDs and malformed payloads", () => {
		const raw = JSON.stringify({
			title: "Parallel audit",
			members: {
				coordinator: { conversation_id: CONV, role: "coordinator", wake_mode: "mentions" },
				"shard-1": {
					conversation_id: "11111111-1111-1111-1111-111111111111",
					role: "worker",
					desired_state: "ALIVE",
					phase: "RUNNING",
					wake_mode: "working",
					model: "gemini-4-neon-high",
				},
				verifier: {
					conversation_id: "worker_2-abc",
					role: "verifier",
					wake_mode: "mentions",
				},
				"default-role": {
					conversation_id: "33333333-3333-3333-3333-333333333333",
				},
				"bad-traversal": { conversation_id: "../escape", role: "worker" },
				"bad-slash": { conversation_id: "foo/bar", role: "worker" },
				"bad-space": { conversation_id: "has space", role: "worker" },
				"missing-id": { role: "worker" },
				"non-object": "broken",
				"   ": { conversation_id: "44444444-4444-4444-4444-444444444444", role: "worker" },
			},
		});
		assert.deepEqual(parseSwarmMembersFile(raw), [
			{
				name: "shard-1",
				conversationId: "11111111-1111-1111-1111-111111111111",
				role: "worker",
				desiredState: "ALIVE",
				phase: "RUNNING",
				wakeMode: "working",
				requestedModel: "gemini-4-neon-high",
			},
			{
				name: "verifier",
				conversationId: "worker_2-abc",
				role: "verifier",
				wakeMode: "mentions",
			},
			{
				name: "default-role",
				conversationId: "33333333-3333-3333-3333-333333333333",
				role: "worker",
			},
		]);

		assert.deepEqual(parseSwarmMembersFile(""), []);
		assert.deepEqual(parseSwarmMembersFile("{broken json"), []);
		assert.deepEqual(parseSwarmMembersFile("null"), []);
		assert.deepEqual(parseSwarmMembersFile("[]"), []);
		assert.deepEqual(parseSwarmMembersFile('"string"'), []);
		assert.deepEqual(parseSwarmMembersFile("{}"), []);
		assert.deepEqual(parseSwarmMembersFile(JSON.stringify({ members: [] })), []);
	});

	it("derives working, parked, idle and killed swarm member states with model, activity and timestamps", () => {
		const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
		const workerId = "aaaa1111-1111-1111-1111-111111111111";
		const workingSteps = steps([
			line({
				step_index: 0,
				source: "SYSTEM",
				type: "SYSTEM_MESSAGE",
				status: "DONE",
				created_at: "2026-11-26T21:00:00Z",
				content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T21:00:00Z sender=${CONV} priority=MESSAGE_PRIORITY_HIGH content=Inspect widget\n</SYSTEM_MESSAGE>`,
			}),
			line({
				step_index: 1,
				source: "MODEL",
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: "2026-11-26T21:00:05Z",
				model: "gemini-4-neon-high",
				tool_calls: [{ name: "read_file", args: { Path: "\"src/ui/background-activity.ts\"" } }],
			}),
		]);

		const working = deriveSwarmMemberStatus(
			{ name: "widget", conversationId: workerId, role: "worker", wakeMode: "working" },
			workingSteps,
			[],
		);
		assert.deepEqual(working, {
			name: "widget",
			conversationId: workerId,
			role: "worker",
			state: "working",
			model: "gemini-4-neon-high",
			activity: "→ read_file src/ui/background-activity.ts",
			startedAtMs: Date.parse("2026-11-26T21:00:00Z"),
			lastAtMs: Date.parse("2026-11-26T21:00:05Z"),
		});

		// Parked on mentions/anything after calling swarm_wait shows concise "waiting on board".
		const parkedWaitSteps = steps([
			...workingSteps.map((step) => JSON.stringify({
				step_index: step.index,
				source: step.source,
				type: step.type,
				status: step.status,
				created_at: step.createdAtMs ? new Date(step.createdAtMs).toISOString() : undefined,
				content: step.content,
				model: step.model,
			})),
			line({
				step_index: 2,
				source: "MODEL",
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: "2026-11-26T21:00:12Z",
				model: "gemini-4-neon-high",
				tool_calls: [
					{ name: "post_message", args: { text: "\"@coordinator [done]\"" } },
					{ name: "swarm_wait", args: { since: "13" } },
				],
			}),
		]);
		const parkedMentions = deriveSwarmMemberStatus(
			{ name: "widget", conversationId: workerId, role: "worker", wakeMode: "mentions", requestedModel: "gemini-4-neon-high" },
			parkedWaitSteps,
			[],
		);
		assert.equal(parkedMentions.state, "parked");
		assert.equal(parkedMentions.activity, "waiting on board");
		assert.equal(parkedMentions.model, "gemini-4-neon-high");
		assert.equal(parkedMentions.lastAtMs, Date.parse("2026-11-26T21:00:12Z"));

		const parkedAnything = deriveSwarmMemberStatus(
			{ name: "hunter", conversationId: workerId, role: "worker", wakeMode: "anything" },
			[],
			[],
		);
		assert.equal(parkedAnything.state, "parked");
		assert.equal(parkedAnything.activity, "waiting on board");

		// Completed turn without tool calls and without wake_mode is idle.
		const doneSteps = steps([
			line({
				step_index: 0,
				source: "SYSTEM",
				type: "SYSTEM_MESSAGE",
				status: "DONE",
				created_at: "2026-11-26T21:00:00Z",
				content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T21:00:00Z sender=${CONV} priority=HIGH content=Go\n</SYSTEM_MESSAGE>`,
			}),
			line({
				step_index: 1,
				source: "MODEL",
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: "2026-11-26T21:00:20Z",
				model: "gemini-3.8-flash-low",
				content: "All checks passed.\nDetails below.",
			}),
		]);
		const idle = deriveSwarmMemberStatus(
			{ name: "checker", conversationId: workerId, role: "verifier" },
			doneSteps,
			[],
		);
		assert.equal(idle.state, "idle");
		assert.equal(idle.model, "gemini-3.8-flash-low");
		assert.equal(idle.activity, "All checks passed.");

		// Unhandled newer inbox message wakes an idle worker back to working.
		const wakeMsg = parseTaskMessage(
			JSON.stringify({
				id: "wake-1",
				sender: CONV,
				timestamp: "2026-11-26T21:00:25Z",
				content: "@checker please re-check",
			}),
		);
		assert.ok(wakeMsg);
		const woken = deriveSwarmMemberStatus(
			{ name: "checker", conversationId: workerId, role: "verifier" },
			doneSteps,
			[wakeMsg],
		);
		assert.equal(woken.state, "working");
		assert.equal(woken.activity, "thinking …");
		assert.equal(woken.lastAtMs, Date.parse("2026-11-26T21:00:25Z"));

		// Killed has highest priority over wake_mode and running steps.
		const killedByDesired = deriveSwarmMemberStatus(
			{
				name: "retired",
				conversationId: workerId,
				role: "worker",
				desiredState: "KILLED",
				wakeMode: "working",
			},
			workingSteps,
			[],
		);
		assert.equal(killedByDesired.state, "killed");
		assert.equal(killedByDesired.activity, "stopped");
		assert.equal(killedByDesired.model, "gemini-4-neon-high");

		const killedByPhase = deriveSwarmMemberStatus(
			{
				name: "retired-2",
				conversationId: workerId,
				role: "worker",
				phase: "KILLED",
				wakeMode: "mentions",
			},
			workingSteps,
			[],
		);
		assert.equal(killedByPhase.state, "killed");
		assert.equal(killedByPhase.activity, "stopped");
	});

	it("tracks swarm/members.json in AgyActivityWatcher, deduplicates subagents, handles !isAlive() and linger", () => {
		const brain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-brain-swarm-"));
		try {
			const wWorking = "11111111-aaaa-bbbb-cccc-000000000001";
			const wParked = "22222222-aaaa-bbbb-cccc-000000000002";
			const wKilled = "33333333-aaaa-bbbb-cccc-000000000003";
			const plainSub = "44444444-aaaa-bbbb-cccc-000000000004";

			const parentDir = path.join(brain, CONV, ".system_generated");
			fs.mkdirSync(path.join(parentDir, "logs"), { recursive: true });
			fs.mkdirSync(path.join(parentDir, "swarm"), { recursive: true });
			fs.mkdirSync(path.join(parentDir, "subagents"), { recursive: true });

			const writeChildTranscript = (id: string, lines: Record<string, unknown>[]) => {
				const dir = path.join(brain, id, ".system_generated", "logs");
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, "transcript.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
			};

			// Both wWorking and plainSub exist under subagents/; only plainSub should stay in snapshot.subagents.
			fs.writeFileSync(
				path.join(parentDir, "subagents", `${wWorking}.json`),
				JSON.stringify({ conversationId: wWorking, subagentDescriptor: { typeName: "self", role: "Swarm Worker (builder)" }, state: "SUBAGENT_STATE_ALIVE" }),
			);
			fs.writeFileSync(
				path.join(parentDir, "subagents", `${plainSub}.json`),
				JSON.stringify({ conversationId: plainSub, subagentDescriptor: { typeName: "self", role: "Helper Subagent" }, state: "SUBAGENT_STATE_ALIVE" }),
			);

			writeChildTranscript(wWorking, [
				{ step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-26T21:00:00Z", content: `[Message] timestamp=2026-11-26T21:00:00Z sender=${CONV} priority=HIGH content=build` },
				{ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T21:00:05Z", model: "gemini-4-neon-high", tool_calls: [{ name: "run_command", args: { CommandLine: "\"npm test\"", toolSummary: "\"Run tests\"" } }] },
			]);
			writeChildTranscript(wParked, [
				{ step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-26T21:00:01Z", content: `[Message] timestamp=2026-11-26T21:00:01Z sender=${CONV} priority=HIGH content=verify` },
				{ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T21:00:04Z", model: "gemini-3.8-flash-low", tool_calls: [{ name: "swarm_wait", args: { since: "1" } }] },
			]);
			writeChildTranscript(wKilled, [
				{ step_index: 0, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T21:00:02Z", content: "Stopping." },
			]);
			writeChildTranscript(plainSub, [
				{ step_index: 0, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T21:00:03Z", tool_calls: [{ name: "read_file", args: { Path: "\"README.md\"" } }] },
			]);

			const membersFile = path.join(parentDir, "swarm", "members.json");
			const writeMembers = (payload: string) => fs.writeFileSync(membersFile, payload);
			writeMembers(
				JSON.stringify({
					members: {
						coordinator: { conversation_id: CONV, role: "coordinator", wake_mode: "mentions" },
						builder: { conversation_id: wWorking, role: "worker", wake_mode: "working" },
						verifier: { conversation_id: wParked, role: "verifier", wake_mode: "mentions" },
						retired: { conversation_id: wKilled, role: "worker", desired_state: "KILLED", phase: "KILLED" },
					},
				}),
			);

			let alive = true;
			let now = Date.parse("2026-11-26T21:00:06Z");
			const snapshots: ActivitySnapshot[] = [];
			const watcher = new AgyActivityWatcher({
				agySessionId: CONV,
				systemDir: parentDir,
				isAlive: () => alive,
				onSnapshot: (snapshot) => snapshots.push(snapshot),
				onTurnFinished: () => {},
				now: () => now,
			});

			watcher.poll();
			const first = snapshots.at(-1);
			assert.ok(first);
			assert.deepEqual(
				first.swarmMembers?.map((m) => [m.name, m.state, m.activity]),
				[
					["builder", "working", "→ run_command Run tests"],
					["verifier", "parked", "waiting on board"],
					["retired", "killed", "stopped"],
				],
			);
			assert.deepEqual(
				first.subagents?.map((s) => s.conversationId),
				[plainSub],
				"swarm worker conversationId must be deduplicated out of subagents",
			);

			// Partial/corrupt write during active swarm is tolerated without losing roster.
			writeMembers('{"members":{"builder":');
			watcher.poll();
			assert.equal(snapshots.length, 1, "corrupt partial write does not flap snapshot");

			// Restore valid members.json and advance past linger window: killed member drops, active ones stay.
			writeMembers(
				JSON.stringify({
					members: {
						builder: { conversation_id: wWorking, role: "worker", wake_mode: "working" },
						verifier: { conversation_id: wParked, role: "verifier", wake_mode: "mentions" },
						retired: { conversation_id: wKilled, role: "worker", desired_state: "KILLED", phase: "KILLED" },
					},
				}),
			);
			now = Date.parse("2026-11-26T21:00:15Z");
			watcher.poll();
			assert.deepEqual(
				snapshots.at(-1)?.swarmMembers?.map((m) => [m.name, m.state]),
				[
					["builder", "working"],
					["verifier", "parked"],
				],
				"killed member drops once linger window expires",
			);

			// When !isAlive(), recent working/parked transition to idle (never stay working/parked).
			alive = false;
			now = Date.parse("2026-11-26T21:00:08Z");
			watcher.poll();
			assert.deepEqual(
				snapshots.at(-1)?.swarmMembers?.map((m) => [m.name, m.state, m.activity]),
				[
					["builder", "idle", undefined],
					["verifier", "idle", undefined],
					["retired", "killed", "stopped"],
				],
			);

			// Once !isAlive() AND past linger window, all stale swarm members disappear.
			now = Date.parse("2026-11-26T21:00:25Z");
			watcher.poll();
			assert.deepEqual(snapshots.at(-1)?.swarmMembers, []);

			// Oversized (> 1 MiB) members.json is ignored safely.
			alive = true;
			writeMembers(`${" ".repeat(1024 * 1024 + 16)}`);
			assert.deepEqual(watcher.swarmMembers(), []);
		} finally {
			fs.rmSync(brain, { recursive: true, force: true });
		}
	});

	it("renders swarm workers in renderActivityLines with icons, roles, single-line invariant, overflow cap and empty state", () => {
		const now = Date.parse("2026-11-26T21:01:00Z");
		const empty = renderActivityLines(
			{ agySessionId: CONV, tasks: [], subagents: [], swarmMembers: [], logTails: new Map() },
			now,
			0,
			plainTheme,
		);
		assert.deepEqual(empty, []);

		const members: SwarmMemberStatus[] = [
			{
				name: "builder",
				conversationId: "w-1",
				role: "worker",
				state: "working",
				model: "gemini-4-neon-high",
				activity: "→ run_command\nnpm\ttest",
				startedAtMs: now - 15_000,
				lastAtMs: now - 1_000,
			},
			{
				name: "verifier",
				conversationId: "w-2",
				role: "reviewer",
				state: "parked",
				requestedModel: "gemini-3.8-flash-low",
				activity: "waiting on board",
				startedAtMs: now - 30_000,
				lastAtMs: now - 5_000,
			},
			{
				name: "finisher",
				conversationId: "w-3",
				role: "worker",
				state: "idle",
				requestedModel: "inherit",
				activity: "All checks green",
				startedAtMs: now - 20_000,
				lastAtMs: now - 2_000,
			},
			{
				name: "old-worker",
				conversationId: "w-4",
				role: "worker",
				state: "killed",
				startedAtMs: now - 40_000,
				lastAtMs: now - 3_000,
			},
		];

		const lines = renderActivityLines(
			{ agySessionId: CONV, tasks: [], swarmMembers: members, logTails: new Map() },
			now,
			0,
			plainTheme,
		);
		for (const line of lines) {
			assert.doesNotMatch(line, /[\r\n\t]/, `every widget line must be a single terminal row: ${JSON.stringify(line)}`);
		}
		assert.deepEqual(lines, [
			"Antigravity · 2 swarm workers",
			" ⠋ @builder  0:15  Gemini 4 Neon · Reasoning high  → run_command npm test",
			" ⏸ @verifier  reviewer  0:30  Gemini 3.8 Flash · Reasoning low  waiting on board",
			" ✓ @finisher  0:18  done: All checks green",
			" ✗ @old-worker  0:37  stopped",
		]);

		// Singular header for 1 active worker, and overflow cap at 6 lines.
		const oneActive = renderActivityLines(
			{ agySessionId: CONV, tasks: [], swarmMembers: [members[0]], logTails: new Map() },
			now,
			0,
			plainTheme,
		);
		assert.equal(oneActive[0], "Antigravity · 1 swarm worker");

		const eightWorkers: SwarmMemberStatus[] = Array.from({ length: 8 }, (_, idx) => ({
			name: `shard-${idx + 1}`,
			conversationId: `c-${idx + 1}`,
			role: "worker",
			state: "working",
			activity: `task ${idx + 1}`,
			startedAtMs: now - 10_000,
		}));
		const capped = renderActivityLines(
			{ agySessionId: CONV, tasks: [], swarmMembers: eightWorkers, logTails: new Map() },
			now,
			0,
			plainTheme,
		);
		assert.equal(capped.length, 8, "header + 6 workers + overflow line");
		assert.equal(capped[0], "Antigravity · 8 swarm workers");
		assert.equal(capped.at(-1), "   … 2 more swarm workers");

		// BackgroundActivityView shows widget and status badge for swarm-only snapshots and clears when empty.
		const ui = createControllerUiContext(os.tmpdir(), "pi-swarm-view");
		const view = new BackgroundActivityView();
		view.show(ui.ctx, { agySessionId: CONV, tasks: [], swarmMembers: [members[0], members[1]], logTails: new Map() });
		assert.equal(ui.widgets.at(-1)?.active, true);
		assert.equal(ui.statuses.at(-1)?.text, "agy ⏳ 2");
		view.show(ui.ctx, { agySessionId: CONV, tasks: [], swarmMembers: [], logTails: new Map() });
		assert.equal(ui.widgets.at(-1)?.active, false);
		assert.equal(ui.statuses.at(-1)?.text, undefined);
	});
});

describe("BackgroundActivityController usage_update handling", () => {
	function setupController(root: string, agySessionId: string) {
		const geminiDir = path.join(root, ".gemini");
		const logsDir = path.join(geminiDir, "antigravity-cli", "brain", agySessionId, ".system_generated", "logs");
		fs.mkdirSync(logsDir, { recursive: true });
		const transcriptFile = path.join(logsDir, "transcript_full.jsonl");
		const initial = [
			{ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-26T20:00:00Z", content: "start" },
			{ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T20:00:01Z", content: "started" },
		];
		fs.writeFileSync(transcriptFile, `${initial.map((l) => JSON.stringify(l)).join("\n")}\n`);

		const ui = createControllerUiContext(root, "pi-usage-test");
		const appended: Array<{ customType: string; data: unknown }> = [];
		const pi = {
			appendEntry: (customType: string, data?: unknown) => {
				appended.push({ customType, data });
			},
		};
		const coordinator: BackgroundCoordinatorLike = {
			config: { ...DEFAULT_BRIDGE_CONFIG, geminiDir },
			getActiveContext: () => ui.ctx,
			getTelemetrySnapshot: () => ({ agySessionId }),
			isAgySessionAlive: () => true,
		};
		const controller = new BackgroundActivityController(pi, coordinator);
		return { controller, transcriptFile, ui, appended };
	}

	function appendAutonomousTurn(transcriptFile: string, agySessionId: string, startStep: number, answer: string): void {
		const nowIso = new Date().toISOString();
		const lines = [
			JSON.stringify({
				step_index: startStep,
				source: "SYSTEM",
				type: "SYSTEM_MESSAGE",
				status: "DONE",
				created_at: nowIso,
				content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${nowIso} sender=${agySessionId}/task-1 priority=MESSAGE_PRIORITY_HIGH content=done\n</SYSTEM_MESSAGE>`,
			}),
			JSON.stringify({
				step_index: startStep + 1,
				source: "MODEL",
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: nowIso,
				content: answer,
			}),
		];
		fs.appendFileSync(transcriptFile, `${lines.join("\n")}\n`);
	}

	it("ignores idle usage_update without creating live activity", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-usage-idle-"));
		const { controller, ui } = setupController(root, CONV);
		try {
			controller.sync();
			controller.onOutOfTurnUpdate(CONV, { sessionUpdate: "usage_update", used: 1000, size: 100000 });
			assert.equal(ui.widgets.some((entry) => entry.active), false, "idle usage_update must never open the widget");
			assert.equal(
				ui.statuses.some((entry) => entry.text !== undefined),
				false,
				"idle usage_update must never set working status badge",
			);
		} finally {
			controller.stop();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accelerates completion via immediate and 150ms follow-up poll when usage_update arrives during live activity", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-usage-fast-"));
		const { controller, transcriptFile, ui, appended } = setupController(root, CONV);
		try {
			controller.sync();
			// Case 1: transcript already flushed when usage_update arrives -> immediate poll records turn synchronously.
			controller.onOutOfTurnUpdate(CONV, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Finished first job." },
			});
			assert.equal(ui.statuses.at(-1)?.text, "agy ⚙ on its own");
			appendAutonomousTurn(transcriptFile, CONV, 2, "Finished first job.");
			controller.onOutOfTurnUpdate(CONV, { sessionUpdate: "usage_update", used: 2000, size: 100000 });
			assert.equal(appended.length, 1, "immediate poll records flushed turn right away");
			assert.equal(appended[0].customType, AUTONOMOUS_ENTRY_TYPE);
			assert.ok(isAutonomousEntryData(appended[0].data));
			assert.equal(appended[0].data.text, "Finished first job.");
			assert.equal(ui.widgets.at(-1)?.active, false, "live widget clears immediately once card is recorded");

			// Case 2: transcript flushes 40ms AFTER usage_update -> 150ms follow-up poll catches it well before 1s interval.
			controller.onOutOfTurnUpdate(CONV, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Finished second job." },
			});
			assert.equal(ui.statuses.at(-1)?.text, "agy ⚙ on its own");
			controller.onOutOfTurnUpdate(CONV, { sessionUpdate: "usage_update", used: 2500, size: 100000 });
			assert.equal(appended.length, 1, "turn not flushed yet during immediate poll");
			await sleep(40);
			appendAutonomousTurn(transcriptFile, CONV, 4, "Finished second job.");
			await sleep(200);
			assert.equal(appended.length, 2, "150ms follow-up poll records delayed flush promptly");
			assert.ok(isAutonomousEntryData(appended[1].data));
			assert.equal(appended[1].data.text, "Finished second job.");
			assert.equal(ui.widgets.at(-1)?.active, false, "live widget clears after follow-up poll");
		} finally {
			controller.stop();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("cancels pending usage_update follow-up poll on clearLive() and stop() without leaking timers", async () => {
		const root1 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-usage-clear-"));
		const first = setupController(root1, CONV);
		try {
			first.controller.sync();
			// clearLive() must cancel the pending 150ms follow-up poll.
			first.controller.onOutOfTurnUpdate(CONV, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Streaming before clearLive..." },
			});
			first.controller.onOutOfTurnUpdate(CONV, { sessionUpdate: "usage_update", used: 2900, size: 100000 });
			first.controller.clearLive();
			appendAutonomousTurn(first.transcriptFile, CONV, 2, "Flushed after clearLive");
			await sleep(250);
			assert.equal(first.appended.length, 0, "clearLive() must cancel the 150ms follow-up poll");
		} finally {
			first.controller.stop();
			fs.rmSync(root1, { recursive: true, force: true });
		}

		const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-usage-stop-"));
		const second = setupController(root2, CONV);
		try {
			second.controller.sync();
			// Re-scheduling and calling stop() must cancel the follow-up poll and stop the watcher cleanly.
			second.controller.onOutOfTurnUpdate(CONV, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Streaming..." },
			});
			second.controller.onOutOfTurnUpdate(CONV, { sessionUpdate: "usage_update", used: 3000, size: 100000 });
			second.controller.onOutOfTurnUpdate(CONV, { sessionUpdate: "usage_update", used: 3100, size: 100000 });
			second.controller.stop();
			appendAutonomousTurn(second.transcriptFile, CONV, 2, "Flushed after stop");
			await sleep(250);
			assert.equal(second.appended.length, 0, "stopped controller must never poll after stop()");
		} finally {
			second.controller.stop();
			fs.rmSync(root2, { recursive: true, force: true });
		}
	});
});
