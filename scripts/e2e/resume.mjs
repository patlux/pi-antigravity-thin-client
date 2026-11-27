#!/usr/bin/env node
/**
 * End-to-end check for continuing Antigravity conversations in the real Pi.
 *
 * Runs Pi with this extension against `mock-agy.mjs` in a detached tmux server of its
 * own and a temporary home, types the scripted prompts and checks Pi's screen and the
 * ACP requests the mock received. Nothing reaches Antigravity: the mock is
 * PI_AGY_BIN and the only `agy` on PATH (PATH holds just the mock and links to
 * `pi`, `node` and `tmux`), and Pi runs with `--offline` and without user extensions.
 *
 *   node scripts/e2e/resume.mjs [--extension <path to src/index.ts>] [--keep]
 *
 * `--extension` runs an older checkout, e.g. to show a regression. Needs `pi`, `node`
 * and `tmux` on PATH.
 *
 * Scenario: a first prompt; Pi quits; Antigravity works on its own (a background step
 * ends, a message wakes it, it answers); `pi --continue` and the next prompt must
 * reattach with `session/resume` and send only the typed text. Then a forked Pi
 * session must refuse after the original went on, and `/agy sessions` must import
 * the conversation and continue it. Last, a new Pi session stops a turn after agy
 * ran a tool; the next prompt must go on in the same agy conversation.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const SOCKET = "pi-agy-resume-e2e";

const args = process.argv.slice(2);
const option = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const extension = path.resolve(option("--extension") ?? path.join(repo, "src", "index.ts"));
const keep = args.includes("--keep");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmux = (...rest) => execFileSync("tmux", ["-L", SOCKET, "-f", "/dev/null", ...rest], { encoding: "utf8" });
const hasSession = (target) => spawnSync("tmux", ["-L", SOCKET, "has-session", "-t", target], { stdio: "ignore" }).status === 0;
const which = (command, PATH) => {
	const result = spawnSync("/usr/bin/which", [command], { encoding: "utf8", env: { PATH } });
	return result.status === 0 ? result.stdout.trim() : undefined;
};

/** Temporary home whose PATH has only the mock as `agy` and links to the real tools. */
function makeHome() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-resume-e2e-")));
	const env = {
		root,
		home: path.join(root, "home"),
		agentDir: path.join(root, "home", ".pi", "agent"),
		work: path.join(root, "home", "projects", "demo"),
		bin: path.join(root, "bin"),
		gemini: path.join(root, "gemini"),
	};
	for (const dir of [env.agentDir, env.work, env.bin, env.gemini]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(env.agentDir, "settings.json"), JSON.stringify({ theme: "dark", quietStartup: true }));
	fs.symlinkSync(path.join(here, "mock-agy.mjs"), path.join(env.bin, "agy"));
	for (const tool of ["pi", "node", "tmux"]) {
		const found = which(tool, process.env.PATH);
		if (!found) throw new Error(`${tool} not found on PATH`);
		fs.symlinkSync(found, path.join(env.bin, tool));
	}
	env.PATH = [env.bin, "/usr/bin", "/bin"].join(path.delimiter);
	assert.equal(which("agy", env.PATH), path.join(env.bin, "agy"), "only the mock may be agy");
	return env;
}

const env = makeHome();
const callsLog = path.join(env.gemini, "calls.log");
const calls = () =>
	fs.existsSync(callsLog)
		? fs.readFileSync(callsLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
		: [];
const prompts = (since) => calls().slice(since).filter((call) => call.method === "session/prompt");
const conversationDb = (id) => path.join(env.gemini, "antigravity-cli", "conversations", `${id}.db`);

let piCount = 0;
async function startPi(extraArgs) {
	const target = `pi${++piCount}`;
	tmux(
		"new-session", "-d", "-s", target, "-x", "120", "-y", "40", "-c", env.work,
		"env", "-i", `PATH=${env.PATH}`, `HOME=${env.home}`, "TERM=xterm-256color", "LANG=en_US.UTF-8",
		`PI_CODING_AGENT_DIR=${env.agentDir}`, "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0",
		`PI_AGY_BIN=${path.join(env.bin, "agy")}`, `PI_AGY_GEMINI_DIR=${env.gemini}`,
		"pi", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp",
		"-e", extension, "--model", "antigravity/gemini-4-neon:high", ...extraArgs,
	);
	// Ready once the footer names the model.
	await waitFor(target, /gemini-4-neon/, 30_000);
	await sleep(800);
	return target;
}

const pane = (target) => tmux("capture-pane", "-p", "-J", "-S", "-200", "-t", target);
async function waitFor(target, pattern, timeout = 20_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (pattern.test(pane(target))) return;
		await sleep(200);
	}
	throw new Error(`timed out after ${timeout} ms waiting for ${pattern} in ${target}:\n${pane(target)}`);
}
async function type(target, text) {
	tmux("send-keys", "-t", target, "-l", text);
	await sleep(200);
	tmux("send-keys", "-t", target, "Enter");
}
async function quit(target) {
	// Ctrl+D exits Pi when the editor is empty; Pi's exit ends the tmux session.
	for (let attempt = 0; attempt < 20 && hasSession(target); attempt++) {
		tmux("send-keys", "-t", target, attempt % 2 === 0 ? "C-d" : "C-c");
		await sleep(500);
	}
	assert.ok(!hasSession(target), `${target} did not exit`);
	await sleep(500);
}
function sessionFiles() {
	const dir = path.join(env.agentDir, "sessions");
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { recursive: true })
		.map(String)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => path.join(dir, file));
}
function show(label, target) {
	const lines = pane(target).split("\n").filter((line) => line.trim());
	console.log(`\n----- ${label} -----\n${lines.slice(-14).join("\n")}`);
}

