import { createHash } from "node:crypto";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { InputSource } from "@earendil-works/pi-coding-agent";
import {
	AUTOMATED_PROMPT_REFUSED,
	NO_NEW_PROMPT_REFUSED,
	RETRY_REFUSED,
	ThinClientPolicyError,
} from "./thin-client-policy.ts";

/** Upper bound for remembered inputs and messages; only the latest few turns matter. */
const MAX_PENDING_INPUTS = 16;
const MAX_REMEMBERED_MESSAGES = 256;

interface PendingInput {
	source: InputSource;
	text: string;
}

/** A user-role message as Pi hands it to extensions and providers. */
export interface GateUserMessage {
	timestamp: number;
	content: UserMessage["content"];
}

function messageText(message: GateUserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function imageCount(message: GateUserMessage): number {
	if (typeof message.content === "string") return 0;
	return message.content.filter((block) => block.type === "image").length;
}

/**
 * Identity of one user-role message across Pi's events and the provider context.
 * Custom messages that Pi converts to the user role keep their own timestamp and
 * text, so they never share a key with the prompt they were injected next to.
 */
export function userMessageKey(message: GateUserMessage): string {
	const digest = createHash("sha256").update(messageText(message)).digest("hex").slice(0, 32);
	return `${message.timestamp}:${imageCount(message)}:${digest}`;
}

function rememberBounded(set: Set<string>, key: string): void {
	set.delete(key);
	set.add(key);
	while (set.size > MAX_REMEMBERED_MESSAGES) {
		const oldest = set.values().next();
		if (oldest.done) break;
		set.delete(oldest.value);
	}
}

/**
 * Thin-client guard: only prompts the human typed into Pi reach Antigravity, and each
 * of them only once.
 *
 * Pi reports typed input through the `input` event (`source: "interactive"`) and the
 * resulting user message through `message_start`. Messages written by extensions
 * (`pi.sendUserMessage`, `pi.sendMessage`, injected context such as pi-goal),
 * RPC input, `!` shell output and Pi's automatic retries never get a human mark, so
 * the coordinator refuses to send them.
 */
export class HumanPromptGate {
	private readonly pending: PendingInput[] = [];
	private readonly human = new Set<string>();
	private readonly dispatched = new Set<string>();

	/** Called for every Pi `input` event. */
	noteInput(source: InputSource, text: string): void {
		this.pending.push({ source, text });
		while (this.pending.length > MAX_PENDING_INPUTS) {
			this.pending.shift();
		}
	}

	/** Called for every user message Pi starts (`message_start` with role `user`). */
	noteUserMessage(message: GateUserMessage): void {
		const input = this.takeMatchingInput(messageText(message));
		if (input?.source === "interactive") {
			rememberBounded(this.human, userMessageKey(message));
		}
	}

	isHuman(message: GateUserMessage): boolean {
		return this.human.has(userMessageKey(message));
	}

	wasDispatched(message: GateUserMessage): boolean {
		return this.dispatched.has(userMessageKey(message));
	}

	/**
	 * Allows one prompt request when every new user message was typed by the human
	 * and none of them went to Antigravity before; marks them as sent.
	 * Throws a non-retryable policy error otherwise. An empty list is only valid
	 * while an Antigravity turn is still running (tool results flowing back).
	 */
	authorize(trailingUsers: readonly GateUserMessage[], continuesActiveTurn: boolean): void {
		if (trailingUsers.length === 0) {
			if (continuesActiveTurn) return;
			throw new ThinClientPolicyError(NO_NEW_PROMPT_REFUSED);
		}
		if (trailingUsers.some((message) => this.wasDispatched(message))) {
			throw new ThinClientPolicyError(RETRY_REFUSED);
		}
		if (trailingUsers.some((message) => !this.isHuman(message))) {
			throw new ThinClientPolicyError(AUTOMATED_PROMPT_REFUSED);
		}
		for (const message of trailingUsers) {
			rememberBounded(this.dispatched, userMessageKey(message));
		}
	}

	/**
	 * Pairs a started user message with the input that produced it. Text that Pi
	 * expanded from a `/skill:` or `/template` command no longer equals the typed
	 * input, so a pending slash command matches by position when no text does.
	 * Inputs older than the match were handled without a message and are dropped.
	 */
	private takeMatchingInput(text: string): PendingInput | undefined {
		let index = this.pending.findIndex(
			(input) =>
				input.text === text || (input.text.length > 0 && text.startsWith(input.text)),
		);
		if (index < 0) {
			index = this.pending.findIndex((input) => input.text.startsWith("/"));
		}
		if (index < 0) return undefined;
		const [input] = this.pending.splice(0, index + 1).slice(-1);
		return input;
	}
}

/** User messages after the last assistant message or tool result: the new prompt. */
export function trailingUserMessages(
	messages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
): UserMessage[] {
	const trailing: UserMessage[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") break;
		trailing.unshift(message);
	}
	return trailing;
}
