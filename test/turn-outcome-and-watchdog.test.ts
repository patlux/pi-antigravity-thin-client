import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
	isRetryableAssistantError,
	normalizeContext,
	type AssistantMessage,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AcpProcessManager } from "../src/acp/process-manager.ts";
import type { AcpSessionUpdatePayload } from "../src/acp/protocol.ts";
import { DEFAULT_BRIDGE_CONFIG, type BridgeConfig } from "../src/config.ts";
import {
	ANTIGRAVITY_QUOTA_EXCEEDED_PREFIX,
	classifyAntigravityTurnOutcome,
	inspectAntigravityTurnOutcome,
	snapshotTurnStepWatermark,
} from "../src/session/agy-turn-outcome.ts";
import { parseStepMetadataGenerationUsage } from "../src/session/checkpoint-sync.ts";
import { TurnCoordinator } from "../src/session/turn-coordinator.ts";
import {
	AgyTurnMirrorBroker,
	createAgyMirrorToolDefinitions,
} from "../src/tools/agy-mirror-tools.ts";
import { interactiveContext, typedByHuman } from "./human-input.ts";

const TEST_MODEL: Model<"antigravity-acp"> = {
	id: "gemini-4-neon",
	name: "Gemini 4 Neon",
	api: "antigravity-acp",
	provider: "antigravity",
	baseUrl: "local://antigravity-acp",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
};

