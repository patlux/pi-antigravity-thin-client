import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AcpPromptStopReason } from "../acp/protocol.ts";
import { type BridgeConfig, resolveAgyConversationsDir } from "../config.ts";

/**
 * Error prefix for an exhausted Antigravity quota. "quota exceeded" matches Pi's
 * non-retryable provider-limit pattern so Pi never auto-retries the prompt.
 */
export const ANTIGRAVITY_QUOTA_EXCEEDED_PREFIX = "Antigravity quota exceeded (429)";

/** `CORTEX_STEP_TYPE_ERROR_MESSAGE` in Antigravity's native SQLite trajectory log. */
const ERROR_STEP_TYPE = 17;
/** The harness error text leads the payload; a Go stack trace follows it. */
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
const NATIVE_SESSION_ID = /^[\w-]+$/;

// The Go harness's rendering of a Google API error:
// "Error 502, Message: ..., Status: 502 Bad Gateway" or gRPC status names.
const API_ERROR =
	/Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\n]*)/s;
// Antigravity 1.5 with a Google account writes "STATUS (code NNN): message".
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
// Newer Antigravity builds attach the HTTP JSON body to the error step.
const ERROR_JSON_START = /\{\s*"error"\s*:/g;

const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
const RESOURCE_EXHAUSTED = /\bRESOURCE_EXHAUSTED\b/;
const HTTP_429_MARKER = /(?:"code"\s*:\s*429\b|\bcode\s+429\b|\bError\s+429\b)/i;
const SUBSCRIPTION_REQUIRED = /\bSUBSCRIPTION_REQUIRED\b/;
// Claude rejects a saved thinking block without a valid signature. It sits in native history,
// so later prompts on the same session fail until the user starts a fresh session.
const INVALID_THINKING_SIGNATURE =
	/\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)|\bINVALID_THINKING_SIGNATURE\b/;

const RESET_TIMESTAMP = /\bquotaResetTimeStamp:"?([^\s\]",]+)"?/;
const RESET_DELAY = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?!\w|\.\d)/;
const RETRY_DELAY = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?!\w|\.\d)/;
const RESETS_IN = /\bResets in ((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?!\w|\.\d)/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const ISO_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

const GO_DURATION_UNIT_MS: Readonly<Record<string, number>> = {
	ns: 1e-6,
	us: 1e-3,
	µs: 1e-3,
	μs: 1e-3,
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
};

export type AntigravityTurnOutcomeKind =
	| "quota"
	| "invalid_thinking_signature"
	| "validation_required"
	| "subscription_required"
	| "api_error";

export interface AntigravityTurnOutcome {
	readonly kind: AntigravityTurnOutcomeKind;
	readonly httpStatus: number;
	readonly message: string;
	readonly resetAt?: string;
	readonly validationUrl?: string;
}

export interface InspectAntigravityTurnOutcomeParams {
	readonly config: BridgeConfig;
	readonly sessionId: string;
	readonly startStepIdx: number;
	readonly stopReason: AcpPromptStopReason;
	readonly nowMs?: number;
}

interface ParsedApiError {
	readonly httpStatus: number;
	readonly message: string;
	readonly status: string;
}

interface ParsedQuotaReset {
	readonly suffix: string;
	readonly resetAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openConversationDbReadOnly(
	config: BridgeConfig,
	sessionId: string,
): DatabaseSync | undefined {
	if (!NATIVE_SESSION_ID.test(sessionId)) {
		return undefined;
	}
	const dbPath = path.join(resolveAgyConversationsDir(config), `${sessionId}.db`);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(dbPath);
	} catch {
		return undefined;
	}
	if (!stat.isFile()) {
		return undefined;
	}

	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
		db.exec("PRAGMA busy_timeout = 100");
		const hasSteps =
			db
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
				.get() !== undefined;
		if (!hasSteps) {
			db.close();
			return undefined;
		}
		return db;
	} catch {
		try {
			db?.close();
		} catch {
			// Ignore close errors on failed read-only open.
		}
		return undefined;
	}
}

