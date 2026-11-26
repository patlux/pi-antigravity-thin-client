import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ActivitySnapshot } from "../background/activity-watcher.ts";
import {
	type AutonomousAction,
	type AutonomousTrigger,
	type AutonomousTurn,
	type BackgroundTask,
	formatDuration,
	type SubagentStatus,
	singleLine,
	splitAgyModel,
	type TriggerOutcome,
} from "../background/agy-activity.ts";

let modelNames: (baseId: string) => string | undefined = () => undefined;

/** Display names of agy models (from the bridge's model catalog). */
export function setAgyModelNames(lookup: (baseId: string) => string | undefined): void {
	modelNames = lookup;
}

function titleCase(id: string): string {
	return id
		.split("-")
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/** `gemini-4-neon-high` → "Gemini 4 Neon · Reasoning high". */
export function formatAgyModel(id: string | undefined): string | undefined {
	if (!id?.trim()) return undefined;
	const { baseId, reasoning } = splitAgyModel(id);
	const name = modelNames(baseId) ?? titleCase(baseId);
	return reasoning ? `${name} · Reasoning ${reasoning}` : name;
}

/** Session entry for a turn agy took on its own (TUI only, never in the model context). */
export const AUTONOMOUS_ENTRY_TYPE = "antigravity-autonomous";
const WIDGET_KEY = "antigravity-background";
const STATUS_KEY = "antigravity-background";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;

/** After this long without an update, live activity is no longer shown. */
export const LIVE_STALE_MS = 20_000;

/** What agy streams over ACP while it works on its own (no Pi turn running). */
export interface LiveActivity {
	startedAtMs: number;
	lastAtMs: number;
	/** Tail of the answer agy is writing. */
	text: string;
	/** Title of the last tool call agy started. */
	tool?: string;
	toolCalls: number;
	thinking: boolean;
}

/** Everything the widget shows. */
export interface ActivityDisplay extends ActivitySnapshot {
	live?: LiveActivity;
}

export function isLiveFresh(live: LiveActivity | undefined, now: number): live is LiveActivity {
	return live !== undefined && now - live.lastAtMs < LIVE_STALE_MS;
}

/** The theme methods these renderers use; Pi's `Theme` satisfies it. */
export interface ThemeLike {
	fg(color: "accent" | "muted" | "dim" | "success" | "error" | "warning" | "toolTitle" | "toolOutput" | "customMessageLabel" | "customMessageText", text: string): string;
	bg(color: "customMessageBg", text: string): string;
	bold(text: string): string;
}

export interface AutonomousEntryData {
	version: 1;
	agySessionId: string;
	/** Model and reasoning level agy answered with (`gemini-4-neon-high`). */
	model?: string;
	startStep: number;
	endStep?: number;
	startedAtMs?: number;
	endedAtMs?: number;
	state: "done" | "interrupted";
	triggers: AutonomousTrigger[];
	actions: AutonomousAction[];
	text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAutonomousEntryData(value: unknown): value is AutonomousEntryData {
	return (
		isRecord(value) &&
		value.version === 1 &&
		typeof value.agySessionId === "string" &&
		typeof value.startStep === "number" &&
		Array.isArray(value.triggers) &&
		Array.isArray(value.actions) &&
		typeof value.text === "string"
	);
}

export function toAutonomousEntryData(agySessionId: string, turn: AutonomousTurn): AutonomousEntryData {
	return {
		version: 1,
		agySessionId,
		...(turn.model ? { model: turn.model } : {}),
		startStep: turn.startStep,
		endStep: turn.endStep,
		startedAtMs: turn.startedAtMs,
		endedAtMs: turn.endedAtMs,
		state: turn.state === "interrupted" ? "interrupted" : "done",
		triggers: turn.triggers,
		actions: turn.actions,
		text: turn.texts.join("\n\n"),
	};
}

export function formatClock(ms: number | undefined): string {
	if (ms === undefined) return "";
	return new Date(ms).toLocaleTimeString("de-DE", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
	const ss = String(seconds).padStart(2, "0");
	return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function outcomeMark(outcome: TriggerOutcome | undefined, theme: ThemeLike): string {
	switch (outcome) {
		case "running":
			return theme.fg("muted", "⏳");
		case "failed":
			return theme.fg("error", "✗");
		case "canceled":
			return theme.fg("warning", "⊘");
		case "expired":
			return theme.fg("accent", "⏰");
		default:
			return theme.fg("success", "✓");
	}
}

/** One line per trigger, e.g. "✓ task-2 · Background sleep task finished (Exit 0)". */
/** "Message from File Creator Subagent (self)" → "File Creator Subagent". */
export function senderRole(title: string | undefined): string | undefined {
	const match = /^Message from (.+?)(?: \([^)]*\))?$/.exec(title?.trim() ?? "");
	return match?.[1];
}

export function describeTrigger(trigger: AutonomousTrigger, theme: ThemeLike): string {
	if (trigger.agentId) {
		const role = senderRole(trigger.title);
		const who = role
			? `${theme.fg("toolTitle", role)} ${theme.fg("muted", trigger.agentId.slice(0, 8))}`
			: theme.fg("muted", `Subagent ${trigger.agentId.slice(0, 8)}`);
		const what = trigger.preview ?? (role ? "message" : (trigger.title ?? "message"));
		return `${theme.fg("accent", "✉")} ${who}: ${what}`;
	}
	const fallback =
		trigger.outcome === "running"
			? "still running"
			: trigger.kind === "timer"
				? "timer expired"
				: trigger.taskId
					? "task finished"
					: "message";
	const label = trigger.title ?? fallback;
	const exit =
		trigger.exitCode !== undefined && trigger.kind !== "timer" ? ` (Exit ${trigger.exitCode})` : "";
	const id = trigger.taskId ? `${theme.fg("muted", trigger.taskId)} · ` : "";
	return `${outcomeMark(trigger.outcome, theme)} ${id}${label}${exit}`;
}

/**
 * Card for a turn agy took on its own: header, what woke it up, its answer, and
 * its tool calls when expanded.
 */
export function renderAutonomousEntry(
	data: AutonomousEntryData,
	expanded: boolean,
	theme: ThemeLike,
	renderText: (text: string) => Component,
	expandHint = "",
): Component {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const clock = formatClock(data.endedAtMs ?? data.startedAtMs);
	const model = formatAgyModel(data.model);
	box.addChild(
		new Text(
			`${theme.fg("customMessageLabel", theme.bold("Antigravity · on its own"))}${clock ? theme.fg("dim", ` · ${clock}`) : ""}${model ? theme.fg("muted", ` · ${model}`) : ""}`,
			0,
			0,
		),
	);
	for (const trigger of data.triggers) {
		box.addChild(new Text(describeTrigger(trigger, theme), 0, 0));
	}
	if (data.text.trim()) {
		box.addChild(new Spacer(1));
		box.addChild(renderText(data.text));
	}
	if (data.actions.length > 0) {
		const shown = expanded ? data.actions : [];
		const lines = shown.map(
			(action) => `${theme.fg("muted", "→")} ${theme.fg("toolTitle", action.name)} ${theme.fg("dim", action.summary)}`,
		);
		if (!expanded) {
			const count = data.actions.length === 1 ? "1 tool call" : `${data.actions.length} tool calls`;
			lines.push(`${theme.fg("muted", count)}${expandHint ? ` ${expandHint}` : ""}`);
		}
		box.addChild(new Spacer(1));
		box.addChild(new Text(lines.join("\n"), 0, 0));
	}
	if (data.state === "interrupted") {
		box.addChild(new Text(theme.fg("warning", "Interrupted by your message; the rest is in the conversation."), 0, 0));
	}
	return box;
}

function taskLabel(task: BackgroundTask): string {
	if (task.kind === "timer") {
		return `Timer ${task.timerSeconds !== undefined ? formatDuration(task.timerSeconds) : "?"}`;
	}
	return task.summary ?? task.description;
}

const MAX_SUBAGENT_LINES = 6;

/** Model and reasoning level the subagent runs on, else what was asked for. */
export function subagentModelLabel(status: SubagentStatus): string {
	const model = formatAgyModel(status.model);
	if (model) return model;
	if (status.requestedModel) return `${status.requestedModel} (requested)`;
	if (status.typeName === "self") return "same model as the main agent";
	return status.typeName ?? "";
}

/**
 * Card text for an `invoke_subagent` call: who runs, on which model, with which
 * task. `started` is the subagent agy already recorded on disk, if any.
 */
export function subagentStartNote(
	args: Readonly<Record<string, string | number>>,
	started: SubagentStatus | undefined,
): string {
	const role = typeof args.agentRole === "string" ? args.agentRole : undefined;
	const count = typeof args.agentCount === "number" ? args.agentCount : 1;
	const startedModel = started ? subagentModelLabel(started) : "";
	const model =
		startedModel ||
		(typeof args.model === "string" ? `${args.model} (requested)` : undefined) ||
		(args.agentType === "self" ? "same model as the main agent" : undefined);
	const who = count > 1 ? `${count} subagents (${role ?? "no role"})` : `Subagent "${role ?? "no role"}"`;
	const details = [started?.conversationId.slice(0, 8), model].filter((part) => part !== undefined).join(" · ");
	const lines = [
		`🤖 ${who} started${details ? ` · ${details}` : ""}`,
		"The Antigravity panel above the editor shows what it is doing.",
	];
	const prompt = typeof args.prompt === "string" ? args.prompt : started?.prompt;
	if (prompt) {
		lines.push("", "Task:", ...prompt.split("\n"));
	}
	return lines.join("\n");
}

function renderSubagentLine(status: SubagentStatus, now: number, spinner: string, theme: ThemeLike): string {
	const mark =
		status.state === "working"
			? spinner
			: status.state === "killed"
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
	const end = status.state === "working" ? now : (status.lastAtMs ?? now);
	const elapsed = status.startedAtMs !== undefined ? formatElapsed(end - status.startedAtMs) : "";
	const role = status.role ?? "Subagent";
	const activity =
		status.state === "idle" ? `done${status.activity ? `: ${status.activity}` : ""}` : (status.activity ?? "");
	const model = subagentModelLabel(status);
	const parts = [
		theme.fg("muted", status.conversationId.slice(0, 8)),
		theme.fg("toolTitle", role),
		elapsed ? theme.fg("dim", elapsed) : "",
		model ? theme.fg("muted", model) : "",
		activity ? theme.fg("toolOutput", activity) : "",
	].filter((part) => part.length > 0);
	return ` ${mark} ${parts.join("  ")}`;
}

/** Widget lines for running background tasks and an autonomous turn in progress. */
export function renderActivityLines(
	snapshot: ActivityDisplay,
	now: number,
	frame: number,
	theme: ThemeLike,
): string[] {
	const running = snapshot.tasks.filter((task) => !task.finished);
	const subagents = snapshot.subagents ?? [];
	const working = subagents.filter((status) => status.state === "working");
	const live = isLiveFresh(snapshot.live, now) ? snapshot.live : undefined;
	if (snapshot.tasks.length === 0 && subagents.length === 0 && !snapshot.runningTurn && !live) return [];
	const spinner = theme.fg("accent", SPINNER[frame % SPINNER.length]);
	const parts: string[] = [];
	if (running.length > 0) parts.push(running.length === 1 ? "1 background task" : `${running.length} background tasks`);
	if (working.length > 0) parts.push(working.length === 1 ? "1 subagent" : `${working.length} subagents`);
	const header = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
	const lines = [`${theme.fg("customMessageLabel", theme.bold("Antigravity"))}${theme.fg("muted", header)}`];
	for (const task of snapshot.tasks) {
		const mark = task.finished ? outcomeMark(task.finished.outcome, theme) : spinner;
		const elapsed = task.startedAtMs !== undefined ? formatElapsed((task.finished?.atMs ?? now) - task.startedAtMs) : "";
		let detail = "";
		if (task.finished) {
			detail =
				task.finished.outcome === "canceled"
					? "canceled"
					: task.finished.exitCode !== undefined && task.kind === "command"
						? `Exit ${task.finished.exitCode}`
						: "done";
		} else if (task.kind === "timer" && task.startedAtMs !== undefined && task.timerSeconds !== undefined) {
			const left = task.startedAtMs + task.timerSeconds * 1000 - now;
			detail = left > 0 ? `${formatDuration(Math.ceil(left / 1000))} left` : "expiring";
		} else {
			detail = snapshot.logTails.get(task.taskId) ?? "no output yet";
		}
		lines.push(
			` ${mark} ${theme.fg("muted", task.taskId)}  ${theme.fg("toolTitle", taskLabel(task))}  ${theme.fg("dim", elapsed)}  ${theme.fg("toolOutput", detail)}`,
		);
	}
	for (const status of subagents.slice(-MAX_SUBAGENT_LINES)) {
		lines.push(renderSubagentLine(status, now, spinner, theme));
	}
	if (subagents.length > MAX_SUBAGENT_LINES) {
		lines.push(theme.fg("muted", `   … ${subagents.length - MAX_SUBAGENT_LINES} more subagents`));
	}
	const turn = snapshot.runningTurn;
	if (live) {
		const elapsed = formatElapsed(now - live.startedAtMs);
		const lastLine = live.text.split("\n").filter((line) => line.trim()).at(-1)?.trim();
		const detail = live.tool
			? `→ ${live.tool}`
			: lastLine
				? lastLine
				: live.thinking
					? "thinking …"
					: "";
		const actions = live.toolCalls === 1 ? "1 tool call" : `${live.toolCalls} tool calls`;
		lines.push(
			` ${spinner} ${theme.fg("toolTitle", "working on its own")}  ${theme.fg("dim", elapsed)}  ${theme.fg("muted", actions)}  ${theme.fg("toolOutput", detail)}`,
		);
	} else if (turn) {
		const elapsed = turn.startedAtMs !== undefined ? formatElapsed(now - turn.startedAtMs) : "";
		const actions = turn.actions.length === 1 ? "1 tool call" : `${turn.actions.length} tool calls`;
		lines.push(` ${spinner} ${theme.fg("toolTitle", "working on its own")}  ${theme.fg("dim", elapsed)}  ${theme.fg("muted", actions)}`);
	}
	// One widget line is one terminal row: Pi counts rows by lines, so a line break
	// inside a line (agy's multi-line command titles) leaves stray text on screen.
	return lines.map(singleLine);
}

class ActivityWidgetComponent implements Component {
	private snapshot: ActivityDisplay;
	private readonly theme: ThemeLike;
	private readonly requestRender: () => void;
	private readonly timer: NodeJS.Timeout;
	private frame = 0;

	constructor(snapshot: ActivityDisplay, theme: ThemeLike, requestRender: () => void) {
		this.snapshot = snapshot;
		this.theme = theme;
		this.requestRender = requestRender;
		this.timer = setInterval(() => {
			this.frame++;
			this.requestRender();
		}, SPINNER_INTERVAL_MS);
		this.timer.unref?.();
	}

	update(snapshot: ActivityDisplay): void {
		this.snapshot = snapshot;
		this.requestRender();
	}

	render(width: number): string[] {
		return renderActivityLines(this.snapshot, Date.now(), this.frame, this.theme).map((line) =>
			truncateToWidth(line, width),
		);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}
}

/** Live widget above the editor plus a footer badge while agy works in the background. */
export class BackgroundActivityView {
	private component: ActivityWidgetComponent | undefined;
	private shownIn: ExtensionContext | undefined;
	private latest: ActivityDisplay | undefined;

	show(ctx: ExtensionContext | undefined, snapshot: ActivityDisplay): void {
		this.latest = snapshot;
		if (!ctx?.hasUI) return;
		const subagents = snapshot.subagents ?? [];
		const running =
			snapshot.tasks.filter((task) => !task.finished).length +
			subagents.filter((status) => status.state === "working").length;
		const working = Boolean(snapshot.runningTurn) || isLiveFresh(snapshot.live, Date.now());
		const visible = snapshot.tasks.length > 0 || subagents.length > 0 || working;
		if (!visible) {
			this.clear();
			return;
		}
		const badge = working ? "agy ⚙ on its own" : `agy ⏳ ${running}`;
		ctx.ui.setStatus(STATUS_KEY, running > 0 || working ? badge : undefined);
		if (this.component && this.shownIn === ctx) {
			this.component.update(snapshot);
			return;
		}
		this.clear();
		this.shownIn = ctx;
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			this.component?.dispose();
			this.component = new ActivityWidgetComponent(this.latest ?? snapshot, theme, () => tui.requestRender());
			return this.component;
		});
	}

	clear(): void {
		if (this.shownIn?.hasUI) {
			this.shownIn.ui.setWidget(WIDGET_KEY, undefined);
			this.shownIn.ui.setStatus(STATUS_KEY, undefined);
		}
		this.component?.dispose();
		this.component = undefined;
		this.shownIn = undefined;
	}
}