function makeFailedAssistant(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: TEST_MODEL.api,
		provider: TEST_MODEL.provider,
		model: TEST_MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function isStubExtensionApi(value: object): value is ExtensionAPI {
	return (
		"getAllTools" in value &&
		"appendEntry" in value &&
		"getSessionName" in value &&
		"setSessionName" in value
	);
}

function createStubPiApi(): ExtensionAPI {
	const stub = {
		getAllTools: () => [],
		appendEntry: () => {},
		getSessionName: () => undefined,
		setSessionName: () => {},
	};
	if (!isStubExtensionApi(stub)) {
		throw new Error("stub ExtensionAPI missing required methods");
	}
	return stub;
}

function createConversationDb(
	config: BridgeConfig,
	sessionId: string,
	steps: ReadonlyArray<{ idx: number; stepType: number; payload?: string | Buffer | null }>,
): string {
	const convDir = path.join(config.geminiDir, config.appDataDirName, "conversations");
	fs.mkdirSync(convDir, { recursive: true });
	const dbPath = path.join(convDir, `${sessionId}.db`);
	const db = new DatabaseSync(dbPath);
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS steps (
				idx integer PRIMARY KEY,
				step_type integer NOT NULL DEFAULT 0,
				status integer NOT NULL DEFAULT 0,
				step_payload blob
			);
		`);
		const insert = db.prepare(
			"INSERT OR REPLACE INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)",
		);
		for (const step of steps) {
			const payloadBuf =
				typeof step.payload === "string"
					? Buffer.from(step.payload, "utf8")
					: (step.payload ?? null);
			insert.run(step.idx, step.stepType, payloadBuf);
		}
	} finally {
		db.close();
	}
	return dbPath;
}

function encodeVarint(value: number): number[] {
	const bytes: number[] = [];
	let remaining = value;
	while (remaining >= 0x80) {
		bytes.push((remaining & 0x7f) | 0x80);
		remaining = Math.floor(remaining / 128);
	}
	bytes.push(remaining);
	return bytes;
}

function encodeMetadataUsage(fields: ReadonlyArray<readonly [number, number]>): Buffer {
	const innerBytes: number[] = [];
	for (const [fieldNumber, value] of fields) {
		innerBytes.push(...encodeVarint((fieldNumber << 3) | 0), ...encodeVarint(value));
	}
	const inner = Buffer.from(innerBytes);
	return Buffer.from([(9 << 3) | 2, ...encodeVarint(inner.length), ...inner]);
}

interface MockScenarioOptions {
	availableModes?: ReadonlyArray<{ id: string; name: string }>;
	configOptions?: ReadonlyArray<{
		id: string;
		name: string;
		category?: string;
		type: string;
		currentValue: string;
		options?: ReadonlyArray<{ value: string; name: string }>;
	}>;
	failConfigIds?: ReadonlyArray<string>;
}

function writeScenarioMockAgy(dir: string, options: MockScenarioOptions = {}): {
	binPath: string;
	logPath: string;
} {
	const binPath = path.join(dir, "mock-agy-scenario.mjs");
	const logPath = path.join(dir, "scenario-calls.jsonl");
	const configJson = JSON.stringify({
		availableModes: options.availableModes,
		configOptions: options.configOptions ?? [
			{
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: "gemini-4-neon",
				options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }],
			},
			{
				id: "thought_level",
				name: "Thinking",
				category: "thought_level",
				type: "select",
				currentValue: "high",
				options: [{ value: "high", name: "High" }],
			},
			{
				id: "mode",
				name: "Mode",
				category: "mode",
				type: "select",
				currentValue: "default",
				options: [
					{ value: "default", name: "Default" },
					{ value: "plan", name: "Plan" },
				],
			},
		],
		failConfigIds: options.failConfigIds ?? [],
	});

	const source = `#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { DatabaseSync } from "node:sqlite";

const mockRoot = ${JSON.stringify(dir)};
const logPath = ${JSON.stringify(logPath)};
const cfg = ${configJson};

const sessions = new Map();
let nextServerReqId = 5000;
const serverPending = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

function recordCall(entry) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
}

function requestClient(method, params) {
  const id = nextServerReqId++;
  return new Promise((resolve, reject) => {
    serverPending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function writeErrorStep(sessionId, idx, payloadText) {
  const convDir = path.join(mockRoot, ".gemini", "antigravity-cli", "conversations");
  fs.mkdirSync(convDir, { recursive: true });
  const db = new DatabaseSync(path.join(convDir, sessionId + ".db"));
  db.exec(\`
    CREATE TABLE IF NOT EXISTS steps (
      idx integer PRIMARY KEY,
      step_type integer NOT NULL DEFAULT 0,
      status integer NOT NULL DEFAULT 0,
      step_payload blob
    );
  \`);
  db.prepare("INSERT OR REPLACE INTO steps (idx, step_type, status, step_payload) VALUES (?, 17, 3, ?)").run(
    idx,
    Buffer.from(payloadText, "utf8"),
  );
  db.close();
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.id !== undefined && !msg.method && serverPending.has(msg.id)) {
    const pending = serverPending.get(msg.id);
    serverPending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message));
    else pending.resolve(msg.result);
    return;
  }

  if (msg.method) {
    recordCall({ method: msg.method, params: msg.params });
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: { resume: {}, close: {}, list: {}, load: {} },
        },
        agentInfo: { name: "Mock AGY Scenario", version: "1.5.13" },
      },
    });
    return;
  }

  if (msg.method === "session/new") {
    const sessionId = "scenario-sess-" + (sessions.size + 1);
    sessions.set(sessionId, { inFlightPromptId: undefined, timers: [] });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId,
        models: { availableModels: [{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" }] },
        ...(cfg.availableModes ? { modes: { currentModeId: "default", availableModes: cfg.availableModes } } : {}),
        configOptions: cfg.configOptions,
      },
    });
    return;
  }

  if (msg.method === "session/set_config_option") {
    const configId = msg.params?.configId;
    if (cfg.failConfigIds.includes(configId)) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: "Rejected config option: " + configId },
      });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "session/cancel") {
    const sid = msg.params?.sessionId;
    const sess = sid ? sessions.get(sid) : undefined;
    if (sess) {
      for (const t of sess.timers) clearTimeout(t);
      sess.timers = [];
      if (sess.inFlightPromptId !== undefined) {
        const pid = sess.inFlightPromptId;
        sess.inFlightPromptId = undefined;
        send({ jsonrpc: "2.0", id: pid, result: { stopReason: "cancelled" } });
      }
    }
    return;
  }

  if (msg.method === "session/prompt") {
    const { sessionId, prompt } = msg.params;
    const sess = sessions.get(sessionId);
    const text = prompt?.[prompt.length - 1]?.text ?? "";

    if (text === "INTERACTION_REJECT_ONCE") {
      await requestClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "interaction_q1", title: "Choose an option" },
        options: [
          { optionId: "opt_yes", name: "Yes", kind: "allow_once" },
          { optionId: "opt_no", name: "No", kind: "reject_once" },
        ],
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (text === "TOOL_REJECT_ONCE") {
      await requestClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "tool_exec_1", title: "Run dangerous command" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (text === "EMIT_CONFIG_ADD_AUTO") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: [
              {
                id: "custom_model_opt",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: "gemini-4-neon",
                options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }],
              },
              {
                id: "custom_mode_opt",
                name: "Mode",
                category: "mode",
                type: "select",
                currentValue: "default",
                options: [
                  { value: "default", name: "Default" },
                  { value: "plan", name: "Plan" },
                  { value: "auto", name: "Auto" },
                ],
              },
            ],
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Auto advertised." } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (text === "EMIT_CURRENT_MODE_PLAN") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Switched to plan." } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (text === "EMIT_OUT_OF_TURN_USAGE") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "usage_update", used: 42_000, size: 1_048_576 } },
        });
      }, 25);
      return;
    }

    if (text === "SILENT_STALL") {
      if (sess) sess.inFlightPromptId = msg.id;
      return;
    }

    if (text === "SILENT_STALL_WITH_SQLITE_ERROR") {
      if (sess) sess.inFlightPromptId = msg.id;
      writeErrorStep(sessionId, 5, "Error 403, Message: SUBSCRIPTION_REQUIRED, Status: PERMISSION_DENIED");
      return;
    }

    if (text === "DIALOG_PAUSE_PERMISSION") {
      if (sess) sess.inFlightPromptId = msg.id;
      await requestClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "perm_slow_1", title: "Approve slow prompt" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      if (sess?.inFlightPromptId !== msg.id) return;
      sess.inFlightPromptId = undefined;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Permission answered." } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (text === "DIALOG_PAUSE_ELICITATION") {
      if (sess) sess.inFlightPromptId = msg.id;
      await requestClient("elicitation/create", {
        sessionId,
        mode: "form",
        message: "Enter your preference",
        requestedSchema: { type: "object", properties: {} },
      });
      if (sess?.inFlightPromptId !== msg.id) return;
      sess.inFlightPromptId = undefined;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Elicitation answered." } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (text === "ACTIVITY_KEEPALIVE") {
      if (sess) sess.inFlightPromptId = msg.id;
      const updates = [
        { sessionUpdate: "usage_update", used: 1000, size: 1_048_576 },
        { sessionUpdate: "plan", entries: [{ content: "Step 1", status: "in_progress" }] },
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking..." } },
        { sessionUpdate: "usage_update", used: 1200, size: 1_048_576 },
      ];
      updates.forEach((upd, idx) => {
        const t = setTimeout(() => {
          if (sess?.inFlightPromptId !== msg.id) return;
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: upd } });
        }, (idx + 1) * 45);
        sess?.timers.push(t);
      });
      const finishTimer = setTimeout(() => {
        if (sess?.inFlightPromptId !== msg.id) return;
        sess.inFlightPromptId = undefined;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Kept alive." } } },
        });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }, 225);
      sess?.timers.push(finishTimer);
      return;
    }

    if (text === "SQLITE_STEP17_QUOTA") {
      writeErrorStep(
        sessionId,
        10,
        "Error 429, Message: Quota exhausted [reason:QUOTA_EXHAUSTED, quotaResetDelay:4m42s], Status: RESOURCE_EXHAUSTED",
      );
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (text === "SQLITE_STEP17_THINKING_SIG") {
      writeErrorStep(
        sessionId,
        10,
        "Error 400, Message: messages.2.content.0.thinking.signature: Field required, Status: INVALID_ARGUMENT",
      );
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (text === "STOP_REASON_REFUSAL") {
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "refusal" } });
      return;
    }

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK: " + text } } },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`;

	fs.writeFileSync(binPath, source, { mode: 0o755 });
	return { binPath, logPath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecordedCalls(
	logPath: string,
): Array<{ method: string; params?: Record<string, unknown> }> {
	if (!fs.existsSync(logPath)) return [];
	const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
	for (const line of fs.readFileSync(logPath, "utf8").trim().split("\n")) {
		if (!line) continue;
		const parsed: unknown = JSON.parse(line);
		if (isRecord(parsed) && typeof parsed.method === "string") {
			calls.push({
				method: parsed.method,
				params: isRecord(parsed.params) ? parsed.params : undefined,
			});
		}
	}
	return calls;
}

describe("SQLite turn outcome classifier and watermark inspection", () => {
	const fixedNowMs = Date.parse("2026-11-26T20:00:00.000Z");

	it("classifies quota exhaustion with quotaResetTimeStamp, quotaResetDelay, retryDelay, Resets in, and refusal", () => {
		const tsOutcome = classifyAntigravityTurnOutcome(
			"end_turn",
			"Error 429, Message: Quota exhausted [reason:QUOTA_EXHAUSTED, quotaResetTimeStamp:2026-11-26T22:30:00Z], Status: RESOURCE_EXHAUSTED",
			fixedNowMs,
		);
		assert.ok(tsOutcome);
		assert.equal(tsOutcome.kind, "quota");
		assert.equal(tsOutcome.httpStatus, 429);
		assert.ok(tsOutcome.message.startsWith(ANTIGRAVITY_QUOTA_EXCEEDED_PREFIX));
		assert.match(tsOutcome.message, /2026-11-26T22:30:00Z/);
		assert.equal(isRetryableAssistantError(makeFailedAssistant(tsOutcome.message)), false);

		const delayOutcome = classifyAntigravityTurnOutcome(
			"end_turn",
			"Error 429, Message: Exhausted [quotaResetDelay:1h2m3s], Status: RESOURCE_EXHAUSTED",
			fixedNowMs,
		);
		assert.ok(delayOutcome);
		assert.equal(delayOutcome.kind, "quota");
		assert.equal(delayOutcome.httpStatus, 429);
		assert.ok(delayOutcome.message.startsWith(ANTIGRAVITY_QUOTA_EXCEEDED_PREFIX));
		assert.match(delayOutcome.message, /1h2m3s/);
		assert.equal(delayOutcome.resetAt, "2026-11-26T21:02:03.000Z");
		assert.equal(isRetryableAssistantError(makeFailedAssistant(delayOutcome.message)), false);

		const retryDelayOutcome = classifyAntigravityTurnOutcome(
			"end_turn",
			"Error 429, Message: Rate limited [retryDelay:30s], Status: RESOURCE_EXHAUSTED",
			fixedNowMs,
		);
		assert.ok(retryDelayOutcome);
		assert.equal(retryDelayOutcome.kind, "quota");
		assert.equal(retryDelayOutcome.resetAt, "2026-11-26T20:00:30.000Z");
		assert.ok(retryDelayOutcome.message.startsWith(ANTIGRAVITY_QUOTA_EXCEEDED_PREFIX));
		assert.equal(isRetryableAssistantError(makeFailedAssistant(retryDelayOutcome.message)), false);

		const resetsInOutcome = classifyAntigravityTurnOutcome(
			"end_turn",
			"RESOURCE_EXHAUSTED (code 429): Your quota is exhausted. Resets in 4m42s.",
			fixedNowMs,
		);
		assert.ok(resetsInOutcome);
		assert.equal(resetsInOutcome.kind, "quota");
		assert.equal(resetsInOutcome.resetAt, "2026-11-26T20:04:42.000Z");
		assert.match(resetsInOutcome.message, /4m42s/);
		assert.equal(isRetryableAssistantError(makeFailedAssistant(resetsInOutcome.message)), false);

		const bareRefusal = classifyAntigravityTurnOutcome("refusal", undefined, fixedNowMs);
		assert.ok(bareRefusal);
		assert.equal(bareRefusal.kind, "quota");
		assert.equal(bareRefusal.httpStatus, 429);
		assert.ok(bareRefusal.message.startsWith(ANTIGRAVITY_QUOTA_EXCEEDED_PREFIX));
		assert.equal(isRetryableAssistantError(makeFailedAssistant(bareRefusal.message)), false);
	});

	it("classifies INVALID_THINKING_SIGNATURE, 403 VALIDATION_REQUIRED, SUBSCRIPTION_REQUIRED, and generic API errors", () => {
		const sigClaude = classifyAntigravityTurnOutcome(
			"end_turn",
			"Error 400, Message: messages.4.content.0: Invalid `signature` in `thinking` block, Status: INVALID_ARGUMENT",
			fixedNowMs,
		);
		assert.ok(sigClaude);
		assert.equal(sigClaude.kind, "invalid_thinking_signature");
		assert.equal(sigClaude.httpStatus, 400);
		assert.match(sigClaude.message, /\/new/);
		assert.equal(isRetryableAssistantError(makeFailedAssistant(sigClaude.message)), false);

		const sigCode = classifyAntigravityTurnOutcome("end_turn", "INVALID_THINKING_SIGNATURE", fixedNowMs);
		assert.ok(sigCode);
		assert.equal(sigCode.kind, "invalid_thinking_signature");
		assert.equal(sigCode.httpStatus, 400);

		const validationPayload = JSON.stringify({
			error: {
				code: 403,
				status: "PERMISSION_DENIED",
				details: [
					{
						"@type": "type.googleapis.com/google.rpc.ErrorInfo",
						domain: "cloudcode-pa.googleapis.com",
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: "https://accounts.google.com/verify?token=abc" },
					},
				],
			},
		});
		const valOutcome = classifyAntigravityTurnOutcome(
			"end_turn",
			`Error 403, Message: ${validationPayload}, Status: PERMISSION_DENIED`,
			fixedNowMs,
		);
		assert.ok(valOutcome);
		assert.equal(valOutcome.kind, "validation_required");
		assert.equal(valOutcome.httpStatus, 403);
		assert.equal(valOutcome.validationUrl, "https://accounts.google.com/verify?token=abc");
		assert.match(valOutcome.message, /https:\/\/accounts\.google\.com\/verify\?token=abc/);
		assert.equal(isRetryableAssistantError(makeFailedAssistant(valOutcome.message)), false);

		const unsafeValidationPayload = JSON.stringify({
			error: {
				code: 403,
				status: "PERMISSION_DENIED",
				details: [
					{
						"@type": "type.googleapis.com/google.rpc.ErrorInfo",
						domain: "cloudcode-pa.googleapis.com",
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: "javascript:alert(1)" },
					},
				],
			},
		});
		const unsafeValOutcome = classifyAntigravityTurnOutcome(
			"end_turn",
			unsafeValidationPayload,
			fixedNowMs,
		);
		assert.ok(unsafeValOutcome);
		assert.equal(unsafeValOutcome.kind, "validation_required");
		assert.equal(unsafeValOutcome.validationUrl, undefined);
		assert.doesNotMatch(unsafeValOutcome.message, /javascript:/);

		const subOutcome = classifyAntigravityTurnOutcome(
			"end_turn",
			"Error 403, Message: SUBSCRIPTION_REQUIRED: active plan needed, Status: PERMISSION_DENIED",
			fixedNowMs,
		);
		assert.ok(subOutcome);
		assert.equal(subOutcome.kind, "subscription_required");
		assert.equal(subOutcome.httpStatus, 403);
		assert.match(subOutcome.message, /\/agy login/);
		assert.equal(isRetryableAssistantError(makeFailedAssistant(subOutcome.message)), false);

		const genericApi = classifyAntigravityTurnOutcome(
			"end_turn",
			"Error 502, Message: Upstream bad gateway, Status: 502 Bad Gateway",
			fixedNowMs,
		);
		assert.ok(genericApi);
		assert.equal(genericApi.kind, "api_error");
		assert.equal(genericApi.httpStatus, 502);
		assert.equal(genericApi.message, "Upstream bad gateway");

		const statusFmt = classifyAntigravityTurnOutcome(
			"end_turn",
			"UNAVAILABLE (code 503): Backend temporarily down",
			fixedNowMs,
		);
		assert.ok(statusFmt);
		assert.equal(statusFmt.kind, "api_error");
		assert.equal(statusFmt.httpStatus, 503);
		assert.equal(statusFmt.message, "Backend temporarily down");

		const unrecognized = classifyAntigravityTurnOutcome("end_turn", "opaque binary blob", fixedNowMs);
		assert.deepEqual(unrecognized, {
			kind: "api_error",
			httpStatus: 500,
			message: "Antigravity stopped this turn because of an error.",
		});

		assert.equal(classifyAntigravityTurnOutcome("end_turn", undefined, fixedNowMs), undefined);
	});

	it("filters prior-turn step_type=17 errors by watermark and rejects invalid session IDs", () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-outcome-wm-"));
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};
		try {
			assert.equal(snapshotTurnStepWatermark(cfg, "missing-session"), -1);
			assert.equal(snapshotTurnStepWatermark(cfg, "../escape"), -1);

			createConversationDb(cfg, "sess-wm-1", [
				{ idx: 0, stepType: 14, payload: "user" },
				{ idx: 1, stepType: 17, payload: "Error 429, Message: old quota error, Status: RESOURCE_EXHAUSTED" },
			]);
			const watermark = snapshotTurnStepWatermark(cfg, "sess-wm-1");
			assert.equal(watermark, 1);

			// Old error at idx=1 must NOT trigger when startStepIdx === 1.
			assert.equal(
				inspectAntigravityTurnOutcome({
					config: cfg,
					sessionId: "sess-wm-1",
					startStepIdx: watermark,
					stopReason: "end_turn",
					nowMs: fixedNowMs,
				}),
				undefined,
			);

			// Non-error step at idx=2 after watermark must NOT trigger.
			createConversationDb(cfg, "sess-wm-1", [
				{ idx: 0, stepType: 14, payload: "user" },
				{ idx: 1, stepType: 17, payload: "Error 429, Message: old quota error, Status: RESOURCE_EXHAUSTED" },
				{ idx: 2, stepType: 15, payload: "planner ok" },
			]);
			assert.equal(
				inspectAntigravityTurnOutcome({
					config: cfg,
					sessionId: "sess-wm-1",
					startStepIdx: watermark,
					stopReason: "end_turn",
					nowMs: fixedNowMs,
				}),
				undefined,
			);

			// New error step at idx=3 after watermark MUST trigger.
			createConversationDb(cfg, "sess-wm-1", [
				{ idx: 0, stepType: 14, payload: "user" },
				{ idx: 1, stepType: 17, payload: "Error 429, Message: old quota error, Status: RESOURCE_EXHAUSTED" },
				{ idx: 2, stepType: 15, payload: "planner ok" },
				{ idx: 3, stepType: 17, payload: "Error 403, Message: SUBSCRIPTION_REQUIRED, Status: PERMISSION_DENIED" },
			]);
			const outcome = inspectAntigravityTurnOutcome({
				config: cfg,
				sessionId: "sess-wm-1",
				startStepIdx: watermark,
				stopReason: "end_turn",
				nowMs: fixedNowMs,
			});
			assert.ok(outcome);
			assert.equal(outcome.kind, "subscription_required");
			assert.equal(outcome.httpStatus, 403);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});

describe("TurnCoordinator outcome, permissions, mode updates, usage forwarding, and inactivity watchdog", () => {
	it("fails cleanly on SQLite step_type=17 errors and refusal stopReason with non-retryable messages", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-outcome-e2e-"));
		const { binPath } = writeScenarioMockAgy(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), new AcpProcessManager(), broker, cfg);
		coord.setActiveContext(interactiveContext(tmpRoot));
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));

		try {
			const statuses: number[] = [];
			const u1: UserMessage = { role: "user", content: "SQLITE_STEP17_QUOTA", timestamp: 1 };
			typedByHuman(coord.humanPromptGate, u1);
			const r1 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [u1], tools }), {
					sessionId: "pi-outcome-1",
					onResponse: (res) => {
						statuses.push(res.status);
					},
				})
				.result();
			assert.equal(r1.stopReason, "error");
			assert.ok(r1.errorMessage?.startsWith(ANTIGRAVITY_QUOTA_EXCEEDED_PREFIX));
			assert.match(r1.errorMessage ?? "", /4m42s/);
			assert.equal(isRetryableAssistantError(r1), false);
			assert.ok(statuses.includes(429), `expected telemetry status 429, got ${statuses.join(",")}`);

			const u2: UserMessage = { role: "user", content: "STOP_REASON_REFUSAL", timestamp: 2 };
			typedByHuman(coord.humanPromptGate, u2);
			const r2 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [u2], tools }), {
					sessionId: "pi-outcome-2",
				})
				.result();
			assert.equal(r2.stopReason, "error");
			assert.ok(r2.errorMessage?.startsWith(ANTIGRAVITY_QUOTA_EXCEEDED_PREFIX));
			assert.equal(isRetryableAssistantError(r2), false);

			const u3: UserMessage = { role: "user", content: "SQLITE_STEP17_THINKING_SIG", timestamp: 3 };
			typedByHuman(coord.humanPromptGate, u3);
			const r3 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [u3], tools }), {
					sessionId: "pi-outcome-3",
				})
				.result();
			assert.equal(r3.stopReason, "error");
			assert.match(r3.errorMessage ?? "", /\/new/);
			assert.equal(isRetryableAssistantError(r3), false);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("does not treat interaction_* options with kind reject_once as tool approval rejection", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-interaction-guard-"));
		const { binPath } = writeScenarioMockAgy(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), new AcpProcessManager(), broker, cfg);
		const ctx = interactiveContext(tmpRoot);
		ctx.ui.select = async (_title: string, options: string[]) => options[1]; // Pick "No" / "Deny" (kind: "reject_once")
		coord.setActiveContext(ctx);
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));

		try {
			const u1: UserMessage = { role: "user", content: "INTERACTION_REJECT_ONCE", timestamp: 1 };
			typedByHuman(coord.humanPromptGate, u1);
			const r1 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [u1], tools }), {
					sessionId: "pi-interact-1",
				})
				.result();
			assert.equal(r1.stopReason, "stop", `unexpected error: ${r1.errorMessage}`);

			const u2: UserMessage = { role: "user", content: "TOOL_REJECT_ONCE", timestamp: 2 };
			typedByHuman(coord.humanPromptGate, u2);
			const r2 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [u2], tools }), {
					sessionId: "pi-interact-2",
				})
				.result();
			assert.equal(r2.stopReason, "error");
			assert.match(r2.errorMessage ?? "", /Tool not approved: Run dangerous command/);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("handles current_mode_update, falls back unsupported auto mode once with warning, and warns on failed model switch", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-mode-warn-"));
		const { binPath, logPath } = writeScenarioMockAgy(tmpRoot, {
			availableModes: [
				{ id: "default", name: "Default" },
				{ id: "plan", name: "Plan" },
			],
			configOptions: [
				{
					id: "custom_model_opt",
					name: "Model",
					category: "model",
					type: "select",
					currentValue: "gemini-4-neon",
					options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }],
				},
				{
					id: "custom_mode_opt",
					name: "Mode",
					category: "mode",
					type: "select",
					currentValue: "default",
					options: [
						{ value: "default", name: "Default" },
						{ value: "plan", name: "Plan" },
					],
				},
			],
			failConfigIds: ["custom_model_opt"],
		});
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			agyExecutionMode: "auto",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), new AcpProcessManager(), broker, cfg);
		const warnings: string[] = [];
		let statusBarUpdates = 0;
		const ctx = interactiveContext(tmpRoot, {
			sessionManager: { getSessionId: () => "pi-mode-sess" },
		});
		ctx.ui.notify = (msg: string, level?: string) => {
			if (level === "warning") warnings.push(msg);
		};
		ctx.ui.setStatus = () => {
			statusBarUpdates++;
		};
		coord.setActiveContext(ctx);
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));

		try {
			const u1: UserMessage = { role: "user", content: "EMIT_CURRENT_MODE_PLAN", timestamp: 1 };
			typedByHuman(coord.humanPromptGate, u1);
			const statusBefore = statusBarUpdates;
			const r1 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [u1], tools }), {
					sessionId: "pi-mode-sess",
				})
				.result();
			assert.equal(r1.stopReason, "stop", r1.errorMessage);
			assert.ok(statusBarUpdates > statusBefore, "current_mode_update should refresh status bar");

			const callsAfterTurn1 = readRecordedCalls(logPath).filter(
				(c) => c.method === "session/set_config_option",
			);
			const modelCall = callsAfterTurn1.find((c) => c.params?.configId === "custom_model_opt");
			const modeCall = callsAfterTurn1.find((c) => c.params?.configId === "custom_mode_opt");
			assert.ok(modelCall, "should resolve model option id via category");
			assert.ok(modeCall, "should resolve mode option id via category");
			assert.equal(modeCall.params?.value, "default", "unsupported auto should fall back to default");

			const autoWarningsAfterTurn1 = warnings.filter((w) => w.includes('"auto"'));
			const modelWarningsAfterTurn1 = warnings.filter((w) => w.includes("failed to switch model"));
			assert.equal(autoWarningsAfterTurn1.length, 1, "should warn once about unsupported auto mode");
			assert.equal(modelWarningsAfterTurn1.length, 1, "should warn when model set_config_option fails");

			// Switch config to "plan" — because current_mode_update already updated appliedExecMode to "plan",
			// turn 2 must NOT send a redundant set_config_option for mode!
			coord.setConfig({ ...cfg, agyExecutionMode: "plan" });
			const u2: UserMessage = { role: "user", content: "SECOND_TURN_PLAN", timestamp: 2 };
			typedByHuman(coord.humanPromptGate, u2);
			const r2 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [u1, r1, u2], tools }), {
					sessionId: "pi-mode-sess",
				})
				.result();
			assert.equal(r2.stopReason, "stop", r2.errorMessage);
			const modeCallsTotal = readRecordedCalls(logPath).filter(
				(c) => c.method === "session/set_config_option" && c.params?.configId === "custom_mode_opt",
			);
			assert.equal(modeCallsTotal.length, 1, "current_mode_update should prevent redundant mode RPC");

			// Switch config back to unsupported "auto" — warning must NOT spam again for the same session.
			coord.setConfig({ ...cfg, agyExecutionMode: "auto" });
			const u3: UserMessage = { role: "user", content: "THIRD_TURN_AUTO", timestamp: 3 };
			typedByHuman(coord.humanPromptGate, u3);
			const r3 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [u1, r1, u2, r2, u3], tools }), {
					sessionId: "pi-mode-sess",
				})
				.result();
			assert.equal(r3.stopReason, "stop", r3.errorMessage);
			const autoWarningsAfterTurn3 = warnings.filter((w) => w.includes('"auto"'));
			assert.equal(autoWarningsAfterTurn3.length, 1, "unsupported auto warning must fire only once");

			// Once config_option_update advertises "auto", applyExecutionModeLive("auto") sends "auto".
			const u4: UserMessage = { role: "user", content: "EMIT_CONFIG_ADD_AUTO", timestamp: 4 };
			typedByHuman(coord.humanPromptGate, u4);
			const r4 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [u1, r1, u2, r2, u3, r3, u4], tools }), {
					sessionId: "pi-mode-sess",
				})
				.result();
			assert.equal(r4.stopReason, "stop", r4.errorMessage);
			await coord.applyExecutionModeLive("auto");
			const liveModeCalls = readRecordedCalls(logPath).filter(
				(c) => c.method === "session/set_config_option" && c.params?.configId === "custom_mode_opt",
			);
			assert.equal(liveModeCalls[liveModeCalls.length - 1]?.params?.value, "auto");
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("forwards out-of-turn usage_update to outOfTurnListener and updates telemetry", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-oot-usage-"));
		const { binPath } = writeScenarioMockAgy(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), new AcpProcessManager(), broker, cfg);
		coord.setActiveContext(
			interactiveContext(tmpRoot, { sessionManager: { getSessionId: () => "pi-oot-usage" } }),
		);
		const forwarded: Array<{ sessionId: string; update: AcpSessionUpdatePayload }> = [];
		coord.setOutOfTurnListener((sessionId, update) => {
			forwarded.push({ sessionId, update });
		});
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));

		try {
			const u1: UserMessage = { role: "user", content: "EMIT_OUT_OF_TURN_USAGE", timestamp: 1 };
			typedByHuman(coord.humanPromptGate, u1);
			const r1 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [u1], tools }), {
					sessionId: "pi-oot-usage",
				})
				.result();
			assert.equal(r1.stopReason, "stop", r1.errorMessage);

			await new Promise((resolve) => setTimeout(resolve, 80));
			const usageEvent = forwarded.find((entry) => entry.update.sessionUpdate === "usage_update");
			assert.ok(usageEvent, "expected out-of-turn usage_update to reach outOfTurnListener");
			assert.equal(usageEvent.sessionId, r1.responseId);
			if (usageEvent.update.sessionUpdate === "usage_update") {
				assert.equal(usageEvent.update.used, 42_000);
				assert.equal(usageEvent.update.size, 1_048_576);
			}
			const telemetry = coord.getTelemetrySnapshot("pi-oot-usage");
			assert.equal(telemetry.usedTokens, 42_000);
			assert.equal(telemetry.windowSize, 1_048_576);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("fires inactivity watchdog on silent stall, surfaces SQLite error if present, pauses during open dialogs, and resets on activity", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-watchdog-"));
		const { binPath, logPath } = writeScenarioMockAgy(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), new AcpProcessManager(), broker, cfg);
		coord.setPromptInactivityTimeoutMs(90);

		const ctx = interactiveContext(tmpRoot);
		ctx.ui.select = async (_title: string, options: string[]) => {
			// Hold permission dialog open well past the 90ms watchdog timeout.
			await new Promise((resolve) => setTimeout(resolve, 210));
			return options[0];
		};
		ctx.ui.input = async () => {
			// Hold elicitation dialog open well past the 90ms watchdog timeout.
			await new Promise((resolve) => setTimeout(resolve, 210));
			return "my-answer";
		};
		coord.setActiveContext(ctx);
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));

		try {
			// 1. Silent stall triggers watchdog, sends session/cancel, and fails cleanly (non-retryable).
			const uStall: UserMessage = { role: "user", content: "SILENT_STALL", timestamp: 1 };
			typedByHuman(coord.humanPromptGate, uStall);
			const rStall = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [uStall], tools }), {
					sessionId: "pi-wd-stall",
				})
				.result();
			assert.equal(rStall.stopReason, "error");
			assert.match(rStall.errorMessage ?? "", /inactivity/i);
			assert.equal(isRetryableAssistantError(rStall), false);
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.ok(
				readRecordedCalls(logPath).some((c) => c.method === "session/cancel"),
				"watchdog must send session/cancel",
			);

			// 2. Silent stall with SQLite step_type=17 surfaces the classified SQLite error.
			const uSqlErr: UserMessage = {
				role: "user",
				content: "SILENT_STALL_WITH_SQLITE_ERROR",
				timestamp: 2,
			};
			typedByHuman(coord.humanPromptGate, uSqlErr);
			const rSqlErr = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [uSqlErr], tools }), {
					sessionId: "pi-wd-sql",
				})
				.result();
			assert.equal(rSqlErr.stopReason, "error");
			assert.match(rSqlErr.errorMessage ?? "", /\/agy login/);
			assert.equal(isRetryableAssistantError(rSqlErr), false);

			// 3. Open permission dialog pauses watchdog past timeout, then turn completes cleanly.
			const uPerm: UserMessage = { role: "user", content: "DIALOG_PAUSE_PERMISSION", timestamp: 3 };
			typedByHuman(coord.humanPromptGate, uPerm);
			const rPerm = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [uPerm], tools }), {
					sessionId: "pi-wd-perm",
				})
				.result();
			assert.equal(rPerm.stopReason, "stop", rPerm.errorMessage);

			// 4. Open elicitation dialog pauses watchdog past timeout, then turn completes cleanly.
			const uElicit: UserMessage = {
				role: "user",
				content: "DIALOG_PAUSE_ELICITATION",
				timestamp: 4,
			};
			typedByHuman(coord.humanPromptGate, uElicit);
			const rElicit = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [uElicit], tools }), {
					sessionId: "pi-wd-elicit",
				})
				.result();
			assert.equal(rElicit.stopReason, "stop", rElicit.errorMessage);

			// 5. Activity updates (usage_update, plan, agent_thought_chunk) reset watchdog past 2.5x timeout.
			const uKeepAlive: UserMessage = { role: "user", content: "ACTIVITY_KEEPALIVE", timestamp: 5 };
			typedByHuman(coord.humanPromptGate, uKeepAlive);
			const rKeepAlive = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [uKeepAlive], tools }), {
					sessionId: "pi-wd-keepalive",
				})
				.result();
			assert.equal(rKeepAlive.stopReason, "stop", rKeepAlive.errorMessage);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});

