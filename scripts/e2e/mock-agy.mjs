#!/usr/bin/env node
/**
 * Stand-in for `agy acp` for `resume.mjs`. It never talks to Antigravity or Google:
 * it answers ACP over stdio and keeps each conversation as an agy-shaped SQLite
 * database (`USER_INPUT` steps are type 14) plus a JSON history next to it, so a
 * conversation survives a Pi and mock restart. Every request goes to
 * `<PI_AGY_GEMINI_DIR>/calls.log` for the checks.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { DatabaseSync } from "node:sqlite";

const geminiDir = process.env.PI_AGY_GEMINI_DIR;
if (!geminiDir) throw new Error("PI_AGY_GEMINI_DIR missing");
const convDir = path.join(geminiDir, "antigravity-cli", "conversations");
fs.mkdirSync(convDir, { recursive: true });
const callsLog = path.join(geminiDir, "calls.log");

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (entry) => fs.appendFileSync(callsLog, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
const dbPath = (id) => path.join(convDir, `${id}.db`);
const historyPath = (id) => path.join(convDir, `${id}.history.json`);
const readHistory = (id) => (fs.existsSync(historyPath(id)) ? JSON.parse(fs.readFileSync(historyPath(id), "utf8")) : { cwd: "", items: [] });
const writeHistory = (id, h) => fs.writeFileSync(historyPath(id), JSON.stringify(h));

function createConversation(id) {
	const db = new DatabaseSync(dbPath(id));
	db.exec(`
		CREATE TABLE trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer);
		CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0);
		CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
		CREATE TABLE executor_metadata (idx integer PRIMARY KEY, data blob);
		CREATE TABLE parent_references (idx integer PRIMARY KEY, data blob);
		CREATE TABLE trajectory_metadata_blob (id text PRIMARY KEY DEFAULT "main", data blob);
	`);
	db.prepare("INSERT INTO trajectory_meta VALUES (?, ?, 4, 17)").run(id, id);
	db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(Buffer.from(`mock-meta:default-agy-agent:${id}`));
	db.close();
}

function appendSteps(id, types) {
	const db = new DatabaseSync(dbPath(id));
	const next = db.prepare("SELECT COALESCE(MAX(idx) + 1, 0) AS idx FROM steps").get().idx;
	types.forEach((type, i) => db.prepare("INSERT INTO steps (idx, step_type, status) VALUES (?, ?, 3)").run(next + i, type));
	const prompts = db.prepare("SELECT COUNT(*) AS n FROM steps WHERE step_type = 14").get().n;
	db.close();
	return prompts;
}

const CONFIG_OPTIONS = [
	{ id: "model", name: "Model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] },
	{ id: "thought_level", name: "Thinking", type: "select", currentValue: "high", options: ["low", "medium", "high"].map((value) => ({ value, name: value })) },
	{ id: "mode", name: "Mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
];
const sessionResult = (sessionId) => ({ sessionId, configOptions: CONFIG_OPTIONS, _meta: { antigravity: { tier: { id: "ultra", name: "Google AI Ultra" } } } });
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
/** Prompts agy is still working on, by conversation; `session/cancel` ends them. */
const runningPrompts = new Map();

const rl = readline.createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (!msg.method) return;
	const p = msg.params ?? {};
	const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
	const fail = (message) => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message } });

	switch (msg.method) {
		case "initialize":
			log({ method: msg.method, clientInfo: p.clientInfo });
			return reply({
				protocolVersion: 1,
				agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, load: {}, resume: {}, list: {} }, _meta: { antigravity: { tier: true } } },
				agentInfo: { name: "agy (resume e2e stand-in)", version: "1.5.13" },
			});
		case "session/new": {
			const id = crypto.randomUUID();
			createConversation(id);
			writeHistory(id, { cwd: p.cwd ?? "", items: [] });
			log({ method: msg.method, sessionId: id });
			return reply(sessionResult(id));
		}
		case "session/resume":
			log({ method: msg.method, sessionId: p.sessionId });
			if (!fs.existsSync(dbPath(p.sessionId))) return fail("no such conversation");
			return reply(sessionResult(p.sessionId));
		case "session/load": {
			log({ method: msg.method, sessionId: p.sessionId });
			if (!fs.existsSync(dbPath(p.sessionId))) return fail("no such conversation");
			for (const item of readHistory(p.sessionId).items) {
				update(p.sessionId, { sessionUpdate: item.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: item.text } });
			}
			return reply(sessionResult(p.sessionId));
		}
		case "session/list": {
			log({ method: msg.method });
			const sessions = fs.readdirSync(convDir)
				.filter((f) => f.endsWith(".history.json"))
				.map((f) => f.slice(0, -".history.json".length))
				.filter((id) => fs.existsSync(dbPath(id)) && readHistory(id).items.length > 0)
				.map((id) => ({ sessionId: id, cwd: readHistory(id).cwd, title: `mock conversation ${id.slice(0, 8)}`, updatedAt: new Date(fs.statSync(historyPath(id)).mtimeMs).toISOString() }));
			return reply({ sessions });
		}
		case "session/prompt": {
			const text = (p.prompt ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
			log({ method: msg.method, sessionId: p.sessionId, prompt: p.prompt });
			if (!fs.existsSync(dbPath(p.sessionId))) return fail("no such conversation");
			if (text.startsWith("run a tool and keep working")) {
				// agy runs one shell command, then keeps working until the client cancels.
				appendSteps(p.sessionId, [14, 21]);
				const h = readHistory(p.sessionId);
				h.items.push({ role: "user", text });
				writeHistory(p.sessionId, h);
				update(p.sessionId, { sessionUpdate: "tool_call", toolCallId: "mock-tool-1", title: "echo mock tool", kind: "execute", status: "pending", rawInput: { CommandLine: "echo mock tool" } });
				update(p.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "mock-tool-1", status: "completed", rawOutput: "MOCK TOOL OUTPUT" });
				runningPrompts.set(p.sessionId, msg.id);
				return;
			}
			const turn = appendSteps(p.sessionId, [14, 15]);
			const answer = `MOCK conv=${p.sessionId.slice(0, 8)} turn=${turn} heard: ${text}`;
			const h = readHistory(p.sessionId);
			h.items.push({ role: "user", text }, { role: "agent", text: answer });
			writeHistory(p.sessionId, h);
			update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } });
			return reply({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } });
		}
		case "session/cancel": {
			log({ method: msg.method, sessionId: p.sessionId });
			const running = runningPrompts.get(p.sessionId);
			if (running !== undefined) {
				runningPrompts.delete(p.sessionId);
				send({ jsonrpc: "2.0", id: running, result: { stopReason: "cancelled" } });
			}
			return;
		}
		default:
			log({ method: msg.method, sessionId: p.sessionId });
			if (msg.id !== undefined) reply({});
	}
});
