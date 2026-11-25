import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { AcpUpdateTrace } from "../src/acp/update-trace.ts";

describe("AcpUpdateTrace", () => {
	it("stays off without PI_AGY_TRACE", () => {
		const trace = new AcpUpdateTrace({});
		assert.equal(trace.path, undefined);
		trace.record(
			{
				sessionId: "s1",
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
			},
			false,
		);
	});

	it("writes one JSON line per update with the Pi turn state", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-trace-"));
		try {
			const file = path.join(dir, "trace.jsonl");
			const trace = new AcpUpdateTrace({ PI_AGY_TRACE: file });
			trace.record(
				{
					sessionId: "s1",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fertig" } },
				},
				false,
			);
			trace.record({ sessionId: "s1", update: { sessionUpdate: "usage_update", used: 10, size: 100 } }, true);
			const lines = fs.readFileSync(file, "utf8").trim().split("\n");
			assert.equal(lines.length, 2);
			const first: unknown = JSON.parse(lines[0]);
			assert.deepEqual(
				first && typeof first === "object" ? { ...first, at: "x" } : first,
				{
					at: "x",
					sessionId: "s1",
					sessionUpdate: "agent_message_chunk",
					piTurnActive: false,
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fertig" } },
				},
			);
			assert.match(lines[1], /"piTurnActive":true/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses a temp file for PI_AGY_TRACE=1", () => {
		const trace = new AcpUpdateTrace({ PI_AGY_TRACE: "1" });
		assert.equal(trace.path, path.join(os.tmpdir(), `pi-agy-trace-${process.pid}.jsonl`));
	});
});
