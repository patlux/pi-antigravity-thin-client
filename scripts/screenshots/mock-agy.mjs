#!/usr/bin/env node
/**
 * Scripted stand-in for `agy acp`, used only to take README screenshots.
 *
 * It speaks enough ACP for the bridge and writes the same local files agy 1.5.13
 * writes below `<gemini dir>/antigravity-cli/brain/<conversation>/.system_generated/`
 * (transcript, task notes, task logs, subagent records). Nothing here reaches
 * Antigravity or a Google account. Each prompt picks a scenario by keyword.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const MAIN_MODEL = "gemini-4-neon-high";
const FLASH_MODEL = "gemini-3.8-flash-low";

const argv = process.argv.slice(2);
const geminiDirIndex = argv.indexOf("--gemini-dir");
const geminiDir =
	geminiDirIndex >= 0 ? argv[geminiDirIndex + 1] : path.join(process.env.HOME ?? ".", ".gemini");
const brainRoot = path.join(geminiDir, "antigravity-cli", "brain");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isoSeconds = (date) => date.toISOString().replace(/\.\d+Z$/, "Z");

function send(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function update(sessionId, payload) {
	send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: payload } });
}

async function stream(sessionId, kind, text, chunk = 24, delayMs = 25) {
	for (let i = 0; i < text.length; i += chunk) {
		update(sessionId, { sessionUpdate: kind, content: { type: "text", text: text.slice(i, i + chunk) } });
		await sleep(delayMs);
	}
}

/** One agy conversation and its files. */
class Conversation {
	constructor(id = crypto.randomUUID()) {
		this.id = id;
		this.dir = path.join(brainRoot, id, ".system_generated");
		this.nextStep = 0;
		for (const sub of ["logs", "messages", "tasks", "subagents"]) {
			fs.mkdirSync(path.join(this.dir, sub), { recursive: true });
		}
	}

	write(step, date = new Date()) {
		const index = this.nextStep++;
		const line = { step_index: index, source: "MODEL", status: "DONE", created_at: isoSeconds(date), ...step };
		fs.appendFileSync(path.join(this.dir, "logs", "transcript.jsonl"), `${JSON.stringify(line)}\n`);
		return index;
	}

	userInput(text) {
		return this.write({ source: "USER_EXPLICIT", type: "USER_INPUT", content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` });
	}

	planner({ text = "", calls = [], model = MAIN_MODEL } = {}) {
		const toolCalls = calls.map((call) => ({
			name: call.name,
			args: Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, JSON.stringify(value)])),
		}));
		return this.write({ type: "PLANNER_RESPONSE", model, content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
	}

	generic(content) {
		return this.write({ type: "GENERIC", content });
	}

	/** A tool call that went to the background: `task-<step>`. */
	startTask(description) {
		const taskId = `task-${this.nextStep}`;
		fs.writeFileSync(path.join(this.dir, "tasks", `${taskId}.log`), "");
		this.write({
			type: "GENERIC",
			status: "RUNNING",
			content: `Tool is running as a background task with task id: ${this.id}/${taskId}\nTask Description: ${description}\nTask logs are available at: file://${this.dir}/tasks/${taskId}.log`,
		});
		return taskId;
	}

	log(taskId, line) {
		fs.appendFileSync(path.join(this.dir, "tasks", `${taskId}.log`), `${line}\r\n`);
	}

