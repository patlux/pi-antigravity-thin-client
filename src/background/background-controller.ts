import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAgyAppDataDir } from "../config.ts";
import type { TurnCoordinator } from "../session/turn-coordinator.ts";
import type { EmptyResultContext } from "../tools/agy-mirror-tools.ts";
import {
	AUTONOMOUS_ENTRY_TYPE,
	BackgroundActivityView,
	isAutonomousEntryData,
	toAutonomousEntryData,
} from "../ui/background-activity.ts";
import { AgyActivityWatcher } from "./activity-watcher.ts";
import type { AutonomousTurn } from "./agy-activity.ts";

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
	private readonly pi: ExtensionAPI;
	private readonly coordinator: TurnCoordinator;
	private readonly view = new BackgroundActivityView();
	private watcher: AgyActivityWatcher | undefined;

	constructor(pi: ExtensionAPI, coordinator: TurnCoordinator) {
		this.pi = pi;
		this.coordinator = coordinator;
	}

	/** Follows the agy conversation behind the current Pi session. */
	sync(ctx: ExtensionContext | undefined = this.coordinator.getActiveContext()): void {
		if (!ctx) return;
		let piSessionId: string | undefined;
		try {
			piSessionId = ctx.sessionManager.getSessionId();
		} catch {
			return;
		}
		const agySessionId = this.coordinator.getTelemetrySnapshot(piSessionId).agySessionId;
		if (!agySessionId || this.watcher?.agySessionId === agySessionId) return;
		this.stop();
		const recorded = recordedStartSteps(ctx, agySessionId);
		this.watcher = new AgyActivityWatcher({
			agySessionId,
			systemDir: path.join(
				resolveAgyAppDataDir(this.coordinator.config),
				"brain",
				agySessionId,
				".system_generated",
			),
			isAlive: () => this.coordinator.isAgySessionAlive(agySessionId),
			onSnapshot: (snapshot) => this.view.show(this.coordinator.getActiveContext(), snapshot),
			onTurnFinished: (turn) => this.record(agySessionId, turn),
			alreadyRecorded: (startStep) => recorded.has(startStep),
		});
		this.watcher.start();
	}

	/** Text for a mirror tool card that agy finished without output. */
	emptyResultNote(context: EmptyResultContext): string | undefined {
		this.sync();
		const watcher = this.watcher;
		if (!watcher || watcher.agySessionId !== context.agySessionId) return undefined;
		if (context.kind === "execute" && context.command) {
			const task = watcher.findCommandTask(context.command);
			if (task) {
				return `⏳ Läuft im Hintergrund als ${task.taskId}. Fortschritt und Ergebnis zeigt die Antigravity-Anzeige über dem Eingabefeld.`;
			}
		}
		if (context.toolName === "schedule") {
			const timer = watcher.latestTimer();
			if (timer) {
				return `⏰ Timer ${timer.timerSeconds ?? "?"} s gestellt (${timer.taskId}). Läuft er ab, macht Antigravity von selbst weiter.`;
			}
		}
		return undefined;
	}

	stop(): void {
		this.watcher?.stop();
		this.watcher = undefined;
		this.view.clear();
	}

	private record(agySessionId: string, turn: AutonomousTurn): void {
		this.pi.appendEntry(AUTONOMOUS_ENTRY_TYPE, toAutonomousEntryData(agySessionId, turn));
		const ctx = this.coordinator.getActiveContext();
		if (ctx?.hasUI) {
			ctx.ui.notify("Antigravity hat selbstständig weitergearbeitet", "info");
		}
	}
}
