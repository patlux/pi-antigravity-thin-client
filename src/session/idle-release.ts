/**
 * Fork: stops the agy process of a Pi session that has been quiet for a while.
 *
 * Every `agy acp` process keeps the sign-ins of Antigravity's MCP servers in memory. Servers
 * that rotate refresh tokens revoke the whole sign-in when an outdated refresh token comes
 * back, and agy processes that slept for hours hold exactly such tokens. A process started for
 * the next prompt reads the current sign-in instead. The conversation continues through its turn
 * anchor (`session/resume`), as after a Pi restart.
 */
import * as path from "node:path";
import { AgyActivityWatcher } from "../background/activity-watcher.ts";
import { type BridgeConfig, resolveAgyAppDataDir } from "../config.ts";

/** How often the idle check runs. */
export const IDLE_RELEASE_SWEEP_MS = 60_000;

/**
 * True while agy still works in this conversation without a prompt from Pi: an unfinished
 * background command, timer or cron task, a turn it takes on its own, or a working subagent or
 * swarm member. Stopping the process would end that work. Read errors count as work.
 */
export function agyHasPendingWork(config: BridgeConfig, agySessionId: string): boolean {
	try {
		const watcher = new AgyActivityWatcher({
			agySessionId,
			systemDir: path.join(resolveAgyAppDataDir(config), "brain", agySessionId, ".system_generated"),
			isAlive: () => true,
			onSnapshot: () => {},
			onTurnFinished: () => {},
		});
		const activity = watcher.refresh();
		if (activity.tasks.some((task) => !task.finished)) return true;
		if (activity.turns.some((turn) => turn.state === "running")) return true;
		if (watcher.subagents().some((status) => status.state === "working")) return true;
		return watcher
			.swarmMembers()
			.some((member) => member.state === "working" || member.state === "parked");
	} catch {
		return true;
	}
}

export interface IdleReleaseTarget {
	releaseIdleAgyProcesses(options: { idleMs: number }): Promise<number>;
}

/** Runs the idle check every `IDLE_RELEASE_SWEEP_MS` while `idleMinutes()` is above 0. */
export class IdleAgyReleaser {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private readonly target: IdleReleaseTarget;
	private readonly idleMinutes: () => number;

	constructor(target: IdleReleaseTarget, idleMinutes: () => number) {
		this.target = target;
		this.idleMinutes = idleMinutes;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.sweep().catch(() => {});
		}, IDLE_RELEASE_SWEEP_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** One idle check; overlapping calls are skipped. */
	async sweep(): Promise<number> {
		const minutes = this.idleMinutes();
		if (this.running || minutes <= 0) return 0;
		this.running = true;
		try {
			return await this.target.releaseIdleAgyProcesses({ idleMs: minutes * 60_000 });
		} finally {
			this.running = false;
		}
	}
}
