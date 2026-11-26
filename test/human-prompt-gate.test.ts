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
		let now = 10_000;
		const gate = new HumanPromptGate({ now: () => now });
		const expanded = user('<skill name="review">Review steps</skill>\n\nthe parser', 1);
		gate.noteInput("interactive", "/skill:review the parser");
		now += 100;
		gate.noteUserMessage(expanded);
		gate.authorize([expanded], false);

		const templateExpanded = user("Run the full release checklist for v0.3", 2);
		gate.noteInput("interactive", "/release v0.3");
		now += 500;
		gate.noteUserMessage(templateExpanded);
		gate.authorize([templateExpanded], false);

		const agyPrefixedTemplate = user("Expanded agy review template", 3);
		gate.noteInput("interactive", "/agy-review src/");
		now += 50;
		gate.noteUserMessage(agyPrefixedTemplate);
		gate.authorize([agyPrefixedTemplate], false);
	});

	it("accepts prompts whose leading or trailing whitespace was trimmed by Pi", () => {
		const gate = new HumanPromptGate();
		const trimmed = user("fix the build", 1);
		gate.noteInput("interactive", "  fix the build\n ");
		gate.noteUserMessage(trimmed);
		gate.authorize([trimmed], false);

		const prefixed = user("fix the build\nwith details", 2);
		gate.noteInput("interactive", "\tfix the build  ");
		gate.noteUserMessage(prefixed);
		gate.authorize([prefixed], false);
	});

	it("preserves empty-text image-only matching without letting whitespace authorize non-empty text", () => {
		const gate = new HumanPromptGate();
		const imageOnly: UserMessage = {
			role: "user",
			content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			timestamp: 1,
		};
		gate.noteInput("interactive", "");
		gate.noteUserMessage(imageOnly);
		gate.authorize([imageOnly], false);

		const whitespaceInputImageOnly: UserMessage = {
			role: "user",
			content: [{ type: "image", data: "BBBB", mimeType: "image/png" }],
			timestamp: 2,
		};
		gate.noteInput("interactive", "   \n  ");
		gate.noteUserMessage(whitespaceInputImageOnly);
		gate.authorize([whitespaceInputImageOnly], false);

		// A dangling whitespace-only input must never match a non-empty automated message.
		gate.noteInput("interactive", "   ");
		const automated = user("Continue the goal.", 3);
		gate.noteUserMessage(automated);
		assert.equal(gate.isHuman(automated), false);
		assert.throws(
			() => gate.authorize([automated], false),
			new RegExp(escape(AUTOMATED_PROMPT_REFUSED)),
		);
	});

	it("refuses stale slash commands, bridge-local /agy commands, and slash commands followed by non-interactive input", () => {
		let now = 50_000;
		const gate = new HumanPromptGate({ now: () => now });

		// Stale /goal command (> 2000 ms old) must not authorize a later automated message.
		gate.noteInput("interactive", "/goal start");
		now += 2_500;
		const staleGoalMsg = user("<goal>Continue working</goal>", 1);
		gate.noteUserMessage(staleGoalMsg);
		assert.equal(gate.isHuman(staleGoalMsg), false);
		assert.throws(
			() => gate.authorize([staleGoalMsg], false),
			new RegExp(escape(AUTOMATED_PROMPT_REFUSED)),
		);

		// Bridge-local /agy commands must never authorize an unrelated user-role message, even immediately.
		for (const cmd of ["/agy", "/agy status", "/AGY sessions"]) {
			gate.noteInput("interactive", cmd);
			now += 20;
			const afterBridgeCmd = user(`automated after ${cmd}`, now);
			gate.noteUserMessage(afterBridgeCmd);
			assert.equal(gate.isHuman(afterBridgeCmd), false, cmd);
			assert.throws(
				() => gate.authorize([afterBridgeCmd], false),
				new RegExp(escape(AUTOMATED_PROMPT_REFUSED)),
			);
		}

		// A recent slash command followed by a non-interactive input must not match an automated message.
		gate.noteInput("interactive", "/skill:review");
		now += 10;
		gate.noteInput("extension", "trigger");
		now += 10;
		const afterNonInteractive = user("Expanded automated message from extension", 4);
		gate.noteUserMessage(afterNonInteractive);
		assert.equal(gate.isHuman(afterNonInteractive), false);
		assert.throws(
			() => gate.authorize([afterNonInteractive], false),
			new RegExp(escape(AUTOMATED_PROMPT_REFUSED)),
		);

		// A fresh /skill:... after a stale /goal or /agy status still works cleanly.
		gate.noteInput("interactive", "/agy status");
		now += 10;
		gate.noteInput("interactive", "/skill:review parser");
		now += 50;
		const legitExpanded = user('<skill name="review">steps</skill>\n\nparser', 5);
		gate.noteUserMessage(legitExpanded);
		gate.authorize([legitExpanded], false);
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