	/** Delivers a note: a `messages/*.json` file plus the step agy records when it wakes up. */
	deliver({ sender, title, content }) {
		const now = new Date();
		const id = crypto.randomUUID();
		fs.writeFileSync(
			path.join(this.dir, "messages", `${id}.json`),
			JSON.stringify({
				id,
				recipient: this.id,
				sender,
				priority: "MESSAGE_PRIORITY_HIGH",
				timestamp: now.toISOString(),
				renderDetails: { messageTitle: title },
				content,
			}),
		);
		this.write(
			{
				source: "SYSTEM",
				type: "SYSTEM_MESSAGE",
				content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${isoSeconds(now)} sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${content}\n</SYSTEM_MESSAGE>`,
			},
			now,
		);
	}
}

const sessions = new Map();

function promptText(prompt) {
	return (prompt ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function finish(id, usage = { inputTokens: 18_000, cachedReadTokens: 14_000, outputTokens: 220, thoughtTokens: 60 }) {
	send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage } });
}

async function scenarioRelease(sid, conv, requestId) {
	await stream(sid, "agent_thought_chunk", "The release build takes a few minutes, so I'll run it in the background.");
	const command = "make release";
	conv.planner({ calls: [{ name: "run_command", args: { CommandLine: command, WaitMsBeforeAsync: 5000, toolSummary: "Build and publish the release" } }] });
	update(sid, {
		sessionUpdate: "tool_call",
		toolCallId: "call_release",
		name: "run_command",
		title: command,
		kind: "execute",
		status: "in_progress",
		rawInput: { CommandLine: command, WaitMsBeforeAsync: 5000, toolSummary: "Build and publish the release" },
	});
	await sleep(1200);
	const taskId = conv.startTask(command);
	update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_release", status: "completed", kind: "execute", title: command });
	await stream(sid, "agent_message_chunk", `The release build runs in the background (${taskId}). I'll report back when it is done.`);
	conv.planner({ text: `The release build runs in the background (${taskId}). I'll report back when it is done.` });
	finish(requestId);

	const steps = [
		"[+] Building 3.1s (4/12)",
		"=> [build 2/6] RUN npm ci",
		"=> [build 3/6] RUN npm run typecheck",
		"=> [build 4/6] RUN npm test -- --reporter=dot",
		"=> [build 5/6] RUN npm run bundle",
		"=> [build 6/6] RUN npm pack",
		"Uploading app-1.4.0.tgz … 100%",
		"Published app@1.4.0",
	];
	for (const line of steps) {
		conv.log(taskId, line);
		await sleep(2500);
	}
	conv.deliver({
		sender: `${conv.id}/${taskId}`,
		title: "Build and publish the release finished",
		content: `Task id "${conv.id}/${taskId}" finished with result:\nCommand exited with code 0.\n\nCommand output:\nPublished app@1.4.0`,
	});
	// agy >= 1.5.10 streams the turn it takes on its own right away.
	update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_release", status: "completed", kind: "execute", title: command });
	await stream(sid, "agent_thought_chunk", "The build is done. Let me check the health endpoint.");
	const check = "curl -fsS https://app.example.com/health";
	conv.planner({ calls: [{ name: "run_command", args: { CommandLine: check, toolSummary: "Check the health endpoint" } }] });
	update(sid, { sessionUpdate: "tool_call", toolCallId: "call_health", name: "run_command", title: check, kind: "execute", status: "in_progress", rawInput: { CommandLine: check } });
	await sleep(4000);
	conv.generic('Command exited with code 0.\n\nCommand output:\n{"status":"ok","version":"1.4.0"}');
	update(sid, {
		sessionUpdate: "tool_call_update",
		toolCallId: "call_health",
		status: "completed",
		kind: "execute",
		title: check,
		content: [{ type: "content", content: { type: "text", text: '{"status":"ok","version":"1.4.0"}' } }],
	});
	const answer =
		"Release **1.4.0** is built and published (`make release`, exit 0). The health check reports `ok` with version 1.4.0.";
	await stream(sid, "agent_message_chunk", answer);
	conv.planner({ text: answer });
}

async function scenarioTimer(sid, conv, requestId) {
	await stream(sid, "agent_thought_chunk", "I'll set a background timer and get back to you.");
	conv.planner({ calls: [{ name: "schedule", args: { DurationSeconds: 20, Prompt: "Remind the user about the coffee." } }] });
	update(sid, {
		sessionUpdate: "tool_call",
		toolCallId: "call_timer",
		name: "schedule",
		title: "Run schedule",
		kind: "other",
		status: "in_progress",
		rawInput: { DurationSeconds: 20, Prompt: "Remind the user about the coffee." },
	});
	await sleep(800);
	const taskId = conv.startTask("Timer: 20s, Prompt: Remind the user about the coffee.");
	update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_timer", status: "completed", kind: "other", title: "Run schedule" });
	await stream(sid, "agent_message_chunk", "The 20-second timer is running. I'll tell you when it expires.");
	conv.planner({ text: "The 20-second timer is running. I'll tell you when it expires." });
	finish(requestId);

	await sleep(20_000);
	conv.deliver({ sender: `${conv.id}/${taskId}`, title: "20s timer: Timer has expired", content: "Remind the user about the coffee." });
	update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_timer", status: "completed", kind: "other", title: "Run schedule" });
	const answer = "☕ Time's up: your coffee is ready.";
	await stream(sid, "agent_message_chunk", answer);
	conv.planner({ text: answer });
}

/** A subagent conversation that works step by step and reports to its parent. */
async function runSubagent(parent, child, { model, steps, report }) {
	child.write({
		source: "SYSTEM",
		type: "SYSTEM_MESSAGE",
		content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${isoSeconds(new Date())} sender=${parent.id} priority=MESSAGE_PRIORITY_HIGH content=brief\n</SYSTEM_MESSAGE>`,
	});
	for (const step of steps) {
		await sleep(step.wait ?? 3000);
		child.planner({ calls: [step.call], model });
		await sleep(step.duration ?? 2500);
		child.generic(step.result ?? "done");
	}
	await sleep(2000);
	child.planner({ calls: [{ name: "send_message", args: { Recipient: parent.id, Message: report } }], model });
	await sleep(1000);
	child.generic("Message sent");
	child.planner({ text: report.split("\n")[0], model });
}

async function scenarioSubagents(sid, conv, requestId) {
	await stream(sid, "agent_thought_chunk", "Two independent checks, so I'll split them across two subagents.");
	const reviewer = new Conversation();
	const linker = new Conversation();
	const specs = [
		{
			id: "call_spawn_reviewer",
			child: reviewer,
			args: {
				Prompt: "Check the entries under `## Unreleased` in CHANGELOG.md against the commits since v1.3.0. Report missing or wrong entries with send_message.",
				Role: "Changelog Reviewer",
				TypeName: "self",
			},
		},
		{
			id: "call_spawn_links",
			child: linker,
			args: {
				Prompt: "Check all links in README.md and docs/ and report broken ones with send_message.",
				Role: "Link Checker",
				TypeName: "self",
				Model: "flash",
			},
		},
	];
	conv.planner({ calls: specs.map((spec) => ({ name: "invoke_subagent", args: spec.args })) });
	for (const spec of specs) {
		update(sid, {
			sessionUpdate: "tool_call",
			toolCallId: spec.id,
			name: "invoke_subagent",
			title: "Run invoke_subagent",
			kind: "other",
			status: "in_progress",
			rawInput: spec.args,
		});
	}
	await sleep(600);
	for (const spec of specs) {
		const spawnStep = conv.generic(
			`Created the following subagent:\n{\n  "conversationId":  "${spec.child.id}"\n}\nThe subagent will send you a message when it has completed its task.`,
		);
		fs.writeFileSync(
			path.join(conv.dir, "subagents", `${spec.child.id}.json`),
			JSON.stringify({
				conversationId: spec.child.id,
				subagentDescriptor: { typeName: spec.args.TypeName, role: spec.args.Role },
				state: "SUBAGENT_STATE_ALIVE",
				spawnStepIndex: spawnStep,
			}),
		);
		update(sid, { sessionUpdate: "tool_call_update", toolCallId: spec.id, status: "completed", kind: "other", title: "Run invoke_subagent" });
	}
	const started = "Both subagents are running. I'll report back when their results are in.";
	await stream(sid, "agent_message_chunk", started);
	conv.planner({ text: started });
	finish(requestId);

	const reviewerReport = "The changelog is missing the entry for the token rotation fix (a1b2c3d); all other entries match.";
	const linkReport = "All 48 links are reachable.";
	await Promise.all([
		runSubagent(conv, reviewer, {
			model: MAIN_MODEL,
			report: reviewerReport,
			steps: [
				{ call: { name: "read_file", args: { Path: "CHANGELOG.md" } } },
				{ call: { name: "run_command", args: { CommandLine: "git log --oneline v1.3.0..HEAD", toolSummary: "List commits since v1.3.0" } } },
				{ call: { name: "grep_search", args: { Query: "token rotation" } }, duration: 4000 },
			],
		}),
		runSubagent(conv, linker, {
			model: FLASH_MODEL,
			report: linkReport,
			steps: [
				{ call: { name: "read_file", args: { Path: "README.md" } }, wait: 2000 },
				{ call: { name: "run_command", args: { CommandLine: "npx linkinator README.md docs --recurse", toolSummary: "Check links" } }, duration: 6000 },
			],
		}).then(async () => {
			conv.deliver({ sender: linker.id, title: "Message from Link Checker (self)", content: linkReport });
			const note = "The Link Checker is done: all links are reachable. Still waiting for the Changelog Reviewer.";
			await stream(sid, "agent_message_chunk", note);
			conv.planner({ text: note });
		}),
	]);
	await sleep(1500);
	conv.deliver({ sender: reviewer.id, title: "Message from Changelog Reviewer (self)", content: reviewerReport });
	await stream(sid, "agent_thought_chunk", "Both results are in.");
	conv.planner({ calls: [{ name: "edit_file", args: { TargetFile: "CHANGELOG.md" } }] });
	update(sid, { sessionUpdate: "tool_call", toolCallId: "call_changelog", name: "edit_file", title: "Edit CHANGELOG.md", kind: "edit", status: "in_progress" });
	await sleep(1500);
	conv.generic("Made 1 replacement in CHANGELOG.md");
	update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_changelog", status: "completed", kind: "edit", title: "Edit CHANGELOG.md" });
	const summary =
		"Both checks are done:\n\n- **Links:** all 48 reachable.\n- **Changelog:** the entry for the token rotation fix was missing; I added it under `## Unreleased`.";
	await stream(sid, "agent_message_chunk", summary);
	conv.planner({ text: summary });
}

async function scenarioTests(sid, conv, requestId) {
	await stream(sid, "agent_thought_chunk", "I'll run the test suite and wait for the result.");
	const command = "npm test";
	conv.planner({ calls: [{ name: "run_command", args: { CommandLine: command, toolSummary: "Run the test suite" } }] });
	update(sid, { sessionUpdate: "tool_call", toolCallId: "call_tests", name: "run_command", title: command, kind: "execute", status: "in_progress", rawInput: { CommandLine: command } });
	await sleep(9000);
	const output = "# tests 90\n# pass 68\n# fail 0\n# skipped 22";
	conv.generic(`Command exited with code 0.\n\nCommand output:\n${output}`);
	update(sid, {
		sessionUpdate: "tool_call_update",
		toolCallId: "call_tests",
		status: "completed",
		kind: "execute",
		title: command,
		content: [{ type: "content", content: { type: "text", text: output } }],
	});
	const answer = "The test suite is green: 68 passed, 0 failed.";
	await stream(sid, "agent_message_chunk", answer);
	conv.planner({ text: answer });
	finish(requestId);
}

async function scenarioFollowUp(sid, conv, requestId) {
	const answer = "There are **90 tests**: 68 passed, 22 skipped (features this fork turns off), none failed.";
	await stream(sid, "agent_message_chunk", answer);
	conv.planner({ text: answer });
	finish(requestId);
}

async function handlePrompt(msg) {
	const { sessionId, prompt } = msg.params;
	const conv = sessions.get(sessionId);
	const text = promptText(prompt);
	conv.userInput(text);
	const lower = text.toLowerCase();
	update(sessionId, { sessionUpdate: "usage_update", used: 18_000 + conv.nextStep * 900, size: 1_048_576 });
	if (lower.includes("release")) return scenarioRelease(sessionId, conv, msg.id);
	if (lower.includes("timer")) return scenarioTimer(sessionId, conv, msg.id);
	if (lower.includes("subagent")) return scenarioSubagents(sessionId, conv, msg.id);
	if (lower.includes("how many")) return scenarioFollowUp(sessionId, conv, msg.id);
	if (lower.includes("test")) return scenarioTests(sessionId, conv, msg.id);
	const answer = "Done.";
	await stream(sessionId, "agent_message_chunk", answer);
	conv.planner({ text: answer });
	finish(msg.id);
}

const MODEL_OPTIONS = [
	{ value: "gemini-4-neon", name: "Gemini 4 Neon" },
	{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
];

const rl = readline.createInterface({ input: process.stdin });
// Pi closed the pipe: stop pending scenario timers too.
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				protocolVersion: 1,
				agentCapabilities: { sessionCapabilities: { close: {}, load: {}, resume: {} }, _meta: { antigravity: { tier: true } } },
				agentInfo: { name: "agy (screenshot stand-in)", version: "1.5.13" },
			},
		});
		return;
	}
	if (msg.method === "session/new") {
		const conv = new Conversation();
		sessions.set(conv.id, conv);
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				sessionId: conv.id,
				configOptions: [
					{ id: "model", name: "Model", type: "select", currentValue: "gemini-4-neon", options: MODEL_OPTIONS },
					{
						id: "thought_level",
						name: "Thinking",
						type: "select",
						currentValue: "high",
						options: ["low", "medium", "high", "xhigh"].map((value) => ({ value, name: value })),
					},
					{ id: "mode", name: "Mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
				],
				_meta: { antigravity: { tier: { id: "ultra", name: "Google AI Ultra" } } },
			},
		});
		return;
	}
	if (msg.method === "session/prompt") {
		handlePrompt(msg).catch((error) => {
			send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(error) } });
		});
		return;
	}
	if (msg.id !== undefined && msg.method) {
		// set_config_option, close, cancel and the rest: accept.
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
	}
});
