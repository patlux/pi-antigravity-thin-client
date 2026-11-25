import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

/** Minimal interactive context: the coordinator reads `hasUI`, `cwd` and the status bar. */
export function interactiveContext(cwd: string): ExtensionContext {
	const stub = { hasUI: true, cwd, ui: { setStatus() {} } };
	if (!isStubContext(stub)) {
		throw new Error("stub context lacks hasUI/cwd");
	}
	return stub;
}
