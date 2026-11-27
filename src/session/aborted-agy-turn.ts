import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolMode } from "../config.ts";
import { AGY_MIRROR_TOOL_NAMES } from "../tools/agy-renderers.ts";

const MIRROR_TOOL_NAMES: ReadonlySet<string> = new Set(AGY_MIRROR_TOOL_NAMES);

/**
 * Thin client: in `agy-tools` mode every tool call Pi shows is a mirror of a tool agy
 * ran itself, and its result is agy's output. When the user stops such a turn, these
 * steps are already part of agy's own history. They do not need a replay, so the next
 * typed prompt can continue on the live agy session.
 *
 * Returns true for an assistant step that only calls mirror tools, or for the result of
 * a mirror tool. Other tool modes keep the stricter rule: Pi-executed tool results would
 * get lost, so they never pass.
 */
export function isAgyOwnedMirrorStep(
	message: AssistantMessage | ToolResultMessage,
	toolMode: ToolMode,
): boolean {
	if (toolMode !== "agy-tools") return false;
	if (message.role === "toolResult") {
		return MIRROR_TOOL_NAMES.has(message.toolName);
	}
	if (message.stopReason !== "toolUse") return false;
	const toolCalls = message.content.filter((block) => block.type === "toolCall");
	return toolCalls.length > 0 && toolCalls.every((call) => MIRROR_TOOL_NAMES.has(call.name));
}
