import * as fs from "node:fs";
import * as path from "node:path";
import { type BridgeConfig, resolveAgyConversationsDir } from "../config.ts";
import type { SqliteDbCheckpoint } from "./checkpoint-sync.ts";

/**
 * agy's `steps.step_type` for a prompt sent by a client (`USER_INPUT`). A turn agy
 * takes on its own starts with a `SYSTEM_MESSAGE` step (type 101) instead.
 */
const USER_INPUT_STEP_TYPE = 14;

/**
 * What happened to agy's conversation since Pi stored an anchor for it:
 * - `continued`: unchanged, or only agy itself went on (background tasks, timers,
 *   subagents and the turns they wake). Pi can reattach with `session/resume`.
 * - `prompted`: a client prompt reached the conversation after the anchor, from a later
 *   Pi message on another branch, a forked Pi session or another ACP client. Reattaching
 *   would continue after messages this Pi branch does not show.
 * - `lost`: the conversation is gone, unreadable or shorter than at the anchor.
 */
export type AgyConversationSinceAnchor = "continued" | "prompted" | "lost";

/**
 * Compares agy's conversation with the anchor's checkpoint. Reads agy's database
 * read-only and sends nothing to agy.
 */
export async function checkAgyConversationSinceAnchor(
	config: BridgeConfig,
	agySessionId: string,
	saved: SqliteDbCheckpoint,
	current: SqliteDbCheckpoint | undefined,
): Promise<AgyConversationSinceAnchor> {
	if (
		!current ||
		current.steps < saved.steps ||
		current.generations < saved.generations ||
		current.executions < saved.executions
	) {
		return "lost";
	}
	// Equal counts with another fingerprint are agy's own work too: a step that went to
	// the background changes its status and output when the task ends.
	if (current.steps === saved.steps) {
		return "continued";
	}
	const prompts = await countUserInputStepsSince(config, agySessionId, saved.steps);
	if (prompts === undefined) return "lost";
	return prompts > 0 ? "prompted" : "continued";
}

async function countUserInputStepsSince(
	config: BridgeConfig,
	agySessionId: string,
	fromStep: number,
): Promise<number | undefined> {
	const dbPath = path.join(resolveAgyConversationsDir(config), `${agySessionId}.db`);
	if (!fs.existsSync(dbPath)) return undefined;
	let sqlite: typeof import("node:sqlite");
	try {
		sqlite = await import("node:sqlite");
	} catch {
		return undefined;
	}
	let db: import("node:sqlite").DatabaseSync | undefined;
	try {
		db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
		db.exec("PRAGMA busy_timeout = 1500");
		const row = db
			.prepare("SELECT COUNT(*) AS prompts FROM steps WHERE idx >= ? AND step_type = ?")
			.get(fromStep, USER_INPUT_STEP_TYPE);
		const prompts = row?.prompts;
		return typeof prompts === "number" ? prompts : undefined;
	} catch {
		return undefined;
	} finally {
		try {
			db?.close();
		} catch {
			// The read already finished; nothing to clean up.
		}
	}
}