describe("parseStepMetadataGenerationUsage field 10 (responseTokens)", () => {
	it("includes field 9 (thoughtTokens) + field 10 (responseTokens) in outputTokens and non-zero check", () => {
		const splitOnly = encodeMetadataUsage([
			[9, 120],
			[10, 85],
		]);
		assert.deepEqual(parseStepMetadataGenerationUsage(splitOnly, 7), {
			stepIdx: 7,
			inputTokens: 0,
			outputTokens: 205,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			thoughtTokens: 120,
		});

		const splitLargerThanRaw = encodeMetadataUsage([
			[2, 500],
			[3, 100],
			[9, 80],
			[10, 70],
		]);
		assert.deepEqual(parseStepMetadataGenerationUsage(splitLargerThanRaw, 8), {
			stepIdx: 8,
			inputTokens: 500,
			outputTokens: 150,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			thoughtTokens: 80,
		});

		const rawLargerThanSplit = encodeMetadataUsage([
			[2, 500],
			[3, 300],
			[9, 80],
			[10, 70],
		]);
		assert.deepEqual(parseStepMetadataGenerationUsage(rawLargerThanSplit, 9), {
			stepIdx: 9,
			inputTokens: 500,
			outputTokens: 300,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			thoughtTokens: 80,
		});

		const responseOnly = encodeMetadataUsage([[10, 42]]);
		assert.deepEqual(parseStepMetadataGenerationUsage(responseOnly, 10), {
			stepIdx: 10,
			inputTokens: 0,
			outputTokens: 42,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			thoughtTokens: undefined,
		});
	});
});
