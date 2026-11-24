import type { BridgeConfig } from "./config.ts";

/**
 * Local thin-client policy for consumer `oauth-personal` use.
 *
 * Google's stated boundary for the Antigravity subscription allows an ACP client
 * only as a thin frontend: the human sends raw prompts, and Antigravity owns its
 * sign-in, system prompt, tools and session history. This fork therefore pins the
 * bridge to the `agy-tools` mode, never bridges Pi's MCP servers, skills or rules,
 * never writes into agy's private conversation databases, never replays Pi's
 * transcript or compaction summaries, never runs auxiliary requests (compaction,
 * titles, recaps) and refuses headless use (subagents, workflows, `pi -p`).
 */
export function enforceThinClientPolicy(config: BridgeConfig): BridgeConfig {
	return {
		...config,
		toolMode: "agy-tools",
		bridgePiMcp: false,
		bridgePiSkills: false,
		bridgePiAgentsMd: false,
		enableSqliteFork: false,
	};
}

export class ThinClientPolicyError extends Error {
	constructor(reason: string) {
		super(`Antigravity (thin client): ${reason}`);
		this.name = "ThinClientPolicyError";
	}
}

export const REPLAY_REFUSED =
	"refusing to replay earlier conversation into Antigravity (model switch, compaction, branch navigation or a lost agy session). Start a new Pi session (/new) and select the Antigravity model before the first message.";

export const AUXILIARY_REFUSED =
	"refusing auxiliary request (compaction summary, title, recap or similar). Antigravity serves only prompts typed by the user.";

export const HEADLESS_REFUSED =
	"refusing headless use. Antigravity is available only in an interactive Pi session, not in subagents, workflows or `pi -p`.";
