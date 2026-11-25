import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
	isRetryableAssistantError,
	normalizeContext,
	type AssistantMessageEvent,
	type Message,
	type Model,
	type ToolCall,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AcpProcessManager } from "../src/acp/process-manager.ts";
import { DEFAULT_BRIDGE_CONFIG, type BridgeConfig } from "../src/config.ts";
import { TurnCoordinator } from "../src/session/turn-coordinator.ts";
import {
	AgyTurnMirrorBroker,
	createAgyMirrorToolDefinitions,
} from "../src/tools/agy-mirror-tools.ts";
import { interactiveContext, interactiveToolContext, typedByHuman } from "./human-input.ts";
import { THIN_CLIENT_DISABLED } from "./thin-client-skip.ts";

/**
 * 生成一个纯 Node.js 标准库编写的跨平台模拟 `agy acp` 服务端脚本，
 * 真实走 stdio NDJSON 与本地 Streamable HTTP MCP 网络套接字进行端到端协议验证。
 */
function writeMockAgyExecutable(
	dir: string,
	options?: { seedTemplateDbOnNew?: boolean; incompleteFirstDb?: boolean; lazyConversationDb?: boolean },
): string {
	const scriptPath = path.join(dir, "mock-agy.mjs");
	const seedTemplateDbOnNew = Boolean(options?.seedTemplateDbOnNew);
	const scriptSource = `#!/usr/bin/env node
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const mockRootDir = path.dirname(fileURLToPath(import.meta.url));
const seedTemplateDbOnNew = ${seedTemplateDbOnNew};
const incompleteFirstDb = ${Boolean(options?.incompleteFirstDb)};
const lazyConversationDb = ${Boolean(options?.lazyConversationDb)};
const isModeA = !process.argv.some((arg) => arg.startsWith("pi-bridge"));
const sessions = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
function mcpHttpUrl(sess) {
  return sess.mcpHttp.url;
}

function seedConversationDb(sessionId) {
  const convDir = path.join(mockRootDir, ".gemini", "antigravity-cli", "conversations");
  fs.mkdirSync(convDir, { recursive: true });
  const dbPath = path.join(convDir, sessionId + ".db");
  const db = new DatabaseSync(dbPath);
  db.exec(\`
    PRAGMA user_version = 1;
    CREATE TABLE IF NOT EXISTS trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer);
    CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS executor_metadata (idx integer PRIMARY KEY, data blob);
    CREATE TABLE IF NOT EXISTS parent_references (idx integer PRIMARY KEY, data blob);
    CREATE TABLE IF NOT EXISTS trajectory_metadata_blob (id text PRIMARY KEY DEFAULT "main", data blob);
    CREATE TABLE IF NOT EXISTS battle_mode_infos (idx integer PRIMARY KEY, data blob);
  \`);
  db.prepare("INSERT OR REPLACE INTO trajectory_meta VALUES (?, ?, 4, 17)").run(sessionId, sessionId);
  const agentTag = isModeA ? "default-agy-agent" : "pi-bridge";
  const blob = Buffer.from("mock-meta:" + agentTag + ":" + sessionId, "utf8");
  db.prepare("INSERT OR REPLACE INTO trajectory_metadata_blob VALUES ('main', ?)").run(blob);
  db.close();
}

let nextServerReqId = 9000;
const serverPending = new Map();

function requestClient(method, params) {
  const id = nextServerReqId++;
  return new Promise((resolve) => {
    serverPending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method) {
    const lastText = msg.params?.prompt?.[msg.params.prompt.length - 1]?.text;
    fs.appendFileSync(path.join(mockRootDir, "mock-calls.log"), JSON.stringify({ method: msg.method, text: lastText }) + "\\n");
  }

  if (msg.id !== undefined && !msg.method && serverPending.has(msg.id)) {
    const fn = serverPending.get(msg.id);
    serverPending.delete(msg.id);
    fn(msg.result);
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: { resume: {}, close: {}, list: {}, load: {}, additionalDirectories: {} },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } }
        },
        agentInfo: { name: "Mock AGY", version: "1.5.13" }
      }
    });
    return;
  }

  if (msg.method === "session/new") {
    const sessionId = seedTemplateDbOnNew
      ? crypto.randomUUID()
      : "mock-session-" + (sessions.size + 1);
    const mcpHttp = (msg.params?.mcpServers || []).find((s) => s.type === "http");
    sessions.set(sessionId, { mcpHttp });

    if (incompleteFirstDb && sessions.size === 1) {
      const convDir = path.join(mockRootDir, ".gemini", "antigravity-cli", "conversations");
      fs.mkdirSync(convDir, { recursive: true });
      const db = new DatabaseSync(path.join(convDir, sessionId + ".db"));
      db.close();
      fs.writeFileSync(path.join(mockRootDir, "incomplete-session-id"), sessionId);
    } else if (seedTemplateDbOnNew && !lazyConversationDb) {
      seedConversationDb(sessionId);
    }

    if (mcpHttp) {
      const authHeader = mcpHttp.headers?.[0]?.value || "";
      await fetch(mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })
      });
      await fetch(mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      });
    }

    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId,
        models: { availableModels: [{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" }] },
        configOptions: [
          { id: "model", name: "Model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] },
          { id: "thought_level", name: "Thinking", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
          { id: "mode", name: "Mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] }
        ],
        _meta: { antigravity: { tier: { id: "ultra", name: "Google AI Ultra" } } }
      }
    });
    return;
  }

  if (msg.method === "session/cancel") {
    const cancelSid = msg.params?.sessionId;
    const sess = cancelSid ? sessions.get(cancelSid) : undefined;
    if (Array.isArray(sess?.activeFetchAbortControllers)) {
      for (const ac of sess.activeFetchAbortControllers) {
        try { ac.abort(); } catch {}
      }
      sess.activeFetchAbortControllers = [];
    }
    if (sess?.cancelablePromptId !== undefined) {
      const pid = sess.cancelablePromptId;
      sess.cancelablePromptId = undefined;
      sess.inFlightPromptId = undefined;
      send({ jsonrpc: "2.0", id: pid, result: { stopReason: "cancelled" } });
    }
    // 注意：真实 ACP 协议中 session/cancel 是单向通知，不返回 JSON-RPC response
    return;
  }

  if (msg.method === "session/resume") {
    const resumeSid = msg.params?.sessionId || "resumed-session";
    if (seedTemplateDbOnNew && !isModeA) {
      const dbPath = path.join(mockRootDir, ".gemini", "antigravity-cli", "conversations", resumeSid + ".db");
      if (!fs.existsSync(dbPath)) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Missing db for resume" } });
        return;
      }
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const blobRow = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get();
      db.close();
      const blobStr = blobRow?.data ? Buffer.from(blobRow.data).toString("utf8") : "";
      if (!blobStr.includes("pi-bridge") || !blobStr.includes(resumeSid)) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: "Resumed DB missing pi-bridge trajectory_metadata_blob" }
        });
        return;
      }
    }
    const mcpHttp = (msg.params?.mcpServers || []).find((s) => s.type === "http");
    const prevSess = sessions.get(resumeSid) || {};
    const sessObj = { ...prevSess, mcpHttp, resumeCount: (prevSess.resumeCount || 0) + 1 };
    if (mcpHttp) {
      const authHeader = mcpHttp.headers?.[0]?.value || "";
      const listRes = await fetch(mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ jsonrpc: "2.0", id: 200 + sessObj.resumeCount, method: "tools/list", params: {} })
      }).then((r) => r.json());
      sessObj.knownTools = (listRes.result?.tools || []).map((t) => t.name);
    }
    sessions.set(resumeSid, sessObj);
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: resumeSid,
        models: { availableModels: [{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" }] },
        configOptions: [
          { id: "model", name: "Model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] },
          { id: "thought_level", name: "Thinking", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
          { id: "mode", name: "Mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] }
        ]
      }
    });
    return;
  }

  if (msg.method === "session/set_config_option" || msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "session/prompt") {
    const { sessionId, prompt } = msg.params;
    const sess = sessions.get(sessionId);

    // 模拟真实 agy acp 协议约束：同一会话若上一轮 session/prompt 尚未结算就收到重叠 session/prompt，
    // 立即令旧请求提前返回 end_turn 并挂死新请求，确保测试能严格拦截任何并发抢占回归！
    if (sess?.inFlightPromptId !== undefined) {
      const oldId = sess.inFlightPromptId;
      sess.inFlightPromptId = msg.id;
      send({ jsonrpc: "2.0", id: oldId, result: { stopReason: "end_turn" } });
      return;
    }

    const lastBlockText = prompt?.[prompt.length - 1]?.text || "";

    const startsUpstreamBatch = lastBlockText === "TRIGGER_UPSTREAM_BATCH" || lastBlockText === "TRIGGER_UPSTREAM_PARTIAL_BATCH";
    if (seedTemplateDbOnNew && sess && (startsUpstreamBatch ||
        (sess.continueUpstreamBatch && lastBlockText === "Continue from where you left off."))) {
      const first = startsUpstreamBatch;
      if (first) sess.missingFinalSnapshot = lastBlockText === "TRIGGER_UPSTREAM_PARTIAL_BATCH";
      sess.continueUpstreamBatch = first;
      if (first && lazyConversationDb) seedConversationDb(sessionId);
      const db = new DatabaseSync(path.join(mockRootDir, ".gemini", "antigravity-cli", "conversations", sessionId + ".db"));
      const field = (tag, value) => Buffer.concat([Buffer.from([tag, value.length]), value]);
      const userMessage = Buffer.concat([Buffer.from([0x10, 1]), field(0x1a, Buffer.from(first ? "first" : "second generation with more context"))]);
      const data = !first && sess.missingFinalSnapshot ? null : field(0x0a, field(0x12, userMessage));
      const genIdx = db.prepare("SELECT COALESCE(MAX(idx) + 1, 0) AS idx FROM gen_metadata").get().idx;
      const stepIdx = db.prepare("SELECT COALESCE(MAX(idx) + 1, 0) AS idx FROM steps").get().idx;
      db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)").run(genIdx, data, data?.length ?? 0);
      db.prepare("INSERT INTO steps (idx, step_type, status) VALUES (?, 14, 3)").run(stepIdx);
      db.close();
      if (!first) {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BATCH_COMPLETE" } } } });
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: first ? "max_turn_requests" : "end_turn", usage: { inputTokens: 100, outputTokens: 5 } } });
      return;
    }

    if (lastBlockText === "TEST_TOOL_APPROVAL") {
      const permission = await requestClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "approval-1", title: "Run mcp_pi_tools_read" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" }
        ]
      });
      if (permission?.outcome?.optionId === "allow") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "APPROVED" } } } });
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (lastBlockText === "AUX_STOP_REFUSAL") {
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "refusal" } });
      return;
    }

    if (lastBlockText === "AGY_STOP_CANCELLED") {
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "cancelled" } });
      return;
    }

    if (lastBlockText === "SPAWN_SELF_SUBAGENT") {
      sess.inFlightPromptId = msg.id;
      const rawInput = { Prompt: "Lege die Datei an.", Role: "File Creator Subagent", TypeName: "self" };
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "spawn_1", name: "invoke_subagent", title: "Run invoke_subagent", kind: "other", status: "in_progress", rawInput } } });
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "spawn_1", status: "completed", kind: "other", title: "Run invoke_subagent", rawInput } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Subagent gestartet." } } } });
        sess.inFlightPromptId = undefined;
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }, 20);
      return;
    }

    if (lastBlockText === "STEER_REPLY") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Steer handled." } } }
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (lastBlockText === "WAKE_LATER") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Timer set." } } }
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      // agy >= 1.5.10: the turn it takes on its own after a wake-up streams right away.
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "auto_1", title: "Run manage_task", kind: "other", status: "pending" } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "auto_1", status: "completed" } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The timer expired." } } } });
      }, 30);
      return;
    }

    if (lastBlockText === "QUOTA_EXHAUSTED_429") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\u26a0 RESOURCE_EXHAUSTED (code 429): Resource has been exhausted.\\n" } } }
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (lastBlockText === "HANG_FOREVER") {
      if (sess) sess.inFlightPromptId = msg.id;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hanging..." } } }
      });
      // 模拟极端死锁：即使收到 session/cancel 也不回包
      return;
    }

    if (lastBlockText === "TRIGGER_TOOL_SEARCH_UNLOCK" && !isModeA && sess?.mcpHttp) {
      const myPromptId = msg.id;
      sess.inFlightPromptId = myPromptId;
      sess.cancelablePromptId = myPromptId;
      const authHeader = sess.mcpHttp.headers?.[0]?.value || "";
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp_ts_1", name: "mcp_pi_tools_tool_search", title: "Run mcp_pi_tools_tool_search" } }
      });
      await fetch(mcpHttpUrl(sess), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ jsonrpc: "2.0", id: 501, method: "tools/call", params: { name: "tool_search", arguments: { query: "secret" } } })
      }).then((r) => r.json());
      await new Promise((r) => setTimeout(r, 80));
      if (sess.inFlightPromptId !== myPromptId) return;
      sess.inFlightPromptId = undefined;
      sess.cancelablePromptId = undefined;
      send({ jsonrpc: "2.0", id: myPromptId, result: { stopReason: "end_turn" } });
      return;
    }

    if (lastBlockText.includes("The newly activated tools are now loaded") && sess) {
      sess.inFlightPromptId = undefined;
      const names = (sess.knownTools || []).join(",");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LOADED_TOOLS=" + names + ";RESUMES=" + (sess.resumeCount || 0) } } }
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (lastBlockText === "HYBRID_NATIVE_PI_TOOLS_FILE" && sess) {
      sess.inFlightPromptId = msg.id;
      // 模拟 hybrid 模式下原生 read_file 读取文件名含 pi_tools 的文件（name="read_file", title 含 pi_tools）
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "native_read_pi_tools_1",
            name: "read_file",
            title: "File src/pi_tools_helper.ts",
            kind: "read",
            status: "in_progress",
            locations: [{ path: "src/pi_tools_helper.ts" }]
          }
        }
      });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "native_read_pi_tools_1",
              name: "read_file",
              title: "File src/pi_tools_helper.ts",
              status: "completed",
              content: [{ type: "content", content: { type: "text", text: "export const ok = true;" } }]
            }
          }
        });
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Native read OK" } } }
        });
        sess.inFlightPromptId = undefined;
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }, 25);
      return;
    }

    if (lastBlockText === "CANCEL_RESPONSIVE") {
      if (sess) {
        sess.inFlightPromptId = msg.id;
        sess.cancelablePromptId = msg.id;
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Counting 1..." } } }
      });
      return;
    }

    if (lastBlockText === "SAME_GEN_DUAL_SEQ_TOOLS" && !isModeA && sess?.mcpHttp) {
      sess.inFlightPromptId = msg.id;
      const authHeader = sess.mcpHttp.headers?.[0]?.value || "";
      // 同一次 LLM 生成连续串行执行 2 个工具（used 窗口水位保持 50000 不变）
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "usage_update", used: 50000, size: 1048576 } }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "dup_1", title: "mcp_pi_tools_read" } }
      });
      await fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 31,
          method: "tools/call",
          params: { name: "read", arguments: { path: "one.ts" }, _meta: { "antigravity.google/root_conversation_id": sessionId } }
        })
      }).then((r) => r.json());

      // 第 2 个工具在同一生成中紧随其后发出（无新 usage_update 或相同 used=50000）
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "dup_2", title: "mcp_pi_tools_read" } }
      });
      await fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 32,
          method: "tools/call",
          params: { name: "read", arguments: { path: "two.ts" }, _meta: { "antigravity.google/root_conversation_id": sessionId } }
        })
      }).then((r) => r.json());

      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "usage_update", used: 54000, size: 1048576 } }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Summary ok." } } }
      });
      sess.inFlightPromptId = undefined;
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 4000, cachedReadTokens: 100000, outputTokens: 8000, thoughtTokens: 1000 }
        }
      });
      return;
    }

    if (lastBlockText === "MULTI_STEP_WITH_STEER" && !isModeA && sess?.mcpHttp) {
      const myPromptId = msg.id;
      sess.inFlightPromptId = myPromptId;
      sess.cancelablePromptId = myPromptId;
      const authHeader = sess.mcpHttp.headers?.[0]?.value || "";

      // Step 1：读取 a.ts
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "usage_update", used: 20000, size: 1048576 } }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp_ms_1", title: "mcp_pi_tools_read" } }
      });
      const res1 = await fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: {
            name: "read",
            arguments: { path: "a.ts" },
            _meta: { "antigravity.google/root_conversation_id": sessionId }
          }
        })
      }).then((r) => r.json());

      sess.savedA = (res1.result?.content || []).map((c) => c.text || "").join("\\n");
      // 等待短暂窗口以允许工具边界处的 session/cancel 即时介入（验证 steer 在第 1 个工具结束边界立即切入，而非拖到整轮末尾！）
      await new Promise((r) => setTimeout(r, 80));
      if (sess.inFlightPromptId !== myPromptId) {
        return;
      }

      sess.inFlightPromptId = undefined;
      sess.cancelablePromptId = undefined;
      send({
        jsonrpc: "2.0",
        id: myPromptId,
        result: { stopReason: "end_turn", usage: { inputTokens: 8000, cachedReadTokens: 12000, outputTokens: 50 } }
      });
      return;
    }

    if (lastBlockText === "顺便检查缓存显示" && !isModeA && sess?.mcpHttp) {
      sess.inFlightPromptId = msg.id;
      const authHeader = sess.mcpHttp.headers?.[0]?.value || "";
      // 转向消息立即在同一会话切入：保留已完成的 a.ts 结果（sess.savedA），继续读取未完成的 b.ts 并一并答复转向问题！
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "usage_update", used: 28000, size: 1048576 } }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp_ms_2", title: "mcp_pi_tools_read" } }
      });
      const res2 = await fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 22,
          method: "tools/call",
          params: {
            name: "read",
            arguments: { path: "b.ts" },
            _meta: { "antigravity.google/root_conversation_id": sessionId }
          }
        })
      }).then((r) => r.json());

      const combinedText2 = (res2.result?.content || []).map((c) => c.text || "").join("\\n");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "usage_update", used: 32000, size: 1048576 } }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Both done! A=" + (sess.savedA || "") + " B=" + combinedText2 + "\\n\\nSteerAnswered=true" }
          }
        }
      });
      sess.inFlightPromptId = undefined;
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "end_turn", usage: { inputTokens: 600, cachedReadTokens: 31400, outputTokens: 40 } }
      });
      return;
    }

    if (lastBlockText.startsWith("SEQ_TOOLS:") && !isModeA && sess?.mcpHttp) {
      const count = Math.max(1, Number.parseInt(lastBlockText.slice("SEQ_TOOLS:".length), 10) || 1);
      const myPromptId = msg.id;
      sess.inFlightPromptId = myPromptId;
      sess.cancelablePromptId = myPromptId;
      const authHeader = sess.mcpHttp.headers?.[0]?.value || "";
      for (let i = 1; i <= count; i++) {
        if (sess.inFlightPromptId !== myPromptId) return;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "seq_" + myPromptId + "_" + i, title: "mcp_pi_tools_read" } }
        });
        await fetch(sess.mcpHttp.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 500 + i,
            method: "tools/call",
            params: { name: "read", arguments: { path: "seq-" + i + ".ts" }, _meta: { "antigravity.google/root_conversation_id": sessionId } }
          })
        }).then((r) => r.json());
      }
      if (sess.inFlightPromptId !== myPromptId) return;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Seq done " + count } } }
      });
      sess.inFlightPromptId = undefined;
      sess.cancelablePromptId = undefined;
      send({
        jsonrpc: "2.0",
        id: myPromptId,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 10000, cachedReadTokens: 190000, outputTokens: 500 }
        }
      });
      return;
    }

    if (lastBlockText === "DELAYED_WAL_TOOL" && !isModeA && sess?.mcpHttp) {
      const myPromptId = msg.id;
      sess.inFlightPromptId = myPromptId;
      const authHeader = sess.mcpHttp.headers?.[0]?.value || "";
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "wal_1", title: "mcp_pi_tools_read" } }
      });
      const dbPath = path.join(mockRootDir, ".gemini", "antigravity-cli", "conversations", sessionId + ".db");
      setTimeout(() => {
        try {
          const encodeVarint = (n) => {
            const out = [];
            let v = n;
            while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
            out.push(v);
            return out;
          };
          const f9 = Buffer.from([
            (2 << 3) | 0, ...encodeVarint(3000),
            (3 << 3) | 0, ...encodeVarint(220),
            (5 << 3) | 0, ...encodeVarint(97000),
          ]);
          const meta = Buffer.from([(9 << 3) | 2, ...encodeVarint(f9.length), ...f9]);
          const tcSub = Buffer.from([(7 << 3) | 2, 2, 0x08, 0x01]);
          const payload = Buffer.from([...encodeVarint((20 << 3) | 2), ...encodeVarint(tcSub.length), ...tcSub]);
          const db = new DatabaseSync(dbPath);
          db.prepare("INSERT OR REPLACE INTO steps VALUES (99, 15, 3, ?, ?)").run(payload, meta);
          db.close();
        } catch {}
      }, 28);
      await fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 601,
          method: "tools/call",
          params: { name: "read", arguments: { path: "wal.ts" }, _meta: { "antigravity.google/root_conversation_id": sessionId } }
        })
      }).then((r) => r.json());
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "WAL ok" } } }
      });
      sess.inFlightPromptId = undefined;
      send({
        jsonrpc: "2.0",
        id: myPromptId,
        result: { stopReason: "end_turn", usage: { inputTokens: 3000, cachedReadTokens: 97000, outputTokens: 250 } }
      });
      return;
    }

    if (lastBlockText.startsWith("FOLLOWUP_MSG:") && sess) {
      sess.inFlightPromptId = msg.id;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Echo -> " + lastBlockText }
          }
        }
      });
      sess.inFlightPromptId = undefined;
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "end_turn", usage: { inputTokens: 500, cachedReadTokens: 32000, outputTokens: 25 } }
      });
      return;
    }

    if (
      Array.isArray(prompt) &&
      prompt.some((b) => b?.type === "image") &&
      prompt.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.includes("<tool_result ")) &&
      sess
    ) {
      sess.inFlightPromptId = msg.id;
      const imgBlocks = prompt.filter((b) => b?.type === "image");
      const mimes = imgBlocks.map((b) => b.mimeType || "").join(",");
      const decodedBytes = imgBlocks
        .map((b) => Buffer.byteLength(String(b.data || ""), "base64"))
        .join(",");
      const summary =
        "DEFERRED_IMAGES_RECEIVED=" +
        imgBlocks.length +
        ";MIMES=" +
        mimes +
        ";BYTES=" +
        decodedBytes +
        ";MCP_INLINE_IMAGES=" +
        (sess.lastMcpImageCount ?? -1) +
        ";TEXT_TOOL=" +
        (sess.lastTextToolResult || "none") +
        ";SESSION=" +
        sessionId;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: summary }
          }
        }
      });
      sess.inFlightPromptId = undefined;
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "end_turn", usage: { inputTokens: 1200, cachedReadTokens: 32000, outputTokens: 40 } }
      });
      return;
    }

    if (lastBlockText === "TRIGGER_MCP_SINGLE_IMAGE" && !isModeA && sess?.mcpHttp) {
      const myPromptId = msg.id;
      sess.inFlightPromptId = myPromptId;
      sess.cancelablePromptId = myPromptId;
      const authHeader = sess.mcpHttp.headers?.[0]?.value || "";
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp_img_1", title: "mcp_pi_tools_read" } }
      });
      const mcpResp = await fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 601,
          method: "tools/call",
          params: { name: "read", arguments: { path: "sample.png" }, _meta: { "antigravity.google/root_conversation_id": sessionId } }
        })
      }).then((r) => r.json());
      const contentItems = Array.isArray(mcpResp?.result?.content) ? mcpResp.result.content : [];
      sess.lastMcpImageCount = contentItems.filter((c) => c?.type === "image").length;
      sess.lastTextToolResult = "none";
      await new Promise((r) => setTimeout(r, 120));
      if (sess.inFlightPromptId !== myPromptId) return;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "INLINE_MCP_IMAGES=" + sess.lastMcpImageCount + ";SESSION=" + sessionId }
          }
        }
      });
      sess.inFlightPromptId = undefined;
      sess.cancelablePromptId = undefined;
      send({
        jsonrpc: "2.0",
        id: myPromptId,
        result: { stopReason: "end_turn", usage: { inputTokens: 800, cachedReadTokens: 32000, outputTokens: 20 } }
      });
      return;
    }

    if (lastBlockText === "TRIGGER_MCP_CONCURRENT_IMAGE_AND_TEXT" && !isModeA && sess?.mcpHttp) {
      const myPromptId = msg.id;
      sess.inFlightPromptId = myPromptId;
      sess.cancelablePromptId = myPromptId;
      const authHeader = sess.mcpHttp.headers?.[0]?.value || "";
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp_par_img_1", title: "mcp_pi_tools_read" } }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp_par_txt_2", title: "mcp_pi_tools_bash" } }
      });
      const p1 = fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 611,
          method: "tools/call",
          params: { name: "read", arguments: { path: "big.png" }, _meta: { "antigravity.google/root_conversation_id": sessionId } }
        })
      }).then((r) => r.json());
      await new Promise((r) => setTimeout(r, 35));
      const p2 = fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 612,
          method: "tools/call",
          params: { name: "bash", arguments: { command: "echo hi" }, _meta: { "antigravity.google/root_conversation_id": sessionId } }
        })
      }).then((r) => r.json());
      const [r1, r2] = await Promise.all([p1, p2]);
      const c1 = Array.isArray(r1?.result?.content) ? r1.result.content : [];
      const c2 = Array.isArray(r2?.result?.content) ? r2.result.content : [];
      sess.lastMcpImageCount = c1.filter((c) => c?.type === "image").length;
      sess.lastTextToolResult = c2.map((c) => c?.text || "").join("");
      await new Promise((r) => setTimeout(r, 120));
      if (sess.inFlightPromptId !== myPromptId) return;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "CONCURRENT_INLINE_ONLY" }
          }
        }
      });
      sess.inFlightPromptId = undefined;
      sess.cancelablePromptId = undefined;
      send({
        jsonrpc: "2.0",
        id: myPromptId,
        result: { stopReason: "end_turn", usage: { inputTokens: 900, cachedReadTokens: 32000, outputTokens: 20 } }
      });
      return;
    }

    if (
      Array.isArray(prompt) &&
      !prompt.some((b) => b?.type === "image") &&
      prompt.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.includes("<tool_result ")) &&
      sess
    ) {
      sess.inFlightPromptId = msg.id;
      const joinedPromptText = prompt
        .filter((b) => b?.type === "text")
        .map((b) => String(b.text || ""))
        .join("\\n");
      const summary =
        "TEXT_CUTIN_LEN=" +
        Buffer.byteLength(joinedPromptText, "utf8") +
        ";HAS_HEAD=" +
        joinedPromptText.includes("HEAD_MARKER_ALPHA") +
        ";HAS_MID=" +
        joinedPromptText.includes("MIDDLE_MARKER_OMEGA") +
        ";HAS_TAIL=" +
        joinedPromptText.includes("TAIL_MARKER_ZETA") +
        ";HAS_DETACHED_A=" +
        joinedPromptText.includes("RESULT_SLOW_ALPHA") +
        ";HAS_DETACHED_B=" +
        joinedPromptText.includes("RESULT_SLOW_BETA") +
        ";SESSION=" +
        sessionId;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: summary }
          }
        }
      });
      sess.inFlightPromptId = undefined;
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "end_turn", usage: { inputTokens: 1500, cachedReadTokens: 32000, outputTokens: 35 } }
      });
      return;
    }

    if (lastBlockText === "TRIGGER_MCP_LARGE_TEXT" && !isModeA && sess?.mcpHttp) {
      const myPromptId = msg.id;
      sess.inFlightPromptId = myPromptId;
      sess.cancelablePromptId = myPromptId;
      const authHeader = sess.mcpHttp.headers?.[0]?.value || "";
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp_ltxt_1", name: "mcp_pi_tools_read", title: "mcp_pi_tools_read" } }
      });
      const mcpResp = await fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 701,
          method: "tools/call",
          params: { name: "read", arguments: { path: "large.ts" }, _meta: { "antigravity.google/root_conversation_id": sessionId } }
        })
      }).then((r) => r.json());
      const inlineTxt = mcpResp?.result?.content?.[0]?.text || "";
      sess.lastInlineNoticeLen = Buffer.byteLength(inlineTxt, "utf8");
      await new Promise((r) => setTimeout(r, 120));
      if (sess.inFlightPromptId !== myPromptId) return;
      send({
        jsonrpc: "2.0",
        id: myPromptId,
        result: { stopReason: "end_turn", usage: { inputTokens: 800, cachedReadTokens: 32000, outputTokens: 15 } }
      });
      return;
    }

    if (lastBlockText === "TRIGGER_MCP_CONCURRENT_HOLD_DETACH" && !isModeA && sess?.mcpHttp) {
      const myPromptId = msg.id;
      sess.inFlightPromptId = myPromptId;
      sess.cancelablePromptId = myPromptId;
      const authHeader = sess.mcpHttp.headers?.[0]?.value || "";
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      sess.activeFetchAbortControllers = [ac1, ac2];
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp_hd_1", name: "mcp_pi_tools_bash", title: "mcp_pi_tools_bash" } }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp_hd_2", name: "mcp_pi_tools_read", title: "mcp_pi_tools_read" } }
      });
      void fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 711,
          method: "tools/call",
          params: { name: "bash", arguments: { command: "sleep 1" }, _meta: { "antigravity.google/root_conversation_id": sessionId } }
        }),
        signal: ac1.signal
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 15));
      void fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 712,
          method: "tools/call",
          params: { name: "read", arguments: { path: "slow.txt" }, _meta: { "antigravity.google/root_conversation_id": sessionId } }
        }),
        signal: ac2.signal
      }).catch(() => {});
      return;
    }

    if (lastBlockText === "TRIGGER_RESIDUAL_BUILTIN_AND_MAX_TURN" && !isModeA && sess?.mcpHttp) {
      const authHeader = sess.mcpHttp.headers?.[0]?.value || "";
      // 先模拟后端推送非宿主内置工具调用 list_resources（不发 HTTP /mcp）
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "builtin_lr_1", name: "list_resources", title: "list_resources" } }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "builtin_lr_1", name: "list_resources", status: "completed" } }
      });
      // 再推送真正的宿主 MCP 工具调用
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp_real_1", name: "mcp_pi_tools_read", title: "mcp_pi_tools_read" } }
      });
      const r = await fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 721,
          method: "tools/call",
          params: { name: "read", arguments: { path: "ok.txt" }, _meta: { "antigravity.google/root_conversation_id": sessionId } }
        })
      }).then((res) => res.json());
      sess.savedOkText = r?.result?.content?.[0]?.text || "";
      // 模拟触及单轮生成步数上限返回 max_turn_requests（尚未输出总结正文）
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "max_turn_requests", usage: { inputTokens: 400, cachedReadTokens: 10000, outputTokens: 10 } }
      });
      return;
    }

    if (lastBlockText === "Continue from where you left off." && !isModeA && sess) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "AUTO_CONTINUED_OK:" + (sess.savedOkText || "") }
          }
        }
      });
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "end_turn", usage: { inputTokens: 450, cachedReadTokens: 11000, outputTokens: 25 } }
      });
      return;
    }

    if (!isModeA && sess?.mcpHttp) {
      // 模式 B：模拟中间步 usage_update + 思考 + 工具宣告 + HTTP MCP 挂起 + 最终步 usage_update 与累计账单返回
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "usage_update", used: 40000, size: 1048576 } }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking package.json..." } } }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp_tc_1", title: "mcp_pi_tools_read" } }
      });

      const authHeader = sess.mcpHttp.headers?.[0]?.value || "";
      const toolRes = await fetch(sess.mcpHttp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "read",
            arguments: { path: "package.json" },
            _meta: { "antigravity.google/root_conversation_id": sessionId }
          }
        })
      }).then((r) => r.json());

      const readText = toolRes.result?.content?.[0]?.text || "";
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "usage_update", used: 50000, size: 1048576 } }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Got result." } } }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "File read OK: " + readText } } }
      });
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 15000, cachedReadTokens: 75000, outputTokens: 80, thoughtTokens: 15 }
        }
      });
      return;
    }

    // 模式 A：原生工具切片 + 权限确认 + Diff 更新 + 续接正文
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Editing src/app.ts..." } } }
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "native_edit_1",
          kind: "edit",
          title: "Edit src/app.ts",
          status: "pending",
          locations: [{ path: "src/app.ts", line: 1 }]
        }
      }
    });

    // 请求客户端授权确认
    const perm = await requestClient("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "native_edit_1", title: "Edit src/app.ts", kind: "edit" },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" }
      ]
    });

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "native_edit_1",
          status: "completed",
          content: [
            { type: "diff", path: "src/app.ts", oldText: "const a = 1;", newText: "const a = 2;" },
            { type: "content", content: { type: "text", text: "Permission: " + perm?.outcome?.optionId } }
          ]
        }
      }
    });

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Native edit done!" } } }
    });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { stopReason: "end_turn", usage: { inputTokens: 200, outputTokens: 60 } }
    });
  }
});
`;

	fs.writeFileSync(scriptPath, scriptSource, { mode: 0o755 });
	if (process.platform === "win32") {
		const cmdWrapper = path.join(dir, "mock-agy.cmd");
		fs.writeFileSync(cmdWrapper, `@node "${scriptPath}" %*\r\n`);
		return cmdWrapper;
	}
	return scriptPath;
}

