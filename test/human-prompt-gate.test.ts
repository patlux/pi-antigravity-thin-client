import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRetryableAssistantError, type AssistantMessage, type UserMessage } from "@earendil-works/pi-ai";
import { HumanPromptGate, trailingUserMessages } from "../src/human-prompt-gate.ts";
import {
	AUTOMATED_PROMPT_REFUSED,
	NO_NEW_PROMPT_REFUSED,
	REPLAY_REFUSED,
	RESUME_DIVERGED_REFUSED,
	RETRY_REFUSED,
	ThinClientPolicyError,
} from "../src/thin-client-policy.ts";

function user(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(stopReason: AssistantMessage["stopReason"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "antigravity-acp",
		provider: "antigravity",
		model: "gemini-4-neon",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

describe("HumanPromptGate", () => {
	it("sends a typed prompt once and refuses the automatic retry of it", () => {
		const gate = new HumanPromptGate();
		const prompt = user("fix the build", 1);
		gate.noteInput("interactive", "fix the build");
		gate.noteUserMessage(prompt);

		gate.authorize([prompt], false);
		assert.throws(() => gate.authorize([{ ...prompt }], false), new RegExp(escape(RETRY_REFUSED)));
	});

	it("refuses messages from extensions, RPC and injected context", () => {
		const gate = new HumanPromptGate();

		const viaExtension = user("Continue the goal.", 1);
		gate.noteInput("extension", "Continue the goal.");
		gate.noteUserMessage(viaExtension);
		assert.throws(() => gate.authorize([viaExtension], false), new RegExp(escape(AUTOMATED_PROMPT_REFUSED)));

		const viaRpc = user("run it", 2);
		gate.noteInput("rpc", "run it");
		gate.noteUserMessage(viaRpc);
		assert.throws(() => gate.authorize([viaRpc], false), new RegExp(escape(AUTOMATED_PROMPT_REFUSED)));

		// pi.sendMessage(..., { triggerTurn: true }): no input event at all.
		const customAsUser = user("<goal>keep going</goal>", 3);
		assert.throws(() => gate.authorize([customAsUser], false), new RegExp(escape(AUTOMATED_PROMPT_REFUSED)));
	});

	it("refuses context injected next to a typed prompt, even with the same timestamp", () => {
		const gate = new HumanPromptGate();
		const typed = user("deploy now", 5);
		const injected = user("<goal-context>active goal</goal-context>", 5);
		gate.noteInput("interactive", "deploy now");
		gate.noteUserMessage(typed);

		assert.equal(gate.isHuman(typed), true);
		assert.equal(gate.isHuman(injected), false);
		assert.throws(() => gate.authorize([injected, typed], false), new RegExp(escape(AUTOMATED_PROMPT_REFUSED)));
		// The refused request sent nothing, so the typed prompt is still unsent.
		assert.equal(gate.wasDispatched(typed), false);
	});

	it("accepts skill and template expansions of typed slash commands", () => {
		const gate = new HumanPromptGate();
		const expanded = user('<skill name="review">Review steps</skill>\n\nthe parser', 1);
		gate.noteInput("interactive", "/skill:review the parser");
		gate.noteUserMessage(expanded);
		gate.authorize([expanded], false);
	});

	it("does not lend a handled input to a later extension message", () => {
		const gate = new HumanPromptGate();
		// Another extension handled this input; no message followed.
		gate.noteInput("interactive", "ping");
		const fromExtension = user("status report", 2);
		gate.noteInput("extension", "status report");
		gate.noteUserMessage(fromExtension);
		assert.equal(gate.isHuman(fromExtension), false);
	});

	it("keeps typed steering messages and their order", () => {
		const gate = new HumanPromptGate();
		const first = user("also check tests", 1);
		const second = user("and the docs", 2);
		gate.noteInput("interactive", "also check tests");
		gate.noteInput("interactive", "and the docs");
		gate.noteUserMessage(first);
		gate.noteUserMessage(second);
		gate.authorize([first, second], true);
	});

	it("allows a request without a new prompt only while an agy turn is running", () => {
		const gate = new HumanPromptGate();
		gate.authorize([], true);
		assert.throws(() => gate.authorize([], false), new RegExp(escape(NO_NEW_PROMPT_REFUSED)));
	});

	it("finds the new prompt after the last answer or tool result", () => {
		const earlier = user("earlier", 1);
		const next = user("next", 4);
		assert.deepEqual(trailingUserMessages([earlier, assistant("error", 2), next]), [next]);
		assert.deepEqual(trailingUserMessages([earlier, assistant("stop", 2)]), []);
	});

	it("words every refusal so that Pi does not retry it", () => {
		for (const reason of [
			RETRY_REFUSED,
			AUTOMATED_PROMPT_REFUSED,
			NO_NEW_PROMPT_REFUSED,
			REPLAY_REFUSED,
			RESUME_DIVERGED_REFUSED,
		]) {
			const failed = assistant("error", 1);
			failed.errorMessage = new ThinClientPolicyError(reason).message;
			assert.equal(isRetryableAssistantError(failed), false, reason);
		}
		const quota = assistant("error", 1);
		quota.errorMessage =
			"Antigravity quota exceeded (429): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted.";
		assert.equal(isRetryableAssistantError(quota), false);
	});
});

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