const results = [];
function check(name, fn) {
	try {
		fn();
		results.push(`PASS ${name}`);
	} catch (error) {
		results.push(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
	}
}
const typedPrompt = (text) => [[{ type: "text", text }]];
const promptsSent = (since) => prompts(since).map((call) => call.prompt);

async function main() {
	if (spawnSync("tmux", ["-L", SOCKET, "list-sessions"], { stdio: "ignore" }).status === 0) {
		throw new Error(`tmux server ${SOCKET} still has sessions from an earlier run`);
	}

	// 1. A new Pi session and its first prompt.
	let target = await startPi([]);
	let mark = calls().length;
	await type(target, "first question alpha");
	await waitFor(target, /turn=1 heard: first question alpha/);
	show("1: first prompt", target);
	const conversationId = prompts(mark)[0]?.sessionId;
	assert.ok(conversationId, "the first prompt reached the mock");
	check("1 sends only the typed prompt", () => assert.deepEqual(promptsSent(mark), typedPrompt("first question alpha")));
	await quit(target);
	const [originalFile] = sessionFiles();
	check("1 stores the anchor in the Pi session", () =>
		assert.match(fs.readFileSync(originalFile, "utf8"), /antigravity-acp-state/));

	// 2. Pi is closed; Antigravity goes on by itself: a background step ends, its
	//    message wakes agy (SYSTEM_MESSAGE, 101) and agy answers (PLANNER_RESPONSE, 15).
	const db = new DatabaseSync(conversationDb(conversationId));
	try {
		db.exec("UPDATE steps SET status = 2 WHERE idx = 1");
		const next = db.prepare("SELECT MAX(idx) + 1 AS next FROM steps").get().next;
		db.prepare("INSERT INTO steps (idx, step_type, status) VALUES (?, 101, 3), (?, 15, 3)").run(next, next + 1);
	} finally {
		db.close();
	}

	// 3. `pi --continue`: nothing goes out until the user types; then the same conversation.
	target = await startPi(["--continue"]);
	mark = calls().length;
	await sleep(1500);
	check("3 sends nothing before the user types", () => assert.equal(prompts(mark).length, 0));
	await type(target, "second question beta");
	await waitFor(target, /turn=2 heard: second question beta|refusing/);
	show("3: pi --continue", target);
	check("3 reattaches to the same agy conversation", () => {
		assert.ok(
			calls().slice(mark).some((call) => call.method === "session/resume" && call.sessionId === conversationId),
			"session/resume on the conversation",
		);
		assert.equal(prompts(mark)[0]?.sessionId, conversationId);
	});
	check("3 sends only the typed prompt", () => assert.deepEqual(promptsSent(mark), typedPrompt("second question beta")));
	await quit(target);

	// 4. Fork the Pi session, go on in the original, then try the fork.
	target = await startPi(["--fork", originalFile]);
	await quit(target);
	const forkFile = sessionFiles().find((file) => file !== originalFile);
	assert.ok(forkFile, "pi --fork wrote a session file");
	target = await startPi(["--session", originalFile]);
	mark = calls().length;
	await type(target, "third question gamma");
	await waitFor(target, /turn=3 heard: third question gamma|refusing/);
	show("4: the original goes on", target);
	check("4 the original continues the conversation", () => assert.equal(prompts(mark)[0]?.sessionId, conversationId));
	await quit(target);
	target = await startPi(["--session", forkFile]);
	mark = calls().length;
	await type(target, "fork question delta");
	await waitFor(target, /refusing|heard: fork question delta/);
	await sleep(1500);
	show("4: the fork after the original went on", target);
	check("4 the fork refuses with the divergence message", () =>
		assert.match(pane(target), /refusing to continue from this point/));
	check("4 the fork sends nothing to agy", () => assert.equal(prompts(mark).length, 0));
	check("4 Pi does not retry the refusal", () => assert.doesNotMatch(pane(target), /retrying/i));
	await quit(target);

	// 5. `/agy sessions`: import the conversation into a new Pi session and continue it.
	target = await startPi([]);
	await type(target, "/agy sessions");
	await sleep(1000);
	// The first Enter may only accept the command autocomplete.
	if (!/mock conversation/.test(pane(target))) tmux("send-keys", "-t", target, "Enter");
	await waitFor(target, /mock conversation/);
	show("5: /agy sessions", target);
	tmux("send-keys", "-t", target, "Enter");
	await waitFor(target, /Imported session/);
	mark = calls().length;
	await type(target, "imported question epsilon");
	await waitFor(target, /heard: imported question epsilon|refusing/);
	show("5: the imported conversation goes on", target);
	check("5 the imported conversation continues in agy", () => {
		assert.ok(calls().slice(mark).some((call) => call.method === "session/resume" && call.sessionId === conversationId));
		assert.equal(prompts(mark)[0]?.sessionId, conversationId);
		assert.match(pane(target), /turn=4 heard: imported question epsilon/);
	});
	check("5 sends only the typed prompt", () => assert.deepEqual(promptsSent(mark), typedPrompt("imported question epsilon")));
	await quit(target);

	// 6. Stop a turn after agy ran a tool (Esc), then send the next prompt.
	target = await startPi([]);
	mark = calls().length;
	await type(target, "run a tool and keep working zeta");
	await waitFor(target, /MOCK TOOL OUTPUT/);
	await sleep(800);
	tmux("send-keys", "-t", target, "Escape");
	const stoppedConversation = prompts(mark)[0]?.sessionId;
	assert.ok(stoppedConversation, "the stopped prompt reached the mock");
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline && !calls().slice(mark).some((call) => call.method === "session/cancel")) await sleep(200);
	await sleep(1000);
	show("6: the stopped turn", target);
	const afterStop = calls().length;
	await type(target, "after stop eta");
	await waitFor(target, /heard: after stop eta|refusing/);
	show("6: the prompt after the stop", target);
	check("6 the stop cancels the agy turn", () =>
		assert.ok(calls().slice(mark, afterStop).some((call) => call.method === "session/cancel" && call.sessionId === stoppedConversation)));
	check("6 the next prompt continues the same agy conversation", () => {
		assert.doesNotMatch(pane(target), /refusing/);
		assert.ok(!calls().slice(afterStop).some((call) => call.method === "session/new"), "no new agy conversation");
		assert.equal(prompts(afterStop)[0]?.sessionId, stoppedConversation);
		assert.match(pane(target), /turn=2 heard: after stop eta/);
	});
	check("6 sends only the typed prompt", () => assert.deepEqual(promptsSent(afterStop), typedPrompt("after stop eta")));
	await quit(target);

	check("only the typed prompts reached agy", () =>
		assert.deepEqual(promptsSent(0), [
			...typedPrompt("first question alpha"),
			...typedPrompt("second question beta"),
			...typedPrompt("third question gamma"),
			...typedPrompt("imported question epsilon"),
			...typedPrompt("run a tool and keep working zeta"),
			...typedPrompt("after stop eta"),
		]));
}

try {
	await main();
} catch (error) {
	results.push(`FAIL run: ${error instanceof Error ? error.message : error}`);
} finally {
	const left = spawnSync("tmux", ["-L", SOCKET, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
	for (const target of (left.stdout ?? "").split("\n").filter(Boolean)) await quit(target).catch(() => {});
	const lines = calls().map((call) =>
		[call.pid, call.method, call.sessionId?.slice(0, 8), call.prompt ? JSON.stringify(call.prompt) : undefined]
			.filter((part) => part !== undefined)
			.join(" "));
	console.log(`\n===== ACP requests =====\n${lines.join("\n")}`);
	console.log(`\n===== results =====\n${results.join("\n")}`);
	if (keep) console.log(`kept ${env.root}`);
	else fs.rmSync(env.root, { recursive: true, force: true });
	if (results.some((line) => line.startsWith("FAIL"))) process.exitCode = 1;
}