const TEST_MODEL: Model<"antigravity-acp"> = {
	id: "gemini-4-neon",
	name: "Gemini 4 Neon",
	api: "antigravity-acp",
	provider: "antigravity",
	baseUrl: "acp://antigravity-cli",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 512_000,
	maxTokens: 65_536,
};

function createStubPiApi(): ExtensionAPI {
	return {
		appendEntry() {},
		getSessionName() {
			return undefined;
		},
		setSessionName() {},
	} as unknown as ExtensionAPI;
}

describe("TurnCoordinator 双模式端到端协议闭环集成测试", () => {
	it("无 UI 或审批取消时返回明确错误，有效授权仍按 ACP 下发", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-permission-"));
		const config = { ...DEFAULT_BRIDGE_CONFIG, agyBin: writeMockAgyExecutable(root), geminiDir: path.join(root, ".gemini") };
		const broker = new AgyTurnMirrorBroker();
		const coordinator = new TurnCoordinator(createStubPiApi(), new AcpProcessManager(), broker, config);
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
		let choice: string | undefined;
		let timestamp = 0;
		// Thin client: every attempt is a new prompt typed by the human.
		const run = (id: string) => {
			const message: UserMessage = { role: "user", content: "TEST_TOOL_APPROVAL", timestamp: ++timestamp };
			typedByHuman(coordinator.humanPromptGate, message);
			return coordinator.streamSimple(TEST_MODEL, normalizeContext({ messages: [message], tools }), { sessionId: id }).result();
		};
		try {
			const baseContext = { cwd: root, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "approval" } };
			coordinator.setActiveContext({ ...baseContext, hasUI: false } as unknown as ExtensionContext);
			const headless = await run("headless");
			assert.equal(headless.stopReason, "error");
			// Thin client: headless use is refused before agy sees the request.
			assert.match(headless.errorMessage ?? "", /refusing headless use/);

			coordinator.setActiveContext({
				...baseContext, hasUI: true, ui: { select: async () => choice, setStatus() {} },
			} as unknown as ExtensionContext);
			for (const value of ["Deny", "invalid-choice", undefined]) {
				choice = value;
				const declined = await run(`declined-${value}`);
				assert.equal(declined.stopReason, "error");
				assert.match(declined.errorMessage ?? "", /Tool not approved/);
			}
			choice = "Allow";
			const approved = await run("approved");
			assert.equal(approved.stopReason, "stop");
			assert.equal(approved.content.find(block => block.type === "text")?.text, "APPROVED");
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("后端确认新会话但 SQLite 建表失败时，先重建再发送一次用户请求", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-incomplete-schema-"));
		const config = {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: writeMockAgyExecutable(root, { seedTemplateDbOnNew: true, incompleteFirstDb: true }),
			geminiDir: path.join(root, ".gemini"),
		};
		const broker = new AgyTurnMirrorBroker();
		const coordinator = new TurnCoordinator(createStubPiApi(), new AcpProcessManager(), broker, config);
		coordinator.setActiveContext(interactiveContext(root));
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
		const prompts: unknown[] = [];
		try {
			const user: UserMessage = { role: "user", content: "FOLLOWUP_MSG:首条问题", timestamp: 1 };
			typedByHuman(coordinator.humanPromptGate, user);
			const result = await coordinator.streamSimple(TEST_MODEL, normalizeContext({
				messages: [user], tools,
			}), { onPayload: payload => { prompts.push(payload); } }).result();
			const firstId = fs.readFileSync(path.join(root, "incomplete-session-id"), "utf8");
			assert.equal(result.stopReason, "stop");
			assert.notEqual(result.responseId, firstId);
			assert.equal(prompts.length, 1);
			assert.match(JSON.stringify(prompts[0]), /首条问题/);
			const convDir = path.join(config.geminiDir, config.appDataDirName, "conversations");
			assert.equal(fs.readdirSync(convDir).filter(name => name.endsWith(".db")).length, 2);
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("从旧分支恢复时按锚点截断已继续写入的轨迹，保留原轨迹", { skip: THIN_CLIENT_DISABLED }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-advanced-anchor-"));
		const config = {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: writeMockAgyExecutable(root, { seedTemplateDbOnNew: true }),
			geminiDir: path.join(root, ".gemini"),
		};
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const pi = createStubPiApi();
		pi.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data });
		const coordinator = new TurnCoordinator(pi, new AcpProcessManager(), new AgyTurnMirrorBroker(), config);
		const sessionId = "advanced-anchor";
		coordinator.setActiveContext({
			cwd: root, isProjectTrusted: () => false, hasUI: false,
			sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
		} as unknown as ExtensionContext);
		try {
			const user = { role: "user" as const, content: "TRIGGER_UPSTREAM_BATCH", timestamp: 1 };
			const first = await coordinator.streamSimple(TEST_MODEL, normalizeContext({ messages: [user] }), { sessionId }).result();
			assert.equal(first.stopReason, "stop");
			await coordinator.persistTurnAnchor([user, first], sessionId);
			assert.equal(entries.length, 1);
			await coordinator.invalidatePiSession(sessionId);

			const openConversation = (id: string, readOnly = true) => new DatabaseSync(
				path.join(config.geminiDir, config.appDataDirName, "conversations", id + ".db"), { readOnly },
			);
			const prior = [user, first];
			const resume = (prompt: string, onPayload?: (payload: unknown) => void) => coordinator.streamSimple(
				TEST_MODEL, normalizeContext({ messages: [...prior, { role: "user", content: prompt, timestamp: 2 }] }),
				{ sessionId, onPayload },
			).result();
			const unchanged = await resume("FOLLOWUP_MSG:锚点未变化");
			assert.equal(unchanged.responseId, first.responseId, "未前进的会话仍应原地恢复");
			await coordinator.invalidatePiSession(sessionId);

			const original = openConversation(first.responseId!, false);
			try {
				original.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (2, 14, 3, ?)")
					.run(Buffer.from("OTHER_BRANCH_ONLY"));
				original.exec("INSERT INTO gen_metadata (idx, data) SELECT 2, data FROM gen_metadata WHERE idx = 1");
			} finally { original.close(); }

			let prompt: unknown;
			const branched = await resume("FOLLOWUP_MSG:从旧节点另起分支", payload => { prompt = payload; });
			assert.equal(branched.stopReason, "stop");
			assert.notEqual(branched.responseId, first.responseId, "原地恢复会把另一分支的步骤也交给模型");
			assert.deepEqual((prompt as { prompt: unknown }).prompt, [{ type: "text", text: "FOLLOWUP_MSG:从旧节点另起分支" }]);

			for (const [id, expected] of [[first.responseId!, 2], [branched.responseId!, 1]] as const) {
				const db = openConversation(id);
				try {
					assert.equal(db.prepare("SELECT MAX(idx) AS idx FROM steps").get()?.idx, expected);
					assert.equal(db.prepare("SELECT MAX(idx) AS idx FROM gen_metadata").get()?.idx, expected);
				} finally { db.close(); }
			}
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("恢复存在元数据但没有持久化步骤的空壳会话时重放 Pi 历史", { skip: THIN_CLIENT_DISABLED }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-empty-resume-"));
		const config = {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: writeMockAgyExecutable(root, { seedTemplateDbOnNew: true }),
			geminiDir: path.join(root, ".gemini"),
		};
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const pi = createStubPiApi();
		pi.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data });
		const coordinator = new TurnCoordinator(pi, new AcpProcessManager(), new AgyTurnMirrorBroker(), config);
		const sessionId = "empty-resume";
		coordinator.setActiveContext({
			cwd: root, isProjectTrusted: () => false, hasUI: false,
			sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
		} as unknown as ExtensionContext);
		try {
			const firstUser = { role: "user" as const, content: "FOLLOWUP_MSG:此前的问题", timestamp: 1 };
			const first = await coordinator.streamSimple(TEST_MODEL, normalizeContext({ messages: [firstUser] }), { sessionId }).result();
			assert.equal(first.stopReason, "stop");
			await coordinator.persistTurnAnchor([firstUser, first], sessionId);
			assert.equal(entries.length, 1);
			await coordinator.invalidatePiSession(sessionId);

			let replayText = "";
			const next = await coordinator.streamSimple(TEST_MODEL, normalizeContext({ messages: [
				firstUser, first, { role: "user", content: "FOLLOWUP_MSG:下一个问题", timestamp: 2 },
			] }), { sessionId, onPayload: payload => { replayText = JSON.stringify(payload); } }).result();
			assert.equal(next.stopReason, "stop");
			assert.notEqual(next.responseId, first.responseId);
			assert.match(replayText, /此前的问题/);
			assert.match(replayText, /下一个问题/);
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("thin client: a restored agy session without persisted steps refuses to replay Pi's history", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-thin-empty-resume-"));
		const config = {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: writeMockAgyExecutable(root, { seedTemplateDbOnNew: true }),
			geminiDir: path.join(root, ".gemini"),
		};
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const pi = createStubPiApi();
		pi.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data });
		const broker = new AgyTurnMirrorBroker();
		const coordinator = new TurnCoordinator(pi, new AcpProcessManager(), broker, config);
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
		const sessionId = "thin-empty-resume";
		coordinator.setActiveContext(interactiveContext(root, {
			sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
		}));
		try {
			const firstUser: UserMessage = { role: "user", content: "FOLLOWUP_MSG:earlier question", timestamp: 1 };
			typedByHuman(coordinator.humanPromptGate, firstUser);
			const first = await coordinator.streamSimple(TEST_MODEL, normalizeContext({ messages: [firstUser], tools }), { sessionId }).result();
			assert.equal(first.stopReason, "stop");
			await coordinator.persistTurnAnchor([firstUser, first], sessionId);
			assert.equal(entries.length, 1);
			await coordinator.invalidatePiSession(sessionId);

			const sent: string[] = [];
			const nextUser: UserMessage = { role: "user", content: "FOLLOWUP_MSG:next question", timestamp: 2 };
			typedByHuman(coordinator.humanPromptGate, nextUser);
			const next = await coordinator.streamSimple(TEST_MODEL, normalizeContext({
				messages: [firstUser, first, nextUser], tools,
			}), { sessionId, onPayload: (payload) => { sent.push(JSON.stringify(payload)); } }).result();
			assert.equal(next.stopReason, "error");
			assert.match(next.errorMessage ?? "", /refusing to replay earlier conversation/);
			assert.equal(sent.length, 0, "no prompt may reach agy when the history would have to be replayed");
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("模式 B (pi-tools)：完成 HTTP MCP Park-and-Yield 挂起、宿主工具执行与同轮续接", { skip: THIN_CLIENT_DISABLED }, async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-b-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};

		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);

		try {
			const tools = [
				{
					name: "read",
					description: "Read file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			];

			// 第 1 步：发送用户请求，预期收到思考块 + read 工具调用并以 toolUse 结束
			const ctx1 = normalizeContext({
				systemPrompt: "You are Pi.",
				tools,
				messages: [{ role: "user", content: "Inspect package.json", timestamp: 1 }],
			});

			const stream1 = coord.streamSimple(TEST_MODEL, ctx1, {
				sessionId: "pi-sess-b",
				reasoning: "high",
			});
			const eventsStep1: AssistantMessageEvent[] = [];
			for await (const ev of stream1) {
				eventsStep1.push(ev);
			}
			const msg1 = await stream1.result();

			assert.equal(msg1.stopReason, "toolUse");
			const toolCall = msg1.content.find((c): c is ToolCall => c.type === "toolCall");
			assert.ok(toolCall);
			assert.equal(toolCall.name, "read");
			assert.deepEqual(toolCall.arguments, { path: "package.json" });
			// 验证所有流式事件中只存在唯一稳定的 toolCall.id（无空参数占位幽灵卡片），且流式采样数 >= 2
			const seenToolIds = new Set<string>();
			let totalDeltas = 0;
			for (const ev of eventsStep1) {
				if (
					ev.type === "thinking_delta" ||
					ev.type === "text_delta" ||
					ev.type === "toolcall_delta"
				) {
					totalDeltas++;
				}
				if ("partial" in ev) {
					for (const b of ev.partial.content) {
						if (b.type === "toolCall") {
							seenToolIds.add(b.id);
							assert.deepEqual(b.arguments, { path: "package.json" });
						}
					}
				}
			}
			assert.equal(seenToolIds.size, 1);
			assert.ok(totalDeltas >= 2);
			assert.ok(msg1.usage.output > 0);
			assert.equal(msg1.usage.totalTokens, 40000);

			// 第 2 步：模拟 Pi Agent Loop 执行完 read 工具并返回结果，预期无缝恢复同一 ACP Turn
			const ctx2 = normalizeContext({
				systemPrompt: "You are Pi.",
				tools,
				messages: [
					{ role: "user", content: "Inspect package.json", timestamp: 1 },
					msg1,
					{
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: "read",
						content: [{ type: "text", text: '{"name":"demo"}' }],
						isError: false,
						timestamp: 2,
					},
				],
			});

			const stream2 = coord.streamSimple(TEST_MODEL, ctx2, {
				sessionId: "pi-sess-b",
				reasoning: "high",
			});
			const msg2 = await stream2.result();

			assert.equal(msg2.stopReason, "stop");
			const finalText = msg2.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.equal(finalText, 'File read OK: {"name":"demo"}');
			// 最终消息总窗口严格对齐当前真实窗口 50000（避免两步累加值 90080 虚高），同时保留缓存命中拆分
			assert.equal(msg2.usage.totalTokens, 50000);
			assert.ok(msg2.usage.cacheRead > 35000);
			assert.ok(msg2.usage.output > 0);
			assert.equal(TEST_MODEL.contextWindow, 1048576);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("模式 A (agy-tools)：完成单 Turn 流分片、镜像工具 agy_edit、权限弹窗审批与 Diff 同步", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-a-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};

		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);
		const mirrorTools = createAgyMirrorToolDefinitions(broker);

		let permissionPromptShown = false;
		const stubUiCtx = {
			hasUI: true,
			cwd: tmpRoot,
			ui: {
				async select(_title: string, options: string[]) {
					permissionPromptShown = true;
					return options[0]; // 选择 Allow once
				},
				setStatus() {},
			},
		} as unknown as ExtensionContext;
		coord.setActiveContext(stubUiCtx);
		typedByHuman(coord.humanPromptGate, { role: "user", content: "Update src/app.ts", timestamp: 1 });

		try {
			// 第 1 步：启动流，预期在原生 tool_call 处自动分片，产出 agy_edit 工具调用
			// Pi's agent loop declares the active mirror tools in agy-tools mode.
			const declaredMirrorTools = mirrorTools.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			}));
			const ctx1 = normalizeContext({
				messages: [{ role: "user", content: "Update src/app.ts", timestamp: 1 }],
				tools: declaredMirrorTools,
			});
			const stream1 = coord.streamSimple(TEST_MODEL, ctx1, { sessionId: "pi-sess-a" });
			const events1: AssistantMessageEvent[] = [];
			for await (const ev of stream1) {
				events1.push(ev);
			}
			const msg1 = await stream1.result();

			assert.equal(msg1.stopReason, "toolUse");
			const mirrorCall = msg1.content.find((c): c is ToolCall => c.type === "toolCall");
			assert.ok(mirrorCall);
			assert.equal(mirrorCall.name, "agy_edit");
			assert.equal(mirrorCall.arguments.path, "src/app.ts");

			// 执行镜像工具：内部应消费权限请求弹窗并等待 tool_call_update(completed) 返回 Diff
			const editTool = mirrorTools.find((t) => t.name === "agy_edit")!;
			const mirrorResult = await editTool.execute(
				mirrorCall.id,
				mirrorCall.arguments,
				undefined,
				undefined,
				stubUiCtx as never,
			);

			assert.equal(permissionPromptShown, true);
			assert.equal(mirrorResult.details?.diffs?.length, 1);
			assert.equal(mirrorResult.details?.diffs?.[0].newText, "const a = 2;");

			// 第 2 步：自动续接同一后台 ACP Turn 的剩余正文输出
			const ctx2 = normalizeContext({
				messages: [
					{ role: "user", content: "Update src/app.ts", timestamp: 1 },
					msg1,
					{
						role: "toolResult",
						toolCallId: mirrorCall.id,
						toolName: "agy_edit",
						content: mirrorResult.content,
						isError: false,
						timestamp: 2,
					},
				],
				tools: declaredMirrorTools,
			});
			const stream2 = coord.streamSimple(TEST_MODEL, ctx2, { sessionId: "pi-sess-a" });
			const msg2 = await stream2.result();

			assert.equal(msg2.stopReason, "stop");
			const text2 = msg2.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.equal(text2, "Native edit done!");
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("按下 Esc (signal.abort) 时即使后端 session/cancel 无响应也在 30ms 内瞬时结束流", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-esc-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};

		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);
		// Thin-client fork: only interactive sessions with declared mirror tools are served.
		coord.setActiveContext({
			hasUI: true,
			cwd: tmpRoot,
			ui: { setStatus() {} },
		} as unknown as ExtensionContext);
		const declaredMirrorTools = createAgyMirrorToolDefinitions(broker).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));

		typedByHuman(coord.humanPromptGate, { role: "user", content: "HANG_FOREVER", timestamp: 1 });

		try {
			const ac = new AbortController();
			const ctx = normalizeContext({
				messages: [{ role: "user", content: "HANG_FOREVER", timestamp: 1 }],
				tools: declaredMirrorTools,
			});
			const stream = coord.streamSimple(TEST_MODEL, ctx, {
				sessionId: "pi-sess-esc",
				signal: ac.signal,
			});

			// 确定性等待首个思考分片到达（证明请求已真正进入 mock-agy 挂起态，消除云端慢机器固定 sleep 竞态）
			let t0 = 0;
			for await (const ev of stream) {
				if (ev.type === "thinking_delta") {
					t0 = Date.now();
					ac.abort();
					break;
				}
			}
			const abortedMsg = await stream.result();
			const elapsed = Date.now() - t0;

			assert.equal(abortedMsg.stopReason, "aborted");
			assert.ok(elapsed < 50, `Esc 中断耗时应小于 50ms，实际耗时 ${elapsed}ms`);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("thin client: sends agy exactly the typed text, without Pi's system prompt, rules or tools", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-wire-"));
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: writeMockAgyExecutable(tmpRoot),
			geminiDir: path.join(tmpRoot, ".gemini"),
		};
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), new AcpProcessManager(), broker, cfg);
		coord.setActiveContext(interactiveContext(tmpRoot));
		const mirror = createAgyMirrorToolDefinitions(broker).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
		const tools = [...mirror, { name: "mcp__github__search_code", description: "PI_TOOL_MARKER", parameters: mirror[0].parameters }];
		const sent: unknown[] = [];
		try {
			const typed: UserMessage = { role: "user", content: "FOLLOWUP_MSG:hello agy", timestamp: 1 };
			typedByHuman(coord.humanPromptGate, typed);
			const result = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({ systemPrompt: "PI_SYSTEM_PROMPT_MARKER\nAGENTS.md: PI_RULES_MARKER", messages: [typed], tools }),
					{ sessionId: "pi-sess-wire", onPayload: (payload) => { sent.push(payload); return undefined; } },
				)
				.result();
			assert.equal(result.stopReason, "stop");
			assert.equal(sent.length, 1);
			const payload = sent[0];
			assert.ok(payload && typeof payload === "object" && "prompt" in payload);
			assert.deepEqual(payload.prompt, [{ type: "text", text: "FOLLOWUP_MSG:hello agy" }]);
			assert.doesNotMatch(JSON.stringify(payload), /PI_SYSTEM_PROMPT_MARKER|PI_RULES_MARKER|PI_TOOL_MARKER|workspace_context/);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("thin client: sends a typed prompt once and refuses Pi's automatic retry and automated prompts", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-gate-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};
		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);
		coord.setActiveContext(interactiveContext(tmpRoot));
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
		const sentPrompts: unknown[] = [];
		const run = (messages: Message[]) =>
			coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages, tools }), {
					sessionId: "pi-sess-gate",
					onPayload: (payload) => {
						sentPrompts.push(payload);
						return undefined;
					},
				})
				.result();

		try {
			const typed: UserMessage = { role: "user", content: "QUOTA_EXHAUSTED_429", timestamp: 1 };
			typedByHuman(coord.humanPromptGate, typed);

			const first = await run([typed]);
			assert.equal(first.stopReason, "error");
			assert.match(first.errorMessage ?? "", /quota exceeded \(429\)/);
			assert.equal(isRetryableAssistantError(first), false, "Pi must not schedule a retry on an empty quota");
			assert.equal(sentPrompts.length, 1);

			// Pi's retry drops the failed attempt and asks again with the same context.
			const retry = await run([typed]);
			assert.equal(retry.stopReason, "error");
			assert.match(retry.errorMessage ?? "", /refusing to send the same prompt again/);
			assert.equal(isRetryableAssistantError(retry), false);
			assert.equal(sentPrompts.length, 1, "a retry must not reach agy");

			// A goal continuation or extension message has no typed input behind it.
			const automated: UserMessage = { role: "user", content: "Continue the goal.", timestamp: 2 };
			coord.humanPromptGate.noteInput("extension", "Continue the goal.");
			coord.humanPromptGate.noteUserMessage(automated);
			const auto = await run([typed, retry, automated]);
			assert.equal(auto.stopReason, "error");
			assert.match(auto.errorMessage ?? "", /refusing a message you did not type/);
			assert.equal(isRetryableAssistantError(auto), false);
			assert.equal(sentPrompts.length, 1, "an automated prompt must not reach agy");
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("thin client: a message typed during an agy turn waits for the turn instead of cancelling it", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-steer-a-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};
		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);
		const notes: string[] = [];
		const ctx = interactiveToolContext(tmpRoot);
		ctx.ui.select = async (_title: string, options: string[]) => options[0];
		ctx.ui.notify = (message: string) => {
			notes.push(message);
		};
		coord.setActiveContext(ctx);
		const mirrorTools = createAgyMirrorToolDefinitions(broker);
		const tools = mirrorTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

		try {
			const first: UserMessage = { role: "user", content: "Update src/app.ts", timestamp: 1 };
			typedByHuman(coord.humanPromptGate, first);
			const msg1 = await coord.streamSimple(TEST_MODEL, normalizeContext({ messages: [first], tools }), { sessionId: "pi-sess-steer-a" }).result();
			assert.equal(msg1.stopReason, "toolUse");
			const call = msg1.content.find((c): c is ToolCall => c.type === "toolCall");
			assert.ok(call);
			const editTool = mirrorTools.find((t) => t.name === "agy_edit");
			assert.ok(editTool);
			const toolResult = await editTool.execute(call.id, call.arguments, undefined, undefined, ctx);

			// Pi delivers the steering message after the tool result.
			const steer: UserMessage = { role: "user", content: "STEER_REPLY", timestamp: 3 };
			typedByHuman(coord.humanPromptGate, steer);
			const msg2 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						messages: [
							first,
							msg1,
							{ role: "toolResult", toolCallId: call.id, toolName: "agy_edit", content: toolResult.content, isError: false, timestamp: 2 },
							steer,
						],
						tools,
					}),
					{ sessionId: "pi-sess-steer-a" },
				)
				.result();

			assert.equal(msg2.stopReason, "stop");
			const text = msg2.content.filter((c) => c.type === "text").map((c) => c.text).join("");
			assert.equal(text, "Native edit done!\n\nSteer handled.");
			const calls = fs
				.readFileSync(path.join(tmpRoot, "mock-calls.log"), "utf8")
				.trim()
				.split("\n")
				.map((line): unknown => JSON.parse(line));
			const methods = calls.map((c) => (c && typeof c === "object" && "method" in c ? c.method : undefined));
			assert.equal(methods.includes("session/cancel"), false, "steering must not cancel agy's turn");
			const prompts = calls.filter((c) => c && typeof c === "object" && "method" in c && c.method === "session/prompt");
			assert.deepEqual(
				prompts.map((c) => (c && typeof c === "object" && "text" in c ? c.text : undefined)),
				["Update src/app.ts", "STEER_REPLY"],
			);
			assert.equal(notes.length, 1);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("names the parent's model and reasoning level on a self subagent's tool card", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-spawn-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};
		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);
		coord.setActiveContext(interactiveContext(tmpRoot));
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
		try {
			const prompt: UserMessage = { role: "user", content: "SPAWN_SELF_SUBAGENT", timestamp: 1 };
			typedByHuman(coord.humanPromptGate, prompt);
			const msg = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ messages: [prompt], tools }), { sessionId: "pi-sess-spawn", reasoning: "high" })
				.result();
			assert.equal(msg.stopReason, "toolUse");
			const call = msg.content.find((c): c is ToolCall => c.type === "toolCall");
			assert.ok(call);
			assert.equal(call.name, "agy_subagent");
			assert.equal(call.arguments.agentRole, "File Creator Subagent");
			assert.equal(call.arguments.agentType, "self");
			assert.equal(typeof call.arguments.parentModel, "string");
			assert.match(String(call.arguments.parentModel), /^gemini-4-neon(-[a-z]+)?$/);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("thin client: hands agy's updates outside a Pi turn to the display without registering mirror calls", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-wake-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};
		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);
		coord.setActiveContext(interactiveContext(tmpRoot));
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
		const seen: string[] = [];
		coord.setOutOfTurnListener((_agySessionId, update) => {
			seen.push(update.sessionUpdate);
		});

		try {
			const prompt: UserMessage = { role: "user", content: "WAKE_LATER", timestamp: 1 };
			typedByHuman(coord.humanPromptGate, prompt);
			const msg = await coord.streamSimple(TEST_MODEL, normalizeContext({ messages: [prompt], tools }), { sessionId: "pi-sess-wake" }).result();
			assert.equal(msg.stopReason, "stop");
			for (let i = 0; i < 50 && seen.length < 3; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}
			assert.deepEqual(seen, ["tool_call", "tool_call_update", "agent_message_chunk"]);
			assert.equal(broker.isTracking("auto_1"), false);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("运行中插入用户消息 (Steering) 不中断当前多步任务、未观测缓存前不伪造命中且后续追问正常吐字", { skip: THIN_CLIENT_DISABLED }, async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-steer-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};

		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);

		try {
			const tools = [
				{
					name: "read",
					description: "Read file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			];

			// Step 1：触发多步读取任务，返回第 1 个工具调用 a.ts
			const u0 = { role: "user" as const, content: "MULTI_STEP_WITH_STEER", timestamp: 1 };
			const ctx1 = normalizeContext({ systemPrompt: "You are Pi.", tools, messages: [u0] });
			const msg1 = await coord.streamSimple(TEST_MODEL, ctx1, { sessionId: "pi-sess-steer" }).result();
			assert.equal(msg1.stopReason, "toolUse");
			const tc1 = msg1.content.find((c): c is ToolCall => c.type === "toolCall")!;
			assert.equal(tc1.arguments.path, "a.ts");

			// Step 2：在 a.ts 工具结果之后夹带用户在运行中按 Enter 发送的转向消息
			const tr1 = {
				role: "toolResult" as const,
				toolCallId: tc1.id,
				toolName: "read",
				content: [{ type: "text" as const, text: "export const a = 1;" }],
				isError: false,
				timestamp: 2,
			};
			const uSteer = {
				role: "user" as const,
				content: "顺便检查缓存显示",
				timestamp: 3,
			};
			const ctx2 = normalizeContext({
				systemPrompt: "You are Pi.",
				tools,
				messages: [u0, msg1, tr1, uSteer],
			});
			const msg2 = await coord.streamSimple(TEST_MODEL, ctx2, { sessionId: "pi-sess-steer" }).result();

			// 关键断言 1：原任务绝不提前终止，继续产出第 2 步工具调用 b.ts！
			assert.equal(msg2.stopReason, "toolUse");
			const tc2 = msg2.content.find((c): c is ToolCall => c.type === "toolCall")!;
			assert.equal(tc2.arguments.path, "b.ts");
			// 关键断言 2：在无 SQLite 库且本会话尚未观测到任何上游缓存信号前，绝不硬编码伪造 85% 假缓存命中
			assert.equal(
				msg2.usage.cacheRead,
				0,
				`未观测到任何上游缓存信号时不应伪造 cacheRead，实际为 ${msg2.usage.cacheRead}`,
			);

			// Step 3：完成 b.ts 工具执行，收口整轮输出（包含原任务结果与运行中消息响应）
			const tr2 = {
				role: "toolResult" as const,
				toolCallId: tc2.id,
				toolName: "read",
				content: [{ type: "text" as const, text: "export const b = 2;" }],
				isError: false,
				timestamp: 4,
			};
			const ctx3 = normalizeContext({
				systemPrompt: "You are Pi.",
				tools,
				messages: [u0, msg1, tr1, uSteer, msg2, tr2],
			});
			const msg3 = await coord.streamSimple(TEST_MODEL, ctx3, { sessionId: "pi-sess-steer" }).result();
			assert.equal(msg3.stopReason, "stop");
			const text3 = msg3.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.equal(text3, "Both done! A=export const a = 1; B=export const b = 2;\n\nSteerAnswered=true");

			// Step 4：继续发送下一条普通用户消息，验证复用同一会话且正常流式吐字（绝不挂死）
			const uFollow = {
				role: "user" as const,
				content: "FOLLOWUP_MSG:下一条指令",
				timestamp: 5,
			};
			const ctx4 = normalizeContext({
				systemPrompt: "You are Pi.",
				tools,
				messages: [u0, msg1, tr1, uSteer, msg2, tr2, msg3, uFollow],
			});
			const msg4 = await coord.streamSimple(TEST_MODEL, ctx4, { sessionId: "pi-sess-steer" }).result();
			assert.equal(msg4.stopReason, "stop");
			const text4 = msg4.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.equal(text4, "Echo -> FOLLOWUP_MSG:下一条指令");
			assert.equal(msg4.responseId, msg1.responseId);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("后端主动取消主请求时结束为 aborted，ACP 回退记为 499，随后仍可续聊", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-backend-cancelled-"));
		const config = { ...DEFAULT_BRIDGE_CONFIG, agyBin: writeMockAgyExecutable(root), geminiDir: path.join(root, ".gemini") };
		const broker = new AgyTurnMirrorBroker();
		const coordinator = new TurnCoordinator(createStubPiApi(), new AcpProcessManager(), broker, config);
		coordinator.setActiveContext(interactiveContext(root));
		const tools = createAgyMirrorToolDefinitions(broker).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
		const sessionId = "backend-cancelled";
		try {
			const user: UserMessage = { role: "user", content: "AGY_STOP_CANCELLED", timestamp: 1 };
			typedByHuman(coordinator.humanPromptGate, user);
			const responses: number[] = [];
			const cancelled = await coordinator.streamSimple(TEST_MODEL, normalizeContext({ messages: [user], tools }), {
				sessionId,
				onResponse: ({ status }) => { responses.push(status); },
			}).result();
			assert.equal(cancelled.stopReason, "aborted");
			assert.deepEqual(responses, [200, 499]);

			const followUp: UserMessage = { role: "user", content: "FOLLOWUP_MSG:继续", timestamp: 2 };
			typedByHuman(coordinator.humanPromptGate, followUp);
			const next = await coordinator.streamSimple(TEST_MODEL, normalizeContext({ messages: [
				user, cancelled, followUp,
			], tools }), { sessionId }).result();
			assert.equal(next.stopReason, "stop");
			assert.equal(next.responseId, cancelled.responseId);
			assert.equal(next.content.find(block => block.type === "text")?.text, "Echo -> FOLLOWUP_MSG:继续");
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("首条重放提示发送前被取消，续聊仍重放历史", { skip: THIN_CLIENT_DISABLED }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-cancel-before-replay-"));
		const config = { ...DEFAULT_BRIDGE_CONFIG, agyBin: writeMockAgyExecutable(root), geminiDir: path.join(root, ".gemini") };
		const coordinator = new TurnCoordinator(createStubPiApi(), new AcpProcessManager(), new AgyTurnMirrorBroker(), config);
		const sessionId = "cancel-before-replay";
		try {
			const firstUser = { role: "user" as const, content: "FOLLOWUP_MSG:历史中的内容", timestamp: 1 };
			const first = await coordinator.streamSimple(TEST_MODEL, normalizeContext({ messages: [firstUser] }), { sessionId }).result();
			assert.equal(first.stopReason, "stop");
			await coordinator.invalidatePiSession(sessionId);

			const interrupted = { role: "user" as const, content: "FOLLOWUP_MSG:取消这次发送", timestamp: 2 };
			const cancel = new AbortController();
			const cancelledContents = [firstUser, first, interrupted];
			let cancelledPayload: unknown;
			const accepted: number[] = [];
			const aborted = await coordinator.streamSimple(TEST_MODEL, normalizeContext({ messages: cancelledContents }), {
				sessionId,
				signal: cancel.signal,
				onPayload: payload => {
					cancelledPayload = payload;
					cancel.abort();
				},
				onResponse: ({ status }) => { accepted.push(status); },
			}).result();
			assert.equal(aborted.stopReason, "aborted");
			assert.match(JSON.stringify(cancelledPayload), /历史中的内容/);
			assert.deepEqual(accepted, [], "取消发生在首条 ACP prompt 发送前");

			let replay: unknown;
			const next = await coordinator.streamSimple(TEST_MODEL, normalizeContext({ messages: [
				...cancelledContents, aborted, { role: "user", content: "FOLLOWUP_MSG:继续新问题", timestamp: 3 },
			] }), { sessionId, onPayload: payload => { replay = payload; } }).result();
			assert.equal(next.stopReason, "stop");
			assert.match(JSON.stringify(replay), /历史中的内容/);
			assert.match(JSON.stringify(replay), /继续新问题/);
		} finally {
			await coordinator.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("按下 Esc 取消运行中轮次后立即发送新消息仍能正常流式输出（不卡死）", { skip: THIN_CLIENT_DISABLED }, async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-cancel-next-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};

		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);

		try {
			const ac = new AbortController();
			const u1 = { role: "user" as const, content: "CANCEL_RESPONSIVE", timestamp: 1 };
			const ctx1 = normalizeContext({ messages: [u1] });
			const stream1 = coord.streamSimple(TEST_MODEL, ctx1, {
				sessionId: "pi-sess-cancel-next",
				signal: ac.signal,
			});

			for await (const ev of stream1) {
				if (ev.type === "text_delta") {
					ac.abort();
					break;
				}
			}
			const abortedMsg = await stream1.result();
			assert.equal(abortedMsg.stopReason, "aborted");

			// 模拟 Pi 在 turn_end 记录完结快照后用户立即发送下一条消息
			await coord.persistTurnAnchor([u1, abortedMsg], "pi-sess-cancel-next");

			const u2 = { role: "user" as const, content: "FOLLOWUP_MSG:取消后立刻重发", timestamp: 2 };
			const ctx2 = normalizeContext({ messages: [u1, abortedMsg, u2] });
			const msg2 = await coord
				.streamSimple(TEST_MODEL, ctx2, { sessionId: "pi-sess-cancel-next" })
				.result();
			assert.equal(msg2.stopReason, "stop");
			const text2 = msg2.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.equal(text2, "Echo -> FOLLOWUP_MSG:取消后立刻重发");
			// 中断后立即重发必须复用原热缓存会话，绝不重建丢缓存
			assert.equal(msg2.responseId, abortedMsg.responseId);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("同次生成拆分多工具不重复累加 cacheRead、末步不倒灌累计 output 余量且 aborted 轮次绝不写入损坏锚点", { skip: THIN_CLIENT_DISABLED }, async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-telemetry-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};

		const appendedEntries: Array<{ type: string; data: unknown }> = [];
		const trackingPi = {
			appendEntry(type: string, data: unknown) {
				appendedEntries.push({ type, data });
			},
			getSessionName() {
				return undefined;
			},
			setSessionName() {},
		} as unknown as ExtensionAPI;

		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(trackingPi, pm, broker, cfg);

		try {
			const tools = [
				{
					name: "read",
					description: "Read file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			];

			const u1 = { role: "user" as const, content: "SAME_GEN_DUAL_SEQ_TOOLS", timestamp: 1 };
			const step1 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: [u1] }), {
					sessionId: "pi-sess-tel",
				})
				.result();
			const tc1 = step1.content.find((c): c is ToolCall => c.type === "toolCall")!;
			assert.equal(step1.usage.totalTokens, 50000);

			const tr1 = {
				role: "toolResult" as const,
				toolCallId: tc1.id,
				toolName: "read",
				content: [{ type: "text" as const, text: "file-1" }],
				isError: false,
				timestamp: 2,
			};
			const step2 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: [u1, step1, tr1] }), {
					sessionId: "pi-sess-tel",
				})
				.result();
			const tc2 = step2.content.find((c): c is ToolCall => c.type === "toolCall")!;
			// 同一次生成拆出的第 2 个工具调用必须返回全零 Usage，杜绝 2x/3x cacheRead 虚高
			assert.equal(step2.usage.totalTokens, 0);
			assert.equal(step2.usage.cacheRead, 0);

			const tr2 = {
				role: "toolResult" as const,
				toolCallId: tc2.id,
				toolName: "read",
				content: [{ type: "text" as const, text: "file-2" }],
				isError: false,
				timestamp: 3,
			};
			const step3 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({ tools, messages: [u1, step1, tr1, step2, tr2] }),
					{ sessionId: "pi-sess-tel" },
				)
				.result();
			assert.equal(step3.stopReason, "stop");
			// 末步绝不把整轮累计 outputTokens (8000) 倒灌进仅十余字符的最终回复，且总窗口严格等于 54000
			assert.ok(step3.usage.output < 100, `末步 output 不应倒灌累计余量，实际为 ${step3.usage.output}`);
			assert.equal(step3.usage.totalTokens, 54000);

			// 正常完结轮次可写入 1 条锚点
			await coord.persistTurnAnchor([u1, step1, tr1, step2, tr2, step3], "pi-sess-tel");
			assert.equal(appendedEntries.length, 1);

			// 按下 Esc 产生的 aborted 消息传入 persistTurnAnchor 时必须严格拦截，绝不追加损坏锚点
			const fakeAborted = { ...step3, stopReason: "aborted" as const };
			await coord.persistTurnAnchor([u1, step1, tr1, step2, tr2, step3, fakeAborted], "pi-sess-tel");
			assert.equal(appendedEntries.length, 1);

			// 验证在已建立缓存命中率记录后的第 2 轮中，同次生成拆分多工具时每一步均具备有效正提示词与稳定命中率（绝不变为 0 触发 UI 隐藏闪烁）
			const uWarm = { role: "user" as const, content: "SAME_GEN_DUAL_SEQ_TOOLS", timestamp: 4 };
			const wStep1 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({ tools, messages: [u1, step1, tr1, step2, tr2, step3, uWarm] }),
					{ sessionId: "pi-sess-tel" },
				)
				.result();
			const wTc1 = wStep1.content.find((c): c is ToolCall => c.type === "toolCall")!;
			const wPrompt1 = wStep1.usage.input + wStep1.usage.cacheRead;
			assert.ok(wPrompt1 > 0 && wStep1.usage.cacheRead > 0);

			const wTr1 = {
				role: "toolResult" as const,
				toolCallId: wTc1.id,
				toolName: "read",
				content: [{ type: "text" as const, text: "warm-1" }],
				isError: false,
				timestamp: 5,
			};
			const wStep2 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools,
						messages: [u1, step1, tr1, step2, tr2, step3, uWarm, wStep1, wTr1],
					}),
					{ sessionId: "pi-sess-tel" },
				)
				.result();
			const wTc2 = wStep2.content.find((c): c is ToolCall => c.type === "toolCall")!;
			const wPrompt2 = wStep2.usage.input + wStep2.usage.cacheRead;
			// 第 2 个拆分步既不重复累加 50000 窗口（<= 100），又保持 promptTokens > 0 且命中率与上一轮一致（约 96%）
			assert.ok(wPrompt2 > 0 && wPrompt2 <= 100);
			assert.ok(wStep2.usage.cacheRead >= 90);
			assert.equal(wStep2.usage.totalTokens, 50000);

			const wTr2 = {
				role: "toolResult" as const,
				toolCallId: wTc2.id,
				toolName: "read",
				content: [{ type: "text" as const, text: "warm-2" }],
				isError: false,
				timestamp: 6,
			};
			const wStep3 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools,
						messages: [u1, step1, tr1, step2, tr2, step3, uWarm, wStep1, wTr1, wStep2, wTr2],
					}),
					{ sessionId: "pi-sess-tel" },
				)
				.result();
			assert.equal(wStep3.stopReason, "stop");

			// 验证存在本地 SQLite steps 表时，单次生成内含 2 个顺序工具按整数守恒分摊：两步均显示 95.7% 命中率且总和 100% 精确守恒
			const agyId = step1.responseId!;
			const convDir = path.join(cfg.geminiDir, "antigravity-cli", "conversations");
			fs.mkdirSync(convDir, { recursive: true });
			const dbPath = path.join(convDir, `${agyId}.db`);
			const encodeVarint = (n: number): number[] => {
				const out: number[] = [];
				let v = n;
				while (v >= 0x80) {
					out.push((v & 0x7f) | 0x80);
					v = Math.floor(v / 128);
				}
				out.push(v);
				return out;
			};
			const f9Inner = Buffer.from([
				(2 << 3) | 0, ...encodeVarint(6000),   // inputTokens = 6000
				(3 << 3) | 0, ...encodeVarint(400),    // outputTokens = 400
				(5 << 3) | 0, ...encodeVarint(134000), // cacheReadTokens = 134000 (95.7%)
				(9 << 3) | 0, ...encodeVarint(150),    // thoughtTokens = 150
			]);
			const metaBlob = Buffer.from([(9 << 3) | 2, ...encodeVarint(f9Inner.length), ...f9Inner]);
			const tcSub = Buffer.from([(7 << 3) | 2, 2, 0x08, 0x01]);
			const f20Inner = Buffer.concat([tcSub, tcSub]); // plannedToolCalls = 2
			const payloadBlob = Buffer.from([
				...encodeVarint((20 << 3) | 2),
				...encodeVarint(f20Inner.length),
				...f20Inner,
			]);

			const db = new DatabaseSync(dbPath);
			db.exec("CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL, status integer NOT NULL, step_payload blob, metadata blob);");
			db.prepare("INSERT INTO steps VALUES (10, 15, 3, ?, ?)").run(payloadBlob, metaBlob);
			db.close();

			const uSql = { role: "user" as const, content: "SAME_GEN_DUAL_SEQ_TOOLS", timestamp: 7 };
			const historyBeforeSql = [u1, step1, tr1, step2, tr2, step3, uWarm, wStep1, wTr1, wStep2, wTr2, wStep3];
			const sqlS1 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: [...historyBeforeSql, uSql] }), {
					sessionId: "pi-sess-tel",
				})
				.result();
			const sqlTc1 = sqlS1.content.find((c): c is ToolCall => c.type === "toolCall")!;
			const sqlTr1 = {
				role: "toolResult" as const,
				toolCallId: sqlTc1.id,
				toolName: "read",
				content: [{ type: "text" as const, text: "sql-1" }],
				isError: false,
				timestamp: 8,
			};
			const sqlS2 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({ tools, messages: [...historyBeforeSql, uSql, sqlS1, sqlTr1] }),
					{ sessionId: "pi-sess-tel" },
				)
				.result();
			const sqlTc2 = sqlS2.content.find((c): c is ToolCall => c.type === "toolCall")!;

			// 第 1 步与第 2 步各自均具备正提示词与约 95.7% 命中率（绝不为 0），且两步整数之和 100% 精确等于 (6000, 134000, 400)！
			const rate1 = (sqlS1.usage.cacheRead / (sqlS1.usage.input + sqlS1.usage.cacheRead)) * 100;
			const rate2 = (sqlS2.usage.cacheRead / (sqlS2.usage.input + sqlS2.usage.cacheRead)) * 100;
			assert.ok(Math.abs(rate1 - 95.7) < 0.2, `第 1 步命中率应约为 95.7%，实际 ${rate1}`);
			assert.ok(Math.abs(rate2 - 95.7) < 0.2, `第 2 步命中率应约为 95.7%，实际 ${rate2}`);
			assert.equal(sqlS1.usage.input + sqlS2.usage.input, 6000);
			assert.equal(sqlS1.usage.cacheRead + sqlS2.usage.cacheRead, 134000);
			assert.equal(sqlS1.usage.output + sqlS2.usage.output, 400);

			const sqlTr2 = {
				role: "toolResult" as const,
				toolCallId: sqlTc2.id,
				toolName: "read",
				content: [{ type: "text" as const, text: "sql-2" }],
				isError: false,
				timestamp: 9,
			};
			const sqlS3 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools,
						messages: [...historyBeforeSql, uSql, sqlS1, sqlTr1, sqlS2, sqlTr2],
					}),
					{ sessionId: "pi-sess-tel" },
				)
				.result();
			assert.equal(sqlS3.stopReason, "stop");
			// 即使末步 SQLite WAL 未落盘新 step_type=15，也不能将末步归零导致缓存命中率消失
			const finalPromptTokens = sqlS3.usage.input + sqlS3.usage.cacheRead + sqlS3.usage.cacheWrite;
			assert.ok(finalPromptTokens > 0, "末步提示词不应归零导致状态栏缓存命中率消失");
			assert.ok(sqlS3.usage.output > 0, "末步输出 Token 不应归零");
			assert.ok(
				sqlS1.usage.reasoning === undefined || sqlS1.usage.output >= sqlS1.usage.reasoning,
				"切片后必须严格维持 output >= reasoning",
			);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("轮次中修改 AGENTS.md 不触发死锁强杀、无 SSE 下动态工具经 session/resume 原地重载、hybrid 原生工具含 pi_tools 路径不误判", { skip: THIN_CLIENT_DISABLED }, async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-resilience-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const agentsMdPath = path.join(tmpRoot, "AGENTS.md");
		fs.writeFileSync(agentsMdPath, "# Rule v1\nInitial workspace rule.\n");

		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};

		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);

		try {
			const tools = [
				{
					name: "read",
					description: "Read file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
				{
					name: "tool_search",
					description: "Search deferred tools",
					parameters: {
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"],
					},
				},
			];

			const sysWithRule = {
				role: "system" as const,
				content: "",
				sections: {
					project_context: `<project_context><project_instructions path="${agentsMdPath}"># Rule v1</project_instructions></project_context>`,
				},
				tools,
				timestamp: 1,
			};

			// 场景 1：工具执行期间磁盘上的 AGENTS.md 被修改导致 mountDigest 变化，活跃轮次仍须无缝完成绝不死锁强杀
			const uEdit = { role: "user" as const, content: "Read package.json", timestamp: 2 };
			const ctxEdit1 = normalizeContext({ tools, messages: [uEdit] });
			if (ctxEdit1.messages[0]?.role === "system") {
				ctxEdit1.messages[0].sections = sysWithRule.sections;
			}
			const step1 = await coord
				.streamSimple(TEST_MODEL, ctxEdit1, { sessionId: "pi-sess-agents" })
				.result();
			assert.equal(step1.stopReason, "toolUse");
			const tc1 = step1.content.find((c): c is ToolCall => c.type === "toolCall")!;

			// 模拟工具执行期间磁盘 AGENTS.md 发生变化
			fs.writeFileSync(agentsMdPath, "# Rule v2\nUpdated mid-turn!\n");

			const tr1 = {
				role: "toolResult" as const,
				toolCallId: tc1.id,
				toolName: "read",
				content: [{ type: "text" as const, text: '{"name":"updated"}' }],
				isError: false,
				timestamp: 3,
			};
			const ctxEdit2 = normalizeContext({ tools, messages: [uEdit, step1, tr1] });
			if (ctxEdit2.messages[0]?.role === "system") {
				ctxEdit2.messages[0].sections = sysWithRule.sections;
			}
			const step2 = await coord
				.streamSimple(TEST_MODEL, ctxEdit2, { sessionId: "pi-sess-agents" })
				.result();
			assert.equal(step2.stopReason, "stop");
			assert.equal(step2.responseId, step1.responseId);
			const text2 = step2.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.ok(text2.includes('{"name":"updated"}'));

			// 场景 2：默认 processPerSession: true（无 SSE 客户端）下，tool_search 解锁新工具后原地 close + session/resume 重拉 tools/list
			const convDir = path.join(cfg.geminiDir, "antigravity-cli", "conversations");
			fs.mkdirSync(convDir, { recursive: true });
			const unlockStart = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools,
						messages: [{ role: "user", content: "TRIGGER_TOOL_SEARCH_UNLOCK", timestamp: 10 }],
					}),
					{ sessionId: "pi-sess-unlock" },
				)
				.result();
			assert.equal(unlockStart.stopReason, "toolUse");
			const tsCall = unlockStart.content.find((c): c is ToolCall => c.type === "toolCall")!;
			const unlockAgyId = unlockStart.responseId!;
			// 创建本地占位 .db 模拟真实 agy 会话库以触发 session/resume 原地刷新路径
			const unlockDb = new DatabaseSync(path.join(convDir, `${unlockAgyId}.db`));
			unlockDb.exec("CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL, status integer NOT NULL, step_payload blob, metadata blob);");
			unlockDb.prepare("INSERT INTO steps VALUES (1, 132, 3, X'01', X'01')").run();
			unlockDb.close();

			const unlockedTools = [
				...tools,
				{
					name: "mcp__github__search_code",
					description: "Unlocked tool",
					parameters: { type: "object", properties: {} },
				},
			];
			const unlockDone = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools: unlockedTools,
						messages: [
							{ role: "user", content: "TRIGGER_TOOL_SEARCH_UNLOCK", timestamp: 10 },
							unlockStart,
							{
								role: "toolResult",
								toolCallId: tsCall.id,
								toolName: "tool_search",
								content: [{ type: "text", text: "Activated mcp__github__search_code" }],
								isError: false,
								timestamp: 11,
							},
						],
					}),
					{ sessionId: "pi-sess-unlock" },
				)
				.result();
			assert.equal(unlockDone.stopReason, "stop");
			assert.equal(unlockDone.responseId, unlockAgyId);
			const unlockText = unlockDone.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.ok(unlockText.includes("mcp__github__search_code"), `应重拉包含新解锁工具，实际：${unlockText}`);
			assert.ok(unlockText.includes("RESUMES=1"), `应通过原地 session/resume 重拉 tools/list，实际：${unlockText}`);

			// 场景 3：hybrid 模式下原生 read_file 读取文件名含 pi_tools 的文件，不得被误判为宿主 MCP 宣告并吞掉
			const hybridCfg: BridgeConfig = {
				...cfg,
				toolMode: "hybrid",
				bridgePiMcp: true,
			};
			const hybridPm = new AcpProcessManager();
			const hybridBroker = new AgyTurnMirrorBroker();
			const hybridMirrorTools = createAgyMirrorToolDefinitions(hybridBroker);
			const hybridCoord = new TurnCoordinator(createStubPiApi(), hybridPm, hybridBroker, hybridCfg);
			try {
				const hybridTools = [
					{
						name: "custom_ext",
						description: "Custom extension tool",
						parameters: { type: "object", properties: {} },
					},
				];
				const hStep1 = await hybridCoord
					.streamSimple(
						TEST_MODEL,
						normalizeContext({
							tools: hybridTools,
							messages: [{ role: "user", content: "HYBRID_NATIVE_PI_TOOLS_FILE", timestamp: 20 }],
						}),
						{ sessionId: "pi-sess-hybrid-name" },
					)
					.result();
				assert.equal(hStep1.stopReason, "toolUse");
				const mirrorTc = hStep1.content.find((c): c is ToolCall => c.type === "toolCall")!;
				assert.equal(mirrorTc.name, "agy_read");
				assert.equal(mirrorTc.arguments.path, "src/pi_tools_helper.ts");

				const readMirrorTool = hybridMirrorTools.find((t) => t.name === "agy_read")!;
				const mirrorRes = await readMirrorTool.execute(
					mirrorTc.id,
					mirrorTc.arguments,
					undefined,
					undefined,
					{ hasUI: false } as never,
				);
				assert.ok(
					mirrorRes.content.some((c) => c.type === "text" && c.text.includes("export const ok = true;")),
				);
			} finally {
				await hybridCoord.dispose();
			}
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("缓存命中率精度闭环：0% 未命中清零基准、跨生成不混入旧切片、多行 SQLite 仅取末条、大批量切片总扣减 <=1000 及中间步 WAL 延迟重试", { skip: THIN_CLIENT_DISABLED }, async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-cache-accuracy-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};

		const encodeVarint = (n: number): number[] => {
			const out: number[] = [];
			let v = n;
			while (v >= 0x80) {
				out.push((v & 0x7f) | 0x80);
				v = Math.floor(v / 128);
			}
			out.push(v);
			return out;
		};
		const makeStepBlobs = (
			inputTokens: number,
			cacheReadTokens: number,
			outputTokens: number,
			plannedTools: number,
		) => {
			const f9 = Buffer.from([
				(2 << 3) | 0, ...encodeVarint(inputTokens),
				(3 << 3) | 0, ...encodeVarint(outputTokens),
				(5 << 3) | 0, ...encodeVarint(cacheReadTokens),
			]);
			const meta = Buffer.from([(9 << 3) | 2, ...encodeVarint(f9.length), ...f9]);
			const tcSub = Buffer.from([(7 << 3) | 2, 2, 0x08, 0x01]);
			const f20 = Buffer.concat(Array.from({ length: plannedTools }, () => tcSub));
			const payload = Buffer.from([
				...encodeVarint((20 << 3) | 2),
				...encodeVarint(f20.length),
				...f20,
			]);
			return { payload, meta };
		};

		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);

		try {
			const tools = [
				{
					name: "read",
					description: "Read file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			];
			const mkTr = (tc: ToolCall, text: string, ts: number) => ({
				role: "toolResult" as const,
				toolCallId: tc.id,
				toolName: "read",
				content: [{ type: "text" as const, text }],
				isError: false,
				timestamp: ts,
			});

			// 先建立会话以获取 agySessionId，并初始化 SQLite steps 表
			const uInit = { role: "user" as const, content: "FOLLOWUP_MSG:init", timestamp: 1 };
			const initMsg = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: [uInit] }), {
					sessionId: "pi-sess-cache-acc",
				})
				.result();
			const agyId = initMsg.responseId!;
			const convDir = path.join(cfg.geminiDir, "antigravity-cli", "conversations");
			fs.mkdirSync(convDir, { recursive: true });
			const dbPath = path.join(convDir, `${agyId}.db`);
			const initDb = new DatabaseSync(dbPath);
			initDb.exec(
				"CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL, status integer NOT NULL, step_payload blob, metadata blob);",
			);
			initDb.close();

			const insertGen = (
				idx: number,
				inTok: number,
				crTok: number,
				outTok: number,
				plannedTools: number,
			) => {
				const { payload, meta } = makeStepBlobs(inTok, crTok, outTok, plannedTools);
				const db = new DatabaseSync(dbPath);
				db.prepare("INSERT OR REPLACE INTO steps VALUES (?, 15, 3, ?, ?)").run(idx, payload, meta);
				db.close();
			};

			// 场景 1：98% 命中后发生真实 0% 缓存失效，且末步 WAL 缺失而 acpUsage 汇报整轮 95% 累计均值 -> 末步不得伪造 98% 或 95%，必须保持 0%
			insertGen(10, 2000, 98000, 300, 1);
			const hist: Array<any> = [uInit, initMsg];
			const u1 = { role: "user" as const, content: "SEQ_TOOLS:2", timestamp: 2 };
			hist.push(u1);
			const s1 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: hist }), {
					sessionId: "pi-sess-cache-acc",
				})
				.result();
			assert.equal(s1.usage.input, 2000);
			assert.equal(s1.usage.cacheRead, 98000);
			const tc1 = s1.content.find((c): c is ToolCall => c.type === "toolCall")!;
			hist.push(s1, mkTr(tc1, "r1", 3));

			// 写入真实 0% 缓存未命中记录（idx=20）
			insertGen(20, 100000, 0, 250, 1);
			const s2 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: hist }), {
					sessionId: "pi-sess-cache-acc",
				})
				.result();
			assert.equal(s2.usage.input, 100000);
			assert.equal(s2.usage.cacheRead, 0);
			const tc2 = s2.content.find((c): c is ToolCall => c.type === "toolCall")!;
			hist.push(s2, mkTr(tc2, "r2", 4));

			// 末步故意不写入新 SQLite 行（模拟 WAL 延迟），而 mock 的 acpUsage 汇报整轮累计 95% 命中；
			// 必须严格维持上一步刚观测到的 0% 基准，绝不回弹成 98% 或整轮均值 95%！
			const s3 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: hist }), {
					sessionId: "pi-sess-cache-acc",
				})
				.result();
			assert.equal(s3.stopReason, "stop");
			assert.equal(s3.usage.cacheRead, 0, `真实 0% 未命中后末步回退不得伪造 cacheRead，实际为 ${s3.usage.cacheRead}`);
			hist.push(s3);

			// 场景 2：上一生成残留 pendingGenSlicePool（planned=4 但仅执行 1 个工具后进入新生成），新生成 0% 未命中绝不混入旧切片 cacheRead
			insertGen(30, 2000, 98000, 300, 4);
			const u2 = { role: "user" as const, content: "SEQ_TOOLS:2", timestamp: 5 };
			hist.push(u2);
			const gA1 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: hist }), {
					sessionId: "pi-sess-cache-acc",
				})
				.result();
			const gATc1 = gA1.content.find((c): c is ToolCall => c.type === "toolCall")!;
			hist.push(gA1, mkTr(gATc1, "ga1", 6));

			// 在第 2 个工具到达前已有新生成 B（0% 未命中）落盘，旧生成 A 剩余 3 个切片不得混入生成 B
			insertGen(40, 10000, 0, 180, 1);
			const gB1 = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: hist }), {
					sessionId: "pi-sess-cache-acc",
				})
				.result();
			assert.equal(gB1.usage.input, 10000);
			assert.equal(gB1.usage.cacheRead, 0, "新生成 0% 未命中绝不能混入旧生成残留切片的 cacheRead");
			const gBTc1 = gB1.content.find((c): c is ToolCall => c.type === "toolCall")!;
			hist.push(gB1, mkTr(gBTc1, "gb1", 7));

			// 场景 3：同时存在 2 条未消费 SQLite 生成（idx=50 0% + idx=60 96%），必须仅汇报末条 idx=60 的纯净命中率与输出，不混合求平均
			insertGen(50, 50000, 0, 500, 0);
			insertGen(60, 2000, 48000, 120, 0);
			const gFinal = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: hist }), {
					sessionId: "pi-sess-cache-acc",
				})
				.result();
			assert.equal(gFinal.stopReason, "stop");
			assert.equal(gFinal.usage.input, 2000);
			assert.equal(gFinal.usage.cacheRead, 48000);
			assert.equal(gFinal.usage.output, 120);
			hist.push(gFinal);

			// 场景 4：大批量 5 工具单次生成，全部预留切片总扣减 <= 1000（低于 Pi cache-stats 1024 噪声门限）且 5 步之和 100% 守恒
			insertGen(70, 4000, 96000, 500, 5);
			const u5 = { role: "user" as const, content: "SEQ_TOOLS:5", timestamp: 8 };
			hist.push(u5);
			let sumIn = 0;
			let sumCr = 0;
			let sumOut = 0;
			for (let i = 1; i <= 5; i++) {
				const stepMsg = await coord
					.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: hist }), {
						sessionId: "pi-sess-cache-acc",
					})
					.result();
				assert.equal(stepMsg.stopReason, "toolUse");
				const p = stepMsg.usage.input + stepMsg.usage.cacheRead;
				if (i === 1) {
					assert.ok(p >= 99000, `第 1 步总扣减应 <= 1000，实际第 1 步 prompt=${p}`);
				} else {
					assert.ok(p > 0 && p <= 1000, `第 ${i} 个切片应保持在 (0, 1000]，实际 ${p}`);
				}
				const rate = (stepMsg.usage.cacheRead / p) * 100;
				assert.ok(Math.abs(rate - 96.0) < 0.6, `第 ${i} 步命中率应接近 96.0%，实际 ${rate}`);
				sumIn += stepMsg.usage.input;
				sumCr += stepMsg.usage.cacheRead;
				sumOut += stepMsg.usage.output;
				const tc = stepMsg.content.find((c): c is ToolCall => c.type === "toolCall")!;
				hist.push(stepMsg, mkTr(tc, `batch-${i}`, 8 + i));
			}
			assert.equal(sumIn, 4000);
			assert.equal(sumCr, 96000);
			assert.equal(sumOut, 500);
			insertGen(75, 1000, 99000, 80, 0);
			const u5End = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: hist }), {
					sessionId: "pi-sess-cache-acc",
				})
				.result();
			assert.equal(u5End.stopReason, "stop");
			hist.push(u5End);

			// 场景 5：中间步 SQLite WAL 延迟 10ms 才落盘（idx=99），buildIntermediateStepUsage 必须通过短重试精准捕获
			const uWal = { role: "user" as const, content: "DELAYED_WAL_TOOL", timestamp: 20 };
			hist.push(uWal);
			const walStep = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: hist }), {
					sessionId: "pi-sess-cache-acc",
				})
				.result();
			assert.equal(walStep.stopReason, "toolUse");
			assert.equal(walStep.usage.input, 3000);
			assert.equal(walStep.usage.cacheRead, 97000);
			assert.equal(walStep.usage.output, 220);
			const walTc = walStep.content.find((c): c is ToolCall => c.type === "toolCall")!;
			hist.push(walStep, mkTr(walTc, "wal-res", 21));
			const walEnd = await coord
				.streamSimple(TEST_MODEL, normalizeContext({ tools, messages: hist }), {
					sessionId: "pi-sess-cache-acc",
				})
				.result();
			assert.equal(walEnd.stopReason, "stop");
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("适配 pi-traffic-optimization 端到端：图片压缩零断连、批量 GC 在空闲边界按需重建瘦身会话、冷却期复用热缓存且关闭优化后还原完整上下文", { skip: THIN_CLIENT_DISABLED }, async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-traffic-opt-"));
		const binPath = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};

		const capturedPayloads: Array<{ sessionId: string; prompt: Array<{ type: string; text?: string; mimeType?: string }> }> = [];
		const capturedResponseHeaders: Array<Record<string, string>> = [];
		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);

		try {
			const tools = [
				{
					name: "read",
					description: "Read file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
				{
					name: "context_recall",
					description: "Recall archived context",
					parameters: {
						type: "object",
						properties: {
							id: { type: "string" },
							view: { anyOf: [{ const: "snapshot" }, { const: "current" }, { const: "diff" }] },
						},
					},
				},
			];
			const mkTr = (tc: ToolCall, text: string, ts: number) => ({
				role: "toolResult" as const,
				toolCallId: tc.id,
				toolName: "read",
				content: [{ type: "text" as const, text }],
				isError: false,
				timestamp: ts,
			});

			const runStep = (messages: any[]) =>
				coord
					.streamSimple(TEST_MODEL, normalizeContext({ tools, messages }), {
						sessionId: "pi-sess-topt",
						onPayload: (payload) => {
							capturedPayloads.push(payload as any);
						},
						onResponse: (response) => {
							capturedResponseHeaders.push(response.headers);
						},
					})
					.result();

			// Turn 1：发送带 PNG 图片 + 4 个顺序工具调用建立有状态会话
			const u1Raw: any = {
				role: "user",
				content: [
					{ type: "image", data: "RAW_PNG_BYTES", mimeType: "image/png" },
					{ type: "text", text: "SEQ_TOOLS:4" },
				],
				timestamp: 1,
			};
			const hist: any[] = [u1Raw];
			const toolResults: Array<{ idx: number; callId: string; rawText: string }> = [];
			for (let i = 1; i <= 4; i++) {
				const step = await runStep(hist);
				assert.equal(step.stopReason, "toolUse");
				const tc = step.content.find((c): c is ToolCall => c.type === "toolCall")!;
				const tr = mkTr(tc, `RAW_LARGE_FILE_CONTENT_${i}_${"Z".repeat(6000)}`, 1 + i);
				hist.push(step, tr);
				toolResults.push({ idx: hist.length - 1, callId: tc.id, rawText: tr.content[0].text });
			}
			const t1End = await runStep(hist);
			assert.equal(t1End.stopReason, "stop");
			const originalAgyId = t1End.responseId!;
			hist.push(t1End);
			const mcpHeaders = capturedResponseHeaders.filter(
				(h) => h["x-acp-transport"] === "acp-mcp-result",
			);
			assert.equal(mcpHeaders.length, 4, "4 次宿主 MCP 回传均应通告 x-acp-transport=acp-mcp-result");
			assert.ok(mcpHeaders.every((h) => Boolean(h["x-acp-settled-mcp-ids"])));

			// Turn 2：pi-traffic-optimization 仅压缩历史用户图片 PNG -> WebP（未触发 GC），必须复用同一原会话保热缓存
			const histCompressed = hist.map((m, idx) =>
				idx === 0
					? {
							...m,
							content: [
								{ type: "image", data: "COMPRESSED_WEBP_BYTES", mimeType: "image/webp" },
								{ type: "text", text: "SEQ_TOOLS:4" },
							],
						}
					: m,
			);
			const u2 = { role: "user", content: "FOLLOWUP_MSG:after-webp", timestamp: 10 };
			const t2End = await runStep([...histCompressed, u2]);
			assert.equal(t2End.stopReason, "stop");
			assert.equal(t2End.responseId, originalAgyId, "仅图片压缩不应拆毁热缓存会话");
			assert.equal(capturedResponseHeaders.at(-1)?.["x-acp-projection-synced"], "1");
			histCompressed.push(u2, t2End);

			// Turn 2.5：少量归档（delta=1 < 4 且低水位）复用原会话时，必须显式通告 x-acp-projection-synced=0
			const histPartialGc = histCompressed.map((m) => ({ ...m }));
			const firstTrMeta = toolResults[0];
			const h1 = "1".repeat(64);
			histPartialGc[firstTrMeta.idx] = {
				...histPartialGc[firstTrMeta.idx],
				content: [
					{
						type: "text",
						text: `[已归档 ctx://tool/${h1}]\n{"tool":"read","call":"${firstTrMeta.callId}"}\n这是历史结果。精确取回：context_recall({id:"ctx://tool/${h1}"})`,
					},
				],
			};
			const u25 = { role: "user", content: "FOLLOWUP_MSG:partial-gc", timestamp: 15 };
			const t25End = await runStep([...histPartialGc, u25]);
			assert.equal(t25End.stopReason, "stop");
			assert.equal(t25End.responseId, originalAgyId, "少量归档在低水位下应复用热缓存会话");
			assert.equal(
				capturedResponseHeaders.at(-1)?.["x-acp-projection-synced"],
				"0",
				"未瘦身复用旧会话时必须通过 x-acp-projection-synced=0 告知流量扩展跳过失真校准",
			);
			histCompressed.push(u25, t25End);

			// Turn 3：pi-traffic-optimization 触发批量 GC，将 4 条旧 toolResult 替换为紧凑 [已归档 ctx://tool/...] 占位符
			const histProjected = histCompressed.map((m) => ({ ...m }));
			for (let i = 0; i < toolResults.length; i++) {
				const trMeta = toolResults[i];
				const h = `${i + 1}`.repeat(64);
				histProjected[trMeta.idx] = {
					...histProjected[trMeta.idx],
					content: [
						{
							type: "text",
							text: `[已归档 ctx://tool/${h}]\n{"tool":"read","call":"${trMeta.callId}"}\n这是历史结果。精确取回：context_recall({id:"ctx://tool/${h}"})`,
						},
					],
				};
			}
			const u3 = { role: "user", content: "FOLLOWUP_MSG:after-gc", timestamp: 20 };
			const payloadCountBeforeGc = capturedPayloads.length;
			const t3End = await runStep([...histProjected, u3]);
			assert.equal(t3End.stopReason, "stop");
			const slimAgyId = t3End.responseId!;
			assert.notEqual(slimAgyId, originalAgyId, "批量 GC 后应重建瘦身后的新 AGY 会话以释放后端上下文");
			assert.equal(
				capturedResponseHeaders.at(-1)?.["x-acp-projection-synced"],
				"1",
				"重建瘦身新会话后应通告 x-acp-projection-synced=1 恢复校准",
			);
			// 验证重建的 FreshReplay 确实携带了 ctx:// 归档占位符，且不再携带 6KB 原始大输出
			const gcReplayText = capturedPayloads
				.slice(payloadCountBeforeGc)
				.flatMap((p) => p.prompt)
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
			assert.ok(gcReplayText.includes("ctx://tool/1111111111111111"));
			assert.ok(!gcReplayText.includes("RAW_LARGE_FILE_CONTENT_1_"));
			histProjected.push(u3, t3End);

			// Turn 4：GC 冷却期内投影指纹保持不变，必须继续复用瘦身会话（零重复重建、保持热缓存）
			const u4 = { role: "user", content: "FOLLOWUP_MSG:cooldown-hit", timestamp: 30 };
			const t4End = await runStep([...histProjected, u4]);
			assert.equal(t4End.stopReason, "stop");
			assert.equal(t4End.responseId, slimAgyId, "冷却期内投影未变化必须复用瘦身会话保热缓存");
			histProjected.push(u4, t4End);

			// Turn 5：用户执行 /traffic-opt 关，历史占位符全部还原为完整原始工具结果 -> 应按需重建恢复完整上下文
			const histRestored = histProjected.map((m) => ({ ...m }));
			for (const trMeta of toolResults) {
				histRestored[trMeta.idx] = {
					...histRestored[trMeta.idx],
					content: [{ type: "text", text: trMeta.rawText }],
				};
			}
			const u5 = { role: "user", content: "FOLLOWUP_MSG:traffic-opt-off", timestamp: 40 };
			const t5End = await runStep([...histRestored, u5]);
			assert.equal(t5End.stopReason, "stop");
			assert.notEqual(t5End.responseId, slimAgyId, "关闭优化恢复完整上下文后应重建会话以还原完整内容");
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("超长历史与超长辅助压缩请求自动通过官方模板克隆 SQLite 多步预注入零额外调用恢复（保留 pi-bridge 规格），禁用 SQLite 时平滑降级至单步安全预算且保住末尾提问", { skip: THIN_CLIENT_DISABLED }, async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-preload-"));
		const binPath = writeMockAgyExecutable(tmpRoot, { seedTemplateDbOnNew: true });
		const convDir = path.join(tmpRoot, ".gemini", "antigravity-cli", "conversations");
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
			agyBin: binPath,
			geminiDir: path.join(tmpRoot, ".gemini"),
			enableSqliteFork: true,
		};

		const capturedPayloads: Array<{ sessionId: string; prompt: Array<{ type: string; text?: string }> }> = [];
		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);

		try {
			// 构造 > 240 KB 超长历史（远超单步 64k 安全线）
			const longHistory: any[] = [];
			for (let i = 0; i < 36; i++) {
				longHistory.push({
					role: "user",
					content: `HIST_USER_${i}: ${"长上下文历史日志 code=12345 token_density_check ".repeat(85)}`,
					timestamp: i * 2 + 1,
				});
				longHistory.push({
					role: "assistant",
					content: [{ type: "text", text: `HIST_ASST_${i}: ${"助手历史回复内容 alpha beta gamma 67890 ".repeat(85)}` }],
					api: "antigravity-acp",
					provider: "antigravity",
					model: "gemini-4-neon",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 150,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: i * 2 + 2,
				});
			}
			const tailUser = {
				role: "user",
				content: "FOLLOWUP_MSG:TAIL_QUESTION_INTACT_777",
				timestamp: 9999,
			};

			// 1. 开启 enableSqliteFork（默认）：应自动创建预注入 .db 并经 session/resume 零额外 LLM 调用直达，单次 session/prompt 仅含末尾提问，且 onPayload 附带 preloadedTurns 观测字段
			const capturedResponseHeaders: Array<Record<string, string>> = [];
			const resPreload = await coord
				.streamSimple(
					{ ...TEST_MODEL, contextWindow: 1_000_000 },
					normalizeContext({ tools: [], messages: [...longHistory, tailUser] }),
					{
						sessionId: "pi-sess-preload-on",
						onPayload: (payload) => {
							capturedPayloads.push(payload as any);
						},
						onResponse: (response) => {
							capturedResponseHeaders.push(response.headers);
						},
					},
				)
				.result();
			assert.equal(resPreload.stopReason, "stop");
			const seededId = resPreload.responseId!;
			assert.equal(capturedPayloads.length, 1, "SQLite 多步预注入应零额外 LLM 调用，仅发 1 次 session/prompt");
			assert.ok(
				Array.isArray((capturedPayloads[0] as any).preloadedTurns) &&
					(capturedPayloads[0] as any).preloadedTurns.length >= 2,
				"onPayload 应附带 preloadedTurns 供流量观测扩展统计多步预注入负载",
			);
			assert.equal(capturedResponseHeaders[0]?.["x-acp-projection-synced"], "1");

			const seededDbPath = path.join(convDir, `${seededId}.db`);
			assert.ok(fs.existsSync(seededDbPath), "应已生成独立 UUID 的预注入 SQLite 会话库");
			const dbsAfterSeed = fs.readdirSync(convDir).filter((f) => f.endsWith(".db"));
			assert.deepEqual(dbsAfterSeed, [`${seededId}.db`], "官方空白模板库必须在克隆后立即删除，仅保留预注入会话库");
			const db = new DatabaseSync(seededDbPath, { readOnly: true });
			const stepCountRow = db.prepare("SELECT COUNT(*) AS n FROM steps").get() as { n: number };
			const firstPayload = db.prepare("SELECT step_payload FROM steps WHERE idx = 0").get() as {
				step_payload: Uint8Array;
			};
			const metaBlobRow = db
				.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
				.get() as { data: Uint8Array };
			db.close();
			assert.ok(stepCountRow.n >= 4, `预注入库应包含多对交替步，实际 steps=${stepCountRow.n}`);
			assert.ok(Buffer.from(firstPayload.step_payload).includes("HIST_USER_0:"));
			const metaBlobStr = Buffer.from(metaBlobRow.data).toString("utf8");
			assert.ok(metaBlobStr.includes("pi-bridge"), "预注入会话库必须完整保留 pi-bridge 规格以禁用内置工具");
			assert.ok(metaBlobStr.includes(seededId), "预注入会话库元数据中的 UUID 必须更新为新会话 UUID");

			const sentPromptText = capturedPayloads[0].prompt
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
			assert.ok(sentPromptText.includes("FOLLOWUP_MSG:TAIL_QUESTION_INTACT_777"));
			assert.ok(Buffer.byteLength(sentPromptText, "utf8") < 10_000, "最终 prompt 应仅发送安全大小内的末尾提问");

			// 2. 辅助单轮请求（如 /compact 摘要）面对 > 220 KB 单条超长待压缩对话：预注入后零截断完成、触发 onPayload/onResponse(x-acp-auxiliary=1) 并自动清理临时 .db
			const beforeCompactDbs = new Set(fs.readdirSync(convDir));
			const auxPayloads: any[] = [];
			const auxHeaders: Array<Record<string, string>> = [];
			const hugeCompactPrompt = `<conversation>\n${"历史记录条目 0123456789 中文测试\n".repeat(6_000)}\n</conversation>\nSummarize this conversation for compaction.`;
			const compactRes = await coord
				.streamSimple(
					{ ...TEST_MODEL, contextWindow: 1_000_000 },
					normalizeContext({
						tools: [],
						messages: [{ role: "user", content: hugeCompactPrompt, timestamp: 1 }],
					}),
					{
						sessionId: "pi-sess-preload-on",
						disableContinuation: true,
						onPayload: (payload) => {
							auxPayloads.push(payload);
						},
						onResponse: (response) => {
							auxHeaders.push(response.headers);
						},
					},
				)
				.result();
			assert.equal(compactRes.stopReason, "stop");
			assert.equal(auxPayloads.length, 1, "辅助请求应触发 onPayload");
			assert.ok(Array.isArray(auxPayloads[0].preloadedTurns) && auxPayloads[0].preloadedTurns.length > 0);
			assert.equal(auxHeaders[0]?.["x-acp-auxiliary"], "1", "辅助请求响应头应标记 x-acp-auxiliary=1");
			const afterCompactDbs = fs.readdirSync(convDir).filter((f) => !beforeCompactDbs.has(f));
			assert.equal(afterCompactDbs.length, 0, "辅助请求使用的临时预注入 SQLite 文件必须在结束后彻底清理");

			// 2b. 辅助请求遇 refusal / cancelled 必须明确失败为 error / aborted，绝不写入损坏摘要
			const refusalRes = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools: [],
						messages: [{ role: "user", content: "AUX_STOP_REFUSAL", timestamp: 2 }],
					}),
					{ sessionId: "pi-sess-preload-on", disableContinuation: true },
				)
				.result();
			assert.equal(refusalRes.stopReason, "error");
			const cancelledRes = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools: [],
						messages: [{ role: "user", content: "AGY_STOP_CANCELLED", timestamp: 3 }],
					}),
					{ sessionId: "pi-sess-preload-on", disableContinuation: true },
				)
				.result();
			assert.equal(cancelledRes.stopReason, "aborted");

			// 3. 禁用 enableSqliteFork 时：平滑降级为 session/new + 单步双阈值安全预算，不新建 .db 且 100% 保留末尾提问
			coord.setConfig({ ...cfg, enableSqliteFork: false });
			const fallbackPayloads: Array<{ sessionId: string; prompt: Array<{ type: string; text?: string }> }> = [];
			const beforeFallbackDbs = new Set(fs.readdirSync(convDir));
			const resFallback = await coord
				.streamSimple(
					{ ...TEST_MODEL, contextWindow: 1_000_000 },
					normalizeContext({ tools: [], messages: [...longHistory, tailUser] }),
					{
						sessionId: "pi-sess-preload-off",
						onPayload: (payload) => {
							fallbackPayloads.push(payload as any);
						},
					},
				)
				.result();
			assert.equal(resFallback.stopReason, "stop");
			assert.equal(fallbackPayloads.length, 1);
			const fallbackText = fallbackPayloads[0].prompt
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
			assert.ok(fallbackText.includes("FOLLOWUP_MSG:TAIL_QUESTION_INTACT_777"), "降级模式必须 100% 保住末尾提问");
			assert.ok(Buffer.byteLength(fallbackText, "utf8") <= 110_000, "降级模式单步字节数不得超过安全红线");
			const fallbackDbPath = path.join(convDir, `${resFallback.responseId!}.db`);
			if (fs.existsSync(fallbackDbPath)) {
				const fbDb = new DatabaseSync(fallbackDbPath, { readOnly: true });
				const fbSteps = fbDb.prepare("SELECT COUNT(*) AS n FROM steps").get() as { n: number };
				fbDb.close();
				assert.equal(fbSteps.n, 0, "禁用 enableSqliteFork 时不得向会话库写入预注入步骤");
			}
			const newFallbackDbs = fs.readdirSync(convDir).filter((f) => !beforeFallbackDbs.has(f) && f.endsWith(".db"));
			assert.equal(newFallbackDbs.length, 1, "禁用 enableSqliteFork 时仅应由单次 session/new 生成一个普通会话库");
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("宿主 MCP 返回 > 9,600B 图片应延迟至同会话多模态 session/prompt 投递，<= 9,600B 小图直接走 MCP 内联", { skip: THIN_CLIENT_DISABLED }, async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcp-deferred-img-"));
		const mockBin = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
			agyBin: mockBin,
			geminiDir: path.join(tmpRoot, ".gemini"),
			processPerSession: true,
			enableSqliteFork: false,
		};

		const processManager = new AcpProcessManager();
		const mirrorBroker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), processManager, mirrorBroker, cfg);

		try {
			const readTool = {
				name: "read",
				description: "Read file",
				parameters: { type: "object", properties: { path: { type: "string" } } } as any,
			};

			// 场景 A：> 9,600 字节图片（12,000 字节 WebP）
			const bigImageBytes = Buffer.alloc(12_000, 0x5a);
			const bigImageBase64 = bigImageBytes.toString("base64");
			const payloadsBig: any[] = [];
			const headersBig: Array<Record<string, string>> = [];

			const step1 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools: [readTool],
						messages: [{ role: "user", content: "TRIGGER_MCP_SINGLE_IMAGE", timestamp: 1 }],
					}),
					{
						sessionId: "pi-sess-img-big",
						onPayload: (p) => {
							payloadsBig.push(p);
						},
						onResponse: (r) => {
							headersBig.push(r.headers);
						},
					},
				)
				.result();
			assert.equal(step1.stopReason, "toolUse");
			const firstSessionId = step1.responseId!;
			const tc1 = step1.content.find((c): c is ToolCall => c.type === "toolCall");
			assert.ok(tc1, "应发出宿主 MCP read 工具调用");

			const step2 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools: [readTool],
						messages: [
							{ role: "user", content: "TRIGGER_MCP_SINGLE_IMAGE", timestamp: 1 },
							step1,
							{
								role: "toolResult",
								toolCallId: tc1.id,
								toolName: "read",
								content: [
									{ type: "text", text: "Read image file [image/webp]" },
									{ type: "image", data: bigImageBase64, mimeType: "image/webp" },
								],
								isError: false,
								timestamp: 2,
							},
						],
					}),
					{
						sessionId: "pi-sess-img-big",
						onPayload: (p) => {
							payloadsBig.push(p);
						},
						onResponse: (r) => {
							headersBig.push(r.headers);
						},
					},
				)
				.result();

			assert.equal(step2.stopReason, "stop");
			assert.equal(step2.responseId, firstSessionId, "大图多模态切入必须复用同一个热会话 agySessionId");
			const finalTextBig = step2.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.ok(
				finalTextBig.includes("DEFERRED_IMAGES_RECEIVED=1"),
				`模型应通过同会话多模态 prompt 收到 1 张完整大图，实际回复: ${finalTextBig}`,
			);
			assert.ok(finalTextBig.includes("MIMES=image/webp"), `MIME 应保持 image/webp: ${finalTextBig}`);
			assert.ok(finalTextBig.includes("BYTES=12000"), `解码字节数应精确等于 12000: ${finalTextBig}`);
			assert.ok(finalTextBig.includes("MCP_INLINE_IMAGES=0"), `HTTP MCP 回传中不得内联 >9.6KB 大图: ${finalTextBig}`);
			assert.ok(finalTextBig.includes(`SESSION=${firstSessionId}`), `必须仍在同一 agySessionId: ${finalTextBig}`);

			const mcpResultHeader = headersBig.find((h) => h["x-acp-transport"] === "acp-mcp-result");
			assert.ok(mcpResultHeader, "应发出 acp-mcp-result 观测响应头");
			assert.equal(mcpResultHeader["x-acp-mcp-images-deferred"], "9600");

			assert.equal(payloadsBig.length, 2, "总计应有首轮 prompt 与工具边界多模态切入 prompt 共 2 次");
			assert.equal(payloadsBig[1].sessionId, firstSessionId);
			assert.ok(
				payloadsBig[1].prompt.some(
					(b: any) => b.type === "text" && b.text.includes(`<tool_result id="${tc1.id}" tool="read" status="ok">`),
				),
				"多模态切入 prompt 应包含对应 tool_result 归属包装块",
			);
			assert.ok(
				payloadsBig[1].prompt.some((b: any) => b.type === "image" && b.data === bigImageBase64 && b.mimeType === "image/webp"),
				"多模态切入 prompt 应包含完整原图 image block",
			);

			// 场景 B：<= 9,600 字节小图（512 字节 PNG）直接走 MCP 内联，不触发切入且不带延迟响应头
			const smallImageBase64 = Buffer.alloc(512, 0x33).toString("base64");
			const payloadsSmall: any[] = [];
			const headersSmall: Array<Record<string, string>> = [];

			const smallStep1 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools: [readTool],
						messages: [{ role: "user", content: "TRIGGER_MCP_SINGLE_IMAGE", timestamp: 10 }],
					}),
					{
						sessionId: "pi-sess-img-small",
						onPayload: (p) => {
							payloadsSmall.push(p);
						},
						onResponse: (r) => {
							headersSmall.push(r.headers);
						},
					},
				)
				.result();
			assert.equal(smallStep1.stopReason, "toolUse");
			const smallTc = smallStep1.content.find((c): c is ToolCall => c.type === "toolCall");
			assert.ok(smallTc);

			const smallStep2 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools: [readTool],
						messages: [
							{ role: "user", content: "TRIGGER_MCP_SINGLE_IMAGE", timestamp: 10 },
							smallStep1,
							{
								role: "toolResult",
								toolCallId: smallTc.id,
								toolName: "read",
								content: [{ type: "image", data: smallImageBase64, mimeType: "image/png" }],
								isError: false,
								timestamp: 11,
							},
						],
					}),
					{
						sessionId: "pi-sess-img-small",
						onPayload: (p) => {
							payloadsSmall.push(p);
						},
						onResponse: (r) => {
							headersSmall.push(r.headers);
						},
					},
				)
				.result();
			assert.equal(smallStep2.stopReason, "stop");
			const finalTextSmall = smallStep2.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.ok(
				finalTextSmall.includes("INLINE_MCP_IMAGES=1"),
				`<= 9.6KB 小图应直接经 HTTP MCP 内联回传: ${finalTextSmall}`,
			);
			assert.equal(payloadsSmall.length, 1, "小图内联模式不得触发额外 session/prompt 切入");
			const smallMcpHeader = headersSmall.find((h) => h["x-acp-transport"] === "acp-mcp-result");
			assert.ok(smallMcpHeader);
			assert.equal(smallMcpHeader["x-acp-mcp-images-deferred"], undefined, "无大图延迟时不应附加 x-acp-mcp-images-deferred");
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("并发双工具中第 1 个返回大图、第 2 个返回纯文本时应待第 2 个工具也结算后再统一切入投递大图", { skip: THIN_CLIENT_DISABLED }, async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcp-concurrent-img-"));
		const mockBin = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
			agyBin: mockBin,
			geminiDir: path.join(tmpRoot, ".gemini"),
			processPerSession: true,
			enableSqliteFork: false,
		};

		const processManager = new AcpProcessManager();
		const mirrorBroker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), processManager, mirrorBroker, cfg);

		try {
			const tools = [
				{
					name: "read",
					description: "Read file",
					parameters: { type: "object", properties: { path: { type: "string" } } } as any,
				},
				{
					name: "bash",
					description: "Run bash",
					parameters: { type: "object", properties: { command: { type: "string" } } } as any,
				},
			];
			const bigImageBase64 = Buffer.alloc(14_000, 0x6b).toString("base64");
			const capturedPayloads: any[] = [];
			const capturedHeaders: Array<Record<string, string>> = [];

			const step1 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools,
						messages: [{ role: "user", content: "TRIGGER_MCP_CONCURRENT_IMAGE_AND_TEXT", timestamp: 1 }],
					}),
					{
						sessionId: "pi-sess-img-par",
						onPayload: (p) => {
							capturedPayloads.push(p);
						},
						onResponse: (r) => {
							capturedHeaders.push(r.headers);
						},
					},
				)
				.result();
			assert.equal(step1.stopReason, "toolUse");
			const sid = step1.responseId!;
			const step1Calls = step1.content.filter((c): c is ToolCall => c.type === "toolCall");
			const readCall = step1Calls.find((c) => c.name === "read");
			assert.ok(readCall, "第 1 步应包含 read 工具调用");
			let bashCall = step1Calls.find((c) => c.name === "bash");

			const messages: any[] = [
				{ role: "user", content: "TRIGGER_MCP_CONCURRENT_IMAGE_AND_TEXT", timestamp: 1 },
				step1,
			];
			let finalMsg = step1;

			if (!bashCall) {
				// 仅先结算第 1 个大图工具时，第 2 个并发工具仍在挂起/排队，不得提前切入中断第 2 个工具
				messages.push({
					role: "toolResult",
					toolCallId: readCall.id,
					toolName: "read",
					content: [{ type: "image", data: bigImageBase64, mimeType: "image/jpeg" }],
					isError: false,
					timestamp: 2,
				});
				const step2 = await coord
					.streamSimple(TEST_MODEL, normalizeContext({ tools, messages }), {
						sessionId: "pi-sess-img-par",
						onPayload: (p) => {
							capturedPayloads.push(p);
						},
						onResponse: (r) => {
							capturedHeaders.push(r.headers);
						},
					})
					.result();
				assert.equal(step2.stopReason, "toolUse", "仍有未结算并发工具时不应提前切入结束轮次");
				assert.equal(capturedPayloads.length, 1, "第 2 个工具尚未结算前不得提前发出切入 session/prompt");
				bashCall = step2.content.find((c): c is ToolCall => c.type === "toolCall" && c.name === "bash");
				assert.ok(bashCall, "应继续向 Pi 发出第 2 个并发工具 bash");
				messages.push(step2);
				messages.push({
					role: "toolResult",
					toolCallId: bashCall.id,
					toolName: "bash",
					content: [{ type: "text", text: "ok_from_bash" }],
					isError: false,
					timestamp: 3,
				});
				finalMsg = await coord
					.streamSimple(TEST_MODEL, normalizeContext({ tools, messages }), {
						sessionId: "pi-sess-img-par",
						onPayload: (p) => {
							capturedPayloads.push(p);
						},
						onResponse: (r) => {
							capturedHeaders.push(r.headers);
						},
					})
					.result();
			} else {
				// 两个并发工具在同一批次发出时，一起结算后统一切入投递大图
				messages.push(
					{
						role: "toolResult",
						toolCallId: readCall.id,
						toolName: "read",
						content: [{ type: "image", data: bigImageBase64, mimeType: "image/jpeg" }],
						isError: false,
						timestamp: 2,
					},
					{
						role: "toolResult",
						toolCallId: bashCall.id,
						toolName: "bash",
						content: [{ type: "text", text: "ok_from_bash" }],
						isError: false,
						timestamp: 3,
					},
				);
				finalMsg = await coord
					.streamSimple(TEST_MODEL, normalizeContext({ tools, messages }), {
						sessionId: "pi-sess-img-par",
						onPayload: (p) => {
							capturedPayloads.push(p);
						},
						onResponse: (r) => {
							capturedHeaders.push(r.headers);
						},
					})
					.result();
			}

			assert.equal(finalMsg.stopReason, "stop");
			assert.equal(finalMsg.responseId, sid);
			const text = finalMsg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.ok(text.includes("DEFERRED_IMAGES_RECEIVED=1"), `应投递 1 张大图: ${text}`);
			assert.ok(text.includes("BYTES=14000"), `应完整送达 14000 字节图片: ${text}`);
			assert.ok(text.includes("TEXT_TOOL=ok_from_bash"), `第 2 个并发工具文本输出必须完整结算不被误中断: ${text}`);
			assert.equal(capturedPayloads.length, 2, "两个并发工具全数结算后应仅触发 1 次切入 session/prompt");
			const deferredHeaders = capturedHeaders.filter((h) => h["x-acp-mcp-images-deferred"] === "9600");
			assert.equal(deferredHeaders.length, 1, "仅在包含大图的结算批次标记 x-acp-mcp-images-deferred");
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("宿主 MCP 返回 > 9,200B 大文本应切入同会话完整投递、并发超时剥离不丢结果，且隔离残留内置工具并自动续接 max_turn_requests", { skip: THIN_CLIENT_DISABLED }, async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-e2e-text-cutin-"));
		const mockBin = writeMockAgyExecutable(tmpRoot);
		const cfg: BridgeConfig = {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
			agyBin: mockBin,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};

		const pm = new AcpProcessManager();
		const broker = new AgyTurnMirrorBroker();
		const coord = new TurnCoordinator(createStubPiApi(), pm, broker, cfg);

		const tools = [
			{
				name: "read",
				description: "Read file",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
				} as never,
			},
			{
				name: "bash",
				description: "Run bash",
				parameters: {
					type: "object",
					properties: { command: { type: "string" } },
					required: ["command"],
				} as never,
			},
		];

		try {
			// 场景 1：单次 read 返回 24KB 文本（远超 agy 10KB MCP 上限），应在同一热会话无截断完整送达首中尾全部标记
			const capturedHeaders: Array<Record<string, string>> = [];
			const step1 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools,
						messages: [{ role: "user", content: "TRIGGER_MCP_LARGE_TEXT", timestamp: 1 }],
					}),
					{
						sessionId: "pi-sess-large-text",
						onResponse: (r) => {
							capturedHeaders.push(r.headers);
						},
					},
				)
				.result();
			assert.equal(step1.stopReason, "toolUse");
			const sid1 = step1.responseId;
			const tc1 = step1.content.find((c): c is ToolCall => c.type === "toolCall");
			assert.ok(tc1);

			const bigText = `HEAD_MARKER_ALPHA\n${"x".repeat(12_000)}\nMIDDLE_MARKER_OMEGA\n${"y".repeat(12_000)}\nTAIL_MARKER_ZETA`;
			const step1Final = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools,
						messages: [
							{ role: "user", content: "TRIGGER_MCP_LARGE_TEXT", timestamp: 1 },
							step1,
							{
								role: "toolResult",
								toolCallId: tc1.id,
								toolName: "read",
								content: [{ type: "text", text: bigText }],
								isError: false,
								timestamp: 2,
							},
						],
					}),
					{
						sessionId: "pi-sess-large-text",
						onResponse: (r) => {
							capturedHeaders.push(r.headers);
						},
					},
				)
				.result();
			assert.equal(step1Final.stopReason, "stop");
			assert.equal(step1Final.responseId, sid1, "大文本切入应严格复用同一热会话 ID");
			const out1 = step1Final.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.ok(out1.includes("HAS_HEAD=true"), out1);
			assert.ok(out1.includes("HAS_MID=true"), `中间段不得被 10KB 上限挖空: ${out1}`);
			assert.ok(out1.includes("HAS_TAIL=true"), out1);
			assert.ok(
				capturedHeaders.some((h) => h["x-acp-mcp-text-deferred"] === "9200"),
				"应标记 x-acp-mcp-text-deferred 响应头",
			);

			// 场景 2：pi-tools 下忽略后端非宿主内置工具宣告（不泄漏门控计数、不派发未激活镜像工具）并在 max_turn_requests 时自动无感续接
			const tStart = Date.now();
			const step2 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools,
						messages: [{ role: "user", content: "TRIGGER_RESIDUAL_BUILTIN_AND_MAX_TURN", timestamp: 1 }],
					}),
					{ sessionId: "pi-sess-max-turn" },
				)
				.result();
			const step2Elapsed = Date.now() - tStart;
			assert.equal(step2.stopReason, "toolUse");
			const emittedTools2 = step2.content.filter((c): c is ToolCall => c.type === "toolCall");
			assert.equal(emittedTools2.length, 1, "不应把 list_resources 作为镜像工具派发给 Pi");
			assert.equal(emittedTools2[0].name, "read");
			assert.ok(step2Elapsed < 170, `不应因内置工具门控计数泄漏而卡满 180ms 窗口 (elapsed=${step2Elapsed}ms)`);

			const step2Final = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools,
						messages: [
							{ role: "user", content: "TRIGGER_RESIDUAL_BUILTIN_AND_MAX_TURN", timestamp: 1 },
							step2,
							{
								role: "toolResult",
								toolCallId: emittedTools2[0].id,
								toolName: "read",
								content: [{ type: "text", text: "RESUMED_DATA" }],
								isError: false,
								timestamp: 2,
							},
						],
					}),
					{ sessionId: "pi-sess-max-turn" },
				)
				.result();
			assert.equal(step2Final.stopReason, "stop");
			const out2 = step2Final.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.equal(out2, "AUTO_CONTINUED_OK:RESUMED_DATA");

			// 场景 3：并发双工具触发 holdTimeout 预取消且后端收到 session/cancel 主动断开第 2 个工具连接时，两个工具结果均完整补发
			(coord as unknown as { httpMcpBridge: { holdLimitMs: number } }).httpMcpBridge.holdLimitMs = 70;
			const step3 = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools,
						messages: [{ role: "user", content: "TRIGGER_MCP_CONCURRENT_HOLD_DETACH", timestamp: 1 }],
					}),
					{ sessionId: "pi-sess-hold-batch" },
				)
				.result();
			assert.equal(step3.stopReason, "toolUse");
			const batchCalls = step3.content.filter((c): c is ToolCall => c.type === "toolCall");
			assert.equal(batchCalls.length, 2, "应在同一批聚合收到 bash 与 read 两个并发工具调用");

			// 等待超过 70ms 触发第 1 个工具 holdTimeout 及后端主动断连第 2 个工具
			await new Promise((r) => setTimeout(r, 120));

			const bashTc = batchCalls.find((c) => c.name === "bash")!;
			const readTc = batchCalls.find((c) => c.name === "read")!;
			const step3Final = await coord
				.streamSimple(
					TEST_MODEL,
					normalizeContext({
						tools,
						messages: [
							{ role: "user", content: "TRIGGER_MCP_CONCURRENT_HOLD_DETACH", timestamp: 1 },
							step3,
							{
								role: "toolResult",
								toolCallId: bashTc.id,
								toolName: "bash",
								content: [{ type: "text", text: "RESULT_SLOW_ALPHA" }],
								isError: false,
								timestamp: 2,
							},
							{
								role: "toolResult",
								toolCallId: readTc.id,
								toolName: "read",
								content: [{ type: "text", text: "RESULT_SLOW_BETA" }],
								isError: false,
								timestamp: 3,
							},
						],
					}),
					{ sessionId: "pi-sess-hold-batch" },
				)
				.result();
			assert.equal(step3Final.stopReason, "stop");
			const out3 = step3Final.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			assert.ok(out3.includes("HAS_DETACHED_A=true"), `第 1 个超时工具结果应完整补发: ${out3}`);
			assert.ok(out3.includes("HAS_DETACHED_B=true"), `被后端连带断连的第 2 个工具结果不得丢失: ${out3}`);
		} finally {
			await coord.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});