function parseGoDurationMs(duration: string): number | undefined {
	let totalMs = 0;
	let matched = false;
	for (const match of duration.matchAll(GO_DURATION_PART)) {
		const amount = Number(match[1]);
		const unit = match[2];
		const multiplier = unit ? GO_DURATION_UNIT_MS[unit] : undefined;
		if (!Number.isFinite(amount) || multiplier === undefined) {
			continue;
		}
		totalMs += amount * multiplier;
		matched = true;
	}
	return matched && totalMs > 0 && Number.isFinite(totalMs) ? totalMs : undefined;
}

function parseQuotaReset(text: string, nowMs: number | undefined): ParsedQuotaReset | undefined {
	const rawTimestamp = RESET_TIMESTAMP.exec(text)?.[1]?.replace(/[.;)]+$/, "");
	if (rawTimestamp !== undefined && ISO_TIMESTAMP_PREFIX.test(rawTimestamp)) {
		const parsedMs = Date.parse(rawTimestamp);
		if (Number.isFinite(parsedMs)) {
			return {
				suffix: ` Resets at ${rawTimestamp}.`,
				resetAt: new Date(parsedMs).toISOString(),
			};
		}
	}

	const rawDelay =
		RESET_DELAY.exec(text)?.[1] ??
		RETRY_DELAY.exec(text)?.[1] ??
		RESETS_IN.exec(text)?.[1];
	if (rawDelay === undefined) {
		return undefined;
	}
	const delayMs = parseGoDurationMs(rawDelay);
	if (delayMs === undefined) {
		return undefined;
	}
	if (nowMs !== undefined && Number.isFinite(nowMs)) {
		const resetAt = new Date(nowMs + delayMs).toISOString();
		return {
			suffix: ` Resets in ${rawDelay} (${resetAt}).`,
			resetAt,
		};
	}
	return {
		suffix: ` Resets in ${rawDelay}.`,
	};
}

function parseApiError(text: string): ParsedApiError | undefined {
	const apiMatch = API_ERROR.exec(text);
	if (apiMatch) {
		return {
			httpStatus: Number(apiMatch[1]),
			message: apiMatch[2].trim(),
			status: apiMatch[3].trim(),
		};
	}
	const statusMatch = STATUS_ERROR.exec(text);
	if (statusMatch) {
		return {
			httpStatus: Number(statusMatch[2]),
			message: statusMatch[3].trim(),
			status: statusMatch[1].trim(),
		};
	}
	return undefined;
}

function balancedJsonObject(text: string, start: number): string | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "{") {
			depth += 1;
		} else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}
	return undefined;
}

