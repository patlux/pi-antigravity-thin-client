import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_BRIDGE_CONFIG, loadBridgeConfig } from "../src/config.ts";
import { agyHasPendingWork, IdleAgyReleaser } from "../src/session/idle-release.ts";

const CONV = "0f0f0f0f-1111-2222-3333-555555555555";

function line(obj: Record<string, unknown>): string {
	return JSON.stringify(obj);
}

/** A prompt that started `sleep 60` in the background, in agy's transcript format. */
function backgroundTaskLines(brain: string): string[] {
	return [
		line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T13:54:21Z", content: "<USER_REQUEST>\nRun `sleep 60` in the background\n</USER_REQUEST>" }),
		line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T13:54:22Z", tool_calls: [{ name: "run_command", args: { CommandLine: "\"sleep 60\"", WaitMsBeforeAsync: "500" } }] }),
		line({ step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-25T13:54:25Z", content: `Created At: 2026-11-25T14:54:25+01:00\nTool is running as a background task with task id: ${CONV}/task-2\nTask Description: sleep 60\nTask logs are available at: file://${brain}/${CONV}/.system_generated/tasks/task-2.log` }),
		line({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T13:54:27Z", content: "Running in the background." }),
	];
}

function finishedLines(): string[] {
	return [
		line({ step_index: 4, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-25T13:55:26Z", content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-25T13:55:26Z sender=${CONV}/task-2 priority=MESSAGE_PRIORITY_HIGH content=Task id "${CONV}/task-2" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>` }),
		line({ step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T13:55:27Z", content: "The background task is done." }),
	];
}

function withGeminiDir(run: (config: typeof DEFAULT_BRIDGE_CONFIG, brain: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-idle-"));
	try {
		const config = { ...DEFAULT_BRIDGE_CONFIG, geminiDir: path.join(root, ".gemini") };
		run(config, path.join(config.geminiDir, config.appDataDirName, "brain"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function writeTranscript(brain: string, lines: string[]): void {
	const logs = path.join(brain, CONV, ".system_generated", "logs");
	fs.mkdirSync(logs, { recursive: true });
	fs.writeFileSync(path.join(logs, "transcript.jsonl"), lines.map((l) => `${l}\n`).join(""));
}

describe("idle release of agy processes", () => {
	it("keeps the process while a background task runs and lets it go once the task finished", () => {
		withGeminiDir((config, brain) => {
			assert.equal(agyHasPendingWork(config, CONV), false, "no files: nothing runs");
			writeTranscript(brain, backgroundTaskLines(brain));
			assert.equal(agyHasPendingWork(config, CONV), true);
			writeTranscript(brain, [...backgroundTaskLines(brain), ...finishedLines()]);
			assert.equal(agyHasPendingWork(config, CONV), false);
		});
	});

	it("runs the check with the configured minutes and never when they are 0", async () => {
		const calls: number[] = [];
		let minutes = 0;
		const releaser = new IdleAgyReleaser(
			{
				releaseIdleAgyProcesses: async ({ idleMs }) => {
					calls.push(idleMs);
					return 1;
				},
			},
			() => minutes,
		);
		assert.equal(await releaser.sweep(), 0);
		minutes = 30;
		assert.equal(await releaser.sweep(), 1);
		assert.deepEqual(calls, [30 * 60_000]);
	});

	it("reads idleReleaseMinutes from antigravity.json and PI_AGY_IDLE_RELEASE_MINUTES", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-idle-config-"));
		try {
			assert.equal(loadBridgeConfig({ env: { PI_CODING_AGENT_DIR: root } }).idleReleaseMinutes, 30);
			fs.writeFileSync(path.join(root, "antigravity.json"), JSON.stringify({ idleReleaseMinutes: 0 }));
			assert.equal(loadBridgeConfig({ env: { PI_CODING_AGENT_DIR: root } }).idleReleaseMinutes, 0);
			const fromEnv = loadBridgeConfig({
				env: { PI_CODING_AGENT_DIR: root, PI_AGY_IDLE_RELEASE_MINUTES: "5" },
			});
			assert.equal(fromEnv.idleReleaseMinutes, 5);
			const invalid = loadBridgeConfig({
				env: { PI_CODING_AGENT_DIR: root, PI_AGY_IDLE_RELEASE_MINUTES: "-1" },
			});
			assert.equal(invalid.idleReleaseMinutes, 0, "invalid values keep the file's value");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