const trafficRoot = process.env.PI_TRAFFIC_OPT_ROOT;
it("双仓联调：真实 Pi 对迟建轨迹库逐代计量，无快照时完整回传大结果并按请求回退", {
	skip: !trafficRoot && "设置 PI_TRAFFIC_OPT_ROOT 指向流量优化源码仓库",
	timeout: 15_000,
}, async (t) => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-joint-"));
	const agentDir = path.join(tmpRoot, "agent");
	const workspace = path.join(tmpRoot, "workspace");
	const reportDir = path.join(tmpRoot, "report");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(workspace);
	for (const [key, value] of Object.entries({
		PI_CODING_AGENT_DIR: agentDir,
		PI_AGY_BIN: writeMockAgyExecutable(tmpRoot, { seedTemplateDbOnNew: true, lazyConversationDb: true }),
		PI_AGY_GEMINI_DIR: path.join(tmpRoot, ".gemini"),
		PI_AGY_TOOL_MODE: "pi-tools",
		PI_AGY_BRIDGE_MCP: "false",
		PI_AGY_BRIDGE_SKILLS: "false",
		PI_AGY_BRIDGE_AGENTS_MD: "false",
		PI_TRAFFIC_OPT_CONFIG_PATH: path.join(tmpRoot, "traffic.json"),
		PI_TRAFFIC_OPT_ARCHIVE_DIR: path.join(tmpRoot, "archive"),
		PI_TRAFFIC_OPT_CACHE_DIR: path.join(tmpRoot, "cache"),
		PI_TRAFFIC_OPT_REPORT_DIR: reportDir,
	})) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
		await import("@earendil-works/pi-coding-agent");
	const settings = SettingsManager.inMemory({
		defaultTools: ["read", "context_recall"],
		compaction: { enabled: false },
		cacheWarming: "off",
		retry: { enabled: false },
	});
	const errors: string[] = [];
	const loader = new DefaultResourceLoader({
		cwd: workspace,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noContextFiles: true,
		noPromptTemplates: true,
		additionalExtensionPaths: [
			path.resolve(import.meta.dirname, "../src/index.ts"),
			path.resolve(trafficRoot!, "src/index.ts"),
		],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const runtime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"), modelsPath: null,
			modelsStorePath: path.join(agentDir, "models-store.json"),
			refreshOnCreate: false, allowModelNetwork: false,
		});
		({ session } = await createAgentSession({
			cwd: workspace, agentDir, resourceLoader: loader, modelRuntime: runtime,
			model: { ...TEST_MODEL }, thinkingLevel: "off",
			sessionManager: SessionManager.inMemory(workspace), settingsManager: settings,
		}));
		await session.bindExtensions({ onError: (error) => errors.push(error.error) });
		assert.ok(session.getActiveToolNames().includes("context_recall"));
		await session.prompt("TRIGGER_UPSTREAM_BATCH");
		assert.equal(session.getLastAssistantText(), "BATCH_COMPLETE");
		await session.prompt("/traffic-opt stats");
		assert.deepEqual(errors, []);
		const summary = JSON.parse(fs.readFileSync(path.join(reportDir, "summary.json"), "utf8"));
		assert.deepEqual(summary.requests.map((request: any) => request.transport), ["acp-upstream", "acp-upstream"]);
		assert.deepEqual(summary.requests.map((request: any) => request.user_text_bytes), [5, 35]);
		assert.deepEqual(summary.requests.map((request: any) => request.context_tokens), [null, 100]);

		const largeText = "HEAD_MARKER_ALPHA\n" + "中文回传测试 0123456789\n".repeat(450) + "TAIL_MARKER_ZETA\n";
		fs.writeFileSync(path.join(workspace, "large.ts"), largeText);
		await session.prompt("TRIGGER_MCP_LARGE_TEXT");
		assert.match(session.getLastAssistantText() ?? "", /HAS_HEAD=true.*HAS_TAIL=true/);
		await session.prompt("/traffic-opt stats");
		const fallback = JSON.parse(fs.readFileSync(path.join(reportDir, "summary.json"), "utf8"));
		const localRequests = fallback.requests.slice(2);
		assert.deepEqual(localRequests.map((request: any) => request.transport), ["acp-stdio", "acp-mcp-result", "acp-stdio"]);
		assert.equal(localRequests[1].tool_result_bytes, 0, "延迟投递的正文由 ACP prompt 计量");
		assert.ok(localRequests[2].tool_result_bytes >= Buffer.byteLength(largeText.trimEnd()));
		assert.equal(fallback.acp_local_payload_bytes, localRequests.reduce((total: number, request: any) => total + request.total_payload_bytes, 0));
		assert.equal(fallback.observed_upload_bytes, summary.total_upload_bytes);

		await session.prompt("TRIGGER_UPSTREAM_PARTIAL_BATCH");
		assert.equal(session.getLastAssistantText(), "BATCH_COMPLETE");
		await session.prompt("/traffic-opt stats");
		assert.deepEqual(errors, []);
		const partial = JSON.parse(fs.readFileSync(path.join(reportDir, "summary.json"), "utf8"));
		const newRequests = partial.requests.slice(fallback.request_count);
		assert.deepEqual(newRequests.map((request: any) => request.transport), ["acp-upstream", "acp-stdio"]);
		assert.deepEqual(newRequests.map((request: any) => request.user_text_bytes), [5, Buffer.byteLength("Continue from where you left off.")]);
		assert.deepEqual(newRequests.map((request: any) => request.context_tokens), [null, 100]);
	} finally {
		try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
		finally {
			session?.dispose();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	}
});
