import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AcpSessionUpdatePayload } from "../acp/protocol.ts";
import { ANTIGRAVITY_PROVIDER_ID } from "../catalog/model-discovery.ts";
import { type BridgeConfig, resolveAgyAppDataDir } from "../config.ts";
import type { EmptyResultContext } from "../tools/agy-mirror-tools.ts";
import {
	AUTONOMOUS_ENTRY_TYPE,
	BackgroundActivityView,
	isAutonomousEntryData,
	isLiveFresh,
	LIVE_STALE_MS,
	type LiveActivity,
	subagentStartNote,
	toAutonomousEntryData,
} from "../ui/background-activity.ts";
import { type ActivitySnapshot, AgyActivityWatcher } from "./activity-watcher.ts";
import { type AutonomousTurn, formatDuration, singleLine } from "./agy-activity.ts";

const USAGE_FOLLOWUP_POLL_MS = 150;

export interface BackgroundCoordinatorLike {
	readonly config: BridgeConfig;
	getActiveContext(): ExtensionContext | undefined;
	getTelemetrySnapshot(piSessionId: string): { agySessionId?: string };
	isAgySessionAlive(agySessionId: string): boolean;
}

function recordedStartSteps(ctx: ExtensionContext | undefined, agySessionId: string): Set<number> {
	const steps = new Set<number>();
	if (!ctx) return steps;
	try {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== AUTONOMOUS_ENTRY_TYPE) continue;
			if (isAutonomousEntryData(entry.data) && entry.data.agySessionId === agySessionId) {
				steps.add(entry.data.startStep);
			}
		}
	} catch {
		// A replaced session context cannot be read any more; nothing to skip then.
	}
	return steps;
}

/**
 * Shows what Antigravity does between Pi turns: a live widget for its background
 * tasks and a card in the session for every turn it took on its own. Everything
 * here is local display; nothing is sent to agy or the model.
 */
export class BackgroundActivityController {
	private readonly pi: Pick<ExtensionAPI, "appendEntry">;
	private readonly coordinator: BackgroundCoordinatorLike;
	private readonly view = new BackgroundActivityView();
	private watcher: AgyActivityWatcher | undefined;
	private snapshot: ActivitySnapshot | undefined;
	private live: LiveActivity | undefined;
	private liveExpiry: NodeJS.Timeout | undefined;
	private usagePollTimer: NodeJS.Timeout | undefined;

	constructor(pi: Pick<ExtensionAPI, "appendEntry">, coordinator: BackgroundCoordinatorLike) {
		this.pi = pi;
		this.coordinator = coordinator;
	}

	private clearUsagePollTimer(): void {
		if (this.usagePollTimer) clearTimeout(this.usagePollTimer);
		this.usagePollTimer = undefined;
	}