function parseSafeHttpUrl(raw: unknown): string | undefined {
	if (typeof raw !== "string") {
		return undefined;
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			return parsed.href;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function extractValidationRequired(text: string): { readonly validationUrl?: string } | undefined {
	for (const match of text.matchAll(ERROR_JSON_START)) {
		if (match.index === undefined) continue;
		const json = balancedJsonObject(text, match.index);
		if (json === undefined) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(json);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || !isRecord(parsed.error)) {
			continue;
		}
		const errorObj = parsed.error;
		if (
			errorObj.code !== 403 ||
			errorObj.status !== "PERMISSION_DENIED" ||
			!Array.isArray(errorObj.details)
		) {
			continue;
		}
		for (const detail of errorObj.details) {
			if (!isRecord(detail)) continue;
			const detailType = detail["@type"];
			if (
				detailType !== undefined &&
				detailType !== "type.googleapis.com/google.rpc.ErrorInfo"
			) {
				continue;
			}
			if (detail.reason !== "VALIDATION_REQUIRED") {
				continue;
			}
			const validationUrl = isRecord(detail.metadata)
				? parseSafeHttpUrl(detail.metadata.validation_url)
				: undefined;
			return { validationUrl };
		}
	}
	return undefined;
}

/**
 * Pure classifier for an Antigravity turn outcome from the ACP `stopReason` and
 * optional `step_type = 17` (`CORTEX_STEP_TYPE_ERROR_MESSAGE`) payload text.
 */
export function classifyAntigravityTurnOutcome(
	stopReason: AcpPromptStopReason,
	errorPayloadText: string | undefined,
	nowMs?: number,
): AntigravityTurnOutcome | undefined {
	if (errorPayloadText === undefined && stopReason !== "refusal") {
		return undefined;
	}

	const text = errorPayloadText ?? "";
	const apiError = parseApiError(text);

	if (
		stopReason === "refusal" ||
		QUOTA_EXHAUSTED.test(text) ||
		apiError?.httpStatus === 429 ||
		apiError?.status === "RESOURCE_EXHAUSTED" ||
		RESOURCE_EXHAUSTED.test(text) ||
		HTTP_429_MARKER.test(text)
	) {
		const reset = parseQuotaReset(text, nowMs);
		const message = reset
			? `${ANTIGRAVITY_QUOTA_EXCEEDED_PREFIX}.${reset.suffix}`
			: `${ANTIGRAVITY_QUOTA_EXCEEDED_PREFIX}.`;
		return {
			kind: "quota",
			httpStatus: 429,
			message,
			...(reset?.resetAt ? { resetAt: reset.resetAt } : {}),
		};
	}

	if (INVALID_THINKING_SIGNATURE.test(text)) {
		return {
			kind: "invalid_thinking_signature",
			httpStatus: 400,
			message:
				"Antigravity rejected a saved thinking block signature in this session. Start a fresh session with /new to continue.",
		};
	}

	const validation = extractValidationRequired(text);
	if (validation !== undefined) {
		const message = validation.validationUrl
			? `Antigravity account verification required. Verify your Google account at ${validation.validationUrl}, then send your message again.`
			: "Antigravity account verification required. Verify your Google account, then send your message again.";
		return {
			kind: "validation_required",
			httpStatus: 403,
			message,
			...(validation.validationUrl ? { validationUrl: validation.validationUrl } : {}),
		};
	}

	if (SUBSCRIPTION_REQUIRED.test(text)) {
		return {
			kind: "subscription_required",
			httpStatus: 403,
			message:
				"Antigravity requires an eligible subscription for this account. Check your Google account plan or sign in again with /agy login.",
		};
	}

	if (apiError !== undefined) {
		const httpStatus =
			Number.isFinite(apiError.httpStatus) && apiError.httpStatus >= 100
				? apiError.httpStatus
				: 500;
		return {
			kind: "api_error",
			httpStatus,
			message: apiError.message || "Antigravity stopped this turn because of an error.",
		};
	}

	return {
		kind: "api_error",
		httpStatus: 500,
		message: "Antigravity stopped this turn because of an error.",
	};
}

/**
 * Snapshots the current `MAX(idx)` from `steps` (read-only) before starting a prompt.
 * Returns `-1` when the session ID is invalid or the DB/table does not exist yet.
 */
export function snapshotTurnStepWatermark(config: BridgeConfig, sessionId: string): number {
	const db = openConversationDbReadOnly(config, sessionId);
	if (!db) {
		return -1;
	}
	try {
		const row = db.prepare("SELECT MAX(idx) AS maxIdx FROM steps").get();
		const maxIdx = row?.maxIdx;
		return typeof maxIdx === "number" ? maxIdx : -1;
	} catch {
		return -1;
	} finally {
		try {
			db.close();
		} catch {
			// Ignore close errors after read-only query.
		}
	}
}

/**
 * Inspects the latest trajectory step written after `startStepIdx` (read-only)
 * to detect upstream Antigravity API errors reported as `step_type = 17` or `refusal`.
 */
export function inspectAntigravityTurnOutcome(
	params: InspectAntigravityTurnOutcomeParams,
): AntigravityTurnOutcome | undefined {
	let errorPayloadText: string | undefined;
	const db = openConversationDbReadOnly(params.config, params.sessionId);
	if (db) {
		try {
			const row = db
				.prepare(
					"SELECT step_type AS type, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1",
				)
				.get(MAX_ERROR_PAYLOAD_BYTES, params.startStepIdx);
			if (row && typeof row.type === "number" && row.type === ERROR_STEP_TYPE) {
				if (row.payload instanceof Uint8Array) {
					errorPayloadText = new TextDecoder().decode(row.payload);
				} else if (typeof row.payload === "string") {
					errorPayloadText = row.payload;
				} else {
					errorPayloadText = "";
				}
			}
		} catch {
			errorPayloadText = undefined;
		} finally {
			try {
				db.close();
			} catch {
				// Ignore close errors after read-only query.
			}
		}
	}

	return classifyAntigravityTurnOutcome(
		params.stopReason,
		errorPayloadText,
		params.nowMs ?? Date.now(),
	);
}
