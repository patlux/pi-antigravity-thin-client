import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AcpTierInfo } from "../acp/protocol.ts";
import type { BridgeConfig } from "../config.ts";

export const STATUS_BAR_KEY = "antigravity";

export interface RuntimeTelemetrySnapshot {
	agySessionId?: string;
	tier?: AcpTierInfo;
	usedTokens?: number;
	windowSize?: number;
	backendCompactedRecently?: boolean;
}

/**
 * Thin-client fork: no footer badge. Upstream showed the tool mode here, for example
 * `AGY:native(default)`. The fork pins agy-tools, so the badge would only repeat a value
 * nobody can change. The function keeps upstream's call sites and clears the key, so a
 * badge from an earlier version does not linger.
 */
export function updateAntigravityStatusBar(
	ctx: ExtensionContext | undefined,
	_config: BridgeConfig,
	_telemetry: RuntimeTelemetrySnapshot,
): void {
	if (!ctx || !ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_BAR_KEY, undefined);
}