	/**
	 * agy's updates while no Pi turn runs (agy >= 1.5.10 sends them right away when
	 * a task, timer or subagent wakes it up): shown live in the widget. The card
	 * with the finished turn still comes from agy's transcript, which marks exactly
	 * where the turn ends.
	 */
	onOutOfTurnUpdate(agySessionId: string, update: AcpSessionUpdatePayload): void {
		this.sync();
		const watcher = this.watcher;
		if (!watcher || watcher.agySessionId !== agySessionId) return;
		const now = Date.now();
		if (update.sessionUpdate === "usage_update") {
			if (!isLiveFresh(this.live, now)) return;
			watcher.poll();
			if (!this.live || this.watcher !== watcher) return;
			this.clearUsagePollTimer();
			this.usagePollTimer = setTimeout(() => {
				this.usagePollTimer = undefined;
				if (this.watcher !== watcher || !this.live) return;
				watcher.poll();
			}, USAGE_FOLLOWUP_POLL_MS);
			this.usagePollTimer.unref?.();
			return;
		}
		const live: LiveActivity = isLiveFresh(this.live, now)
			? this.live
			: { startedAtMs: now, lastAtMs: now, text: "", toolCalls: 0, thinking: false };
		live.lastAtMs = now;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text") {
					live.text = (live.text + update.content.text).slice(-600);
					live.tool = undefined;
					live.thinking = false;
				}
				break;
			case "agent_thought_chunk":
				live.thinking = true;
				break;
			case "tool_call":
				live.toolCalls++;
				live.tool = singleLine(update.title ?? "").trim() || update.kind || "Tool";
				break;
			case "tool_call_update":
				if (update.status === "completed" || update.status === "failed") live.tool = undefined;
				break;
			default:
				break;
		}
		this.live = live;
		if (this.liveExpiry) clearTimeout(this.liveExpiry);
		this.liveExpiry = setTimeout(() => {
			this.liveExpiry = undefined;
			this.render();
		}, LIVE_STALE_MS + 100);
		this.liveExpiry.unref?.();
		this.render();
	}

	/** Clears live out-of-turn activity (for example when the user starts a new turn). */
	clearLive(): void {
		this.live = undefined;
		if (this.liveExpiry) clearTimeout(this.liveExpiry);
		this.liveExpiry = undefined;
		this.clearUsagePollTimer();
		this.render();
	}

	/** Follows the agy conversation behind the current Pi session. */
	sync(ctx: ExtensionContext | undefined = this.coordinator.getActiveContext()): void {
		if (!ctx || ctx.model?.provider !== ANTIGRAVITY_PROVIDER_ID) {
			this.stop();
			return;
		}
		let piSessionId: string | undefined;
		try {
			piSessionId = ctx.sessionManager.getSessionId();
		} catch {
			this.stop();
			return;
		}
		const agySessionId = this.coordinator.getTelemetrySnapshot(piSessionId).agySessionId;
		if (!agySessionId) {
			this.stop();
			return;
		}
		if (this.watcher?.agySessionId === agySessionId) return;
		this.stop();
		const recorded = recordedStartSteps(ctx, agySessionId);
		const watcher = new AgyActivityWatcher({
			agySessionId,
			systemDir: path.join(
				resolveAgyAppDataDir(this.coordinator.config),
				"brain",
				agySessionId,
				".system_generated",
			),
			isAlive: () => this.coordinator.isAgySessionAlive(agySessionId),
			onSnapshot: (snapshot) => {
				if (this.watcher !== watcher) return;
				this.snapshot = snapshot;
				this.render();
			},
			onTurnFinished: (turn) => this.record(agySessionId, turn),
			alreadyRecorded: (startStep) => recorded.has(startStep),
		});
		this.watcher = watcher;
		watcher.start();
	}

	/** Text for a mirror tool card that agy finished without output. */
	emptyResultNote(context: EmptyResultContext): string | undefined {
		this.sync();
		const watcher = this.watcher;
		if (!watcher || watcher.agySessionId !== context.agySessionId) return undefined;
		if (context.kind === "execute" && context.command) {
			const task = watcher.findCommandTask(context.command);
			if (task) {
				return `⏳ Running in the background as ${task.taskId}. The Antigravity panel above the editor shows its progress and result.`;
			}
		}
		if (context.toolName === "invoke_subagent") {
			return this.subagentNote(context);
		}
		if (context.toolName === "schedule") {
			const timer = watcher.latestTimer();
			if (timer) {
				const duration = timer.timerSeconds !== undefined ? formatDuration(timer.timerSeconds) : "?";
				return `⏰ Timer set for ${duration} (${timer.taskId}). When it expires, Antigravity continues on its own.`;
			}
		}
		return undefined;
	}

	/** Card text for `invoke_subagent`: who runs, on which model, with which task. */
	private subagentNote(context: EmptyResultContext): string {
		const args = context.args;
		const role = typeof args.agentRole === "string" ? args.agentRole : undefined;
		const single = typeof args.agentCount !== "number" || args.agentCount <= 1;
		return subagentStartNote(args, single ? this.watcher?.findSubagent(role) : undefined);
	}

	stop(): void {
		this.watcher?.stop();
		this.watcher = undefined;
		this.snapshot = undefined;
		this.live = undefined;
		if (this.liveExpiry) clearTimeout(this.liveExpiry);
		this.liveExpiry = undefined;
		this.clearUsagePollTimer();
		this.view.clear();
	}

	private render(): void {
		const watcher = this.watcher;
		if (!watcher) return;
		const ctx = this.coordinator.getActiveContext();
		if (!ctx || ctx.model?.provider !== ANTIGRAVITY_PROVIDER_ID) {
			this.view.clear();
			return;
		}
		const base: ActivitySnapshot = this.snapshot ?? {
			agySessionId: watcher.agySessionId,
			tasks: [],
			logTails: new Map(),
		};
		this.view.show(ctx, { ...base, live: this.live });
	}

	private record(agySessionId: string, turn: AutonomousTurn): void {
		if (this.watcher?.agySessionId !== agySessionId) return;
		const ctx = this.coordinator.getActiveContext();
		if (!ctx || ctx.model?.provider !== ANTIGRAVITY_PROVIDER_ID) return;
		let piSessionId: string | undefined;
		try {
			piSessionId = ctx.sessionManager.getSessionId();
		} catch {
			return;
		}
		if (this.coordinator.getTelemetrySnapshot(piSessionId).agySessionId !== agySessionId) {
			return;
		}
		// The finished turn replaces the live line.
		if (this.live && (turn.endedAtMs ?? Date.now()) >= this.live.startedAtMs - 5_000) {
			this.live = undefined;
			if (this.liveExpiry) clearTimeout(this.liveExpiry);
			this.liveExpiry = undefined;
			this.clearUsagePollTimer();
			this.render();
		}
		this.pi.appendEntry(AUTONOMOUS_ENTRY_TYPE, toAutonomousEntryData(agySessionId, turn));
		if (ctx.hasUI) {
			ctx.ui.notify("Antigravity continued on its own", "info");
		}
	}
}
