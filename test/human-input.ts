import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { HumanPromptGate } from "../src/human-prompt-gate.ts";

function textOf(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Reports user messages the way Pi does for typed input: `input`, then `message_start`. */
export function typedByHuman(gate: HumanPromptGate, ...messages: UserMessage[]): void {
	for (const message of messages) {
		gate.noteInput("interactive", textOf(message));
		gate.noteUserMessage(message);
	}
}

function isStubContext(value: object): value is ExtensionContext {
	return "hasUI" in value && "cwd" in value;
}

/**
 * Minimal interactive context: the coordinator reads `hasUI`, `cwd` and the status bar.
 * `extra` adds stubbed members such as `sessionManager`.
 */
export function interactiveContext(cwd: string, extra: object = {}): ExtensionContext {
	const stub = { ...extra, hasUI: true, cwd, ui: { setStatus() {} } };
	if (!isStubContext(stub)) {
		throw new Error("stub context lacks hasUI/cwd");
	}
	return stub;
}

function isStubToolContext(value: object): value is ExtensionToolContext {
	return "hasUI" in value && "cwd" in value;
}

/** Same stub for mirror tool `execute()`, which takes a tool context. */
export function interactiveToolContext(cwd: string): ExtensionToolContext {
	const stub = { hasUI: true, cwd, ui: { setStatus() {} } };
	if (!isStubToolContext(stub)) {
		throw new Error("stub context lacks hasUI/cwd");
	}
	return stub;
}
