#!/usr/bin/env node
/**
 * Takes the README screenshots.
 *
 * Runs Pi with this extension against `mock-agy.mjs` in a detached tmux server of its
 * own, types the scripted prompts, captures the pane at the scripted moments and
 * renders each capture as PNG. Nothing reaches Antigravity: the mock stands in for
 * `agy` both as PI_AGY_BIN and as the first `agy` on PATH, and Pi runs with a
 * temporary home and `--offline`.
 *
 *   node scripts/screenshots/capture.mjs [--only <scenario|shot>[,…]] [--out <dir>] [--keep]
 *
 * Needs `pi` and `tmux` on PATH. PNG rendering uses `resvg` with fixed fonts (JetBrains
 * Mono NL, DejaVu Sans, Noto Color Emoji) and `oxipng`: from PATH and
 * SCREENSHOT_FONT_FILES (colon-separated), or else through `nix`. Without resvg and
 * fonts, SVG files are written instead.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ansiToSvg } from "./ansi-to-svg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const mockAgy = path.join(here, "mock-agy.mjs");
const SOCKET = "pi-agy-screenshots";
const COLS = 112;
const ROWS = 32;

const args = process.argv.slice(2);
const option = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const outDir = path.resolve(option("--out") ?? path.join(repo, "assets", "screenshots"));
const only = option("--only")?.split(",");
const keep = args.includes("--keep");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmux = (...rest) => execFileSync("tmux", ["-L", SOCKET, "-f", "/dev/null", ...rest], { encoding: "utf8" });
const succeeds = (command, commandArgs) => spawnSync(command, commandArgs, { stdio: "ignore" }).status === 0;

/**
 * Each scenario runs in a fresh Pi session. Steps: `send` types a line and presses
 * Enter, `waitFor` polls the plain pane text, `sleep` waits, `capture` saves a shot.
 * The mock picks its scenario by a keyword in the prompt (see mock-agy.mjs).
 */
const SCENARIOS = [
	{
		name: "release",
		rows: 34,
		steps: [
			{ send: "Build and publish release 1.4.0" },
			{ waitFor: /background task[\s\S]*npm test/, timeout: 30_000 },
			{ capture: "background-task" },
			{ waitFor: /working on its own\s+\d/, timeout: 40_000 },
			{ sleep: 1500 },
			{ capture: "own-turn-live" },
			{ waitFor: /reports `?ok/, timeout: 30_000 },
			{ sleep: 1500 },
			{ capture: "own-turn-card" },
		],
	},
	{
		name: "timer",
		steps: [
			{ send: "Set a 20 second timer and remind me about the coffee" },
			{ waitFor: /1[0-4] s left/, timeout: 30_000 },
			{ capture: "timer" },
			{ waitFor: /coffee is ready/, timeout: 40_000 },
		],
	},
	{
		name: "subagents",
		rows: 40,
		steps: [
			{ send: "Use two subagents: review the changelog and check all links" },
			{ waitFor: /2 subagents[\s\S]*(List commits|git log)/, timeout: 40_000 },
			{ sleep: 800 },
			{ capture: "subagents-live" },
			{ waitFor: /Both checks are done[\s\S]*Unreleased/, timeout: 60_000 },
			{ sleep: 1500 },
			{ capture: "subagents-done" },
		],
	},
	{
		name: "steering",
		steps: [
			{ send: "Run the test suite" },
			{ waitFor: /npm test/, timeout: 20_000 },
			{ sleep: 1500 },
			{ send: "How many tests are there in total?" },
			{ sleep: 1200 },
			{ capture: "steering-queued" },
			{ waitFor: /There are \S*90 tests/, timeout: 30_000 },
			{ sleep: 1500 },
			{ capture: "steering-sent" },
		],
	},
];

function plainPane(target) {
	return tmux("capture-pane", "-p", "-t", target);
}

async function waitFor(target, pattern, timeout) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (pattern.test(plainPane(target))) return;
		await sleep(250);
	}
	throw new Error(`timed out after ${timeout} ms waiting for ${pattern} in ${target}:\n${plainPane(target)}`);
}

/**
 * Temporary home for Pi. Its `bin/agy` is the mock, first on PATH: should PI_AGY_BIN
 * ever fail, the bridge's PATH lookup still finds the mock, never an installed agy.
 */
function makeHome() {
	// Real path, so Pi's footer shows the working directory as `~/projects/acme-app`.
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-screenshots-")));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const work = path.join(home, "projects", "acme-app");
	const bin = path.join(root, "bin");
	for (const dir of [agentDir, work, bin, path.join(root, "gemini")]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", quietStartup: true }));
	fs.symlinkSync(mockAgy, path.join(bin, "agy"));
	fs.accessSync(path.join(bin, "agy"), fs.constants.X_OK);
	return { root, home, agentDir, work, bin, gemini: path.join(root, "gemini") };
}

async function runScenario(scenario, env, captures) {
	const target = scenario.name;
	const rows = scenario.rows ?? ROWS;
	tmux(
		"new-session", "-d", "-s", target, "-x", String(COLS), "-y", String(rows), "-c", env.work,
		"env", "-i",
		`PATH=${env.bin}${path.delimiter}${process.env.PATH}`,
		`HOME=${env.home}`,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"LANG=en_US.UTF-8",
		`PI_CODING_AGENT_DIR=${env.agentDir}`,
		"PI_SKIP_VERSION_CHECK=1",
		`PI_AGY_BIN=${path.join(env.bin, "agy")}`,
		`PI_AGY_GEMINI_DIR=${env.gemini}`,
		"pi", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp",
		"-e", path.join(repo, "src", "index.ts"),
		"--model", "antigravity/gemini-4-neon:high",
	);
	try {
		// Ready once the footer names the model.
		await waitFor(target, /gemini-4-neon/, 30_000);
		await sleep(500);
		for (const step of scenario.steps) {
			if (step.send) {
				tmux("send-keys", "-t", target, "-l", step.send);
				await sleep(200);
				tmux("send-keys", "-t", target, "Enter");
			} else if (step.waitFor) {
				await waitFor(target, step.waitFor, step.timeout ?? 20_000);
			} else if (step.sleep) {
				await sleep(step.sleep);
			} else if (step.capture) {
				captures.push({ name: step.capture, ansi: tmux("capture-pane", "-e", "-N", "-p", "-t", target) });
				console.log(`captured ${step.capture}`);
			}
		}
	} finally {
		// Ctrl+D exits Pi when the editor is empty; Pi's exit ends the tmux session.
		for (let attempt = 0; attempt < 20 && succeeds("tmux", ["-L", SOCKET, "has-session", "-t", target]); attempt++) {
			tmux("send-keys", "-t", target, attempt % 2 === 0 ? "C-d" : "C-c");
			await sleep(500);
		}
	}
}

function nixPath(installable) {
	return execFileSync("nix", ["build", "--no-link", "--print-out-paths", installable], { encoding: "utf8" }).trim().split("\n")[0];
}

/** A tool from PATH, or else through `nix run`; undefined when neither has it. */
function tool(name, installable, hasNix) {
	if (succeeds(name, ["--version"])) return [name];
	return hasNix ? ["nix", "run", installable, "--"] : undefined;
}

/** Renders an SVG file to an optimized PNG; undefined without resvg or fonts. */
function pngRenderer() {
	const hasNix = succeeds("nix", ["--version"]);
	let fonts = process.env.SCREENSHOT_FONT_FILES?.split(path.delimiter).filter(Boolean);
	if (!fonts && hasNix) {
		const mono = path.join(nixPath("nixpkgs#jetbrains-mono"), "share", "fonts", "truetype");
		const dejavu = path.join(nixPath("nixpkgs#dejavu_fonts"), "share", "fonts", "truetype");
		// resvg falls back in this order. JetBrains Mono NL has no ligatures, like most
		// terminals. DejaVu brings single-width symbols (⚙, ✉) and the braille spinner in
		// text presentation, as a terminal shows them; Noto only the double-width emoji.
		fonts = [
			...["Regular", "Bold", "Italic", "BoldItalic"].map((style) => path.join(mono, `JetBrainsMonoNL-${style}.ttf`)),
			path.join(dejavu, "DejaVuSansMono.ttf"),
			path.join(dejavu, "DejaVuSans.ttf"),
			path.join(nixPath("nixpkgs#noto-fonts-color-emoji"), "share", "fonts", "noto", "NotoColorEmoji.ttf"),
		];
	}
	const resvg = tool("resvg", "nixpkgs#resvg", hasNix);
	if (!fonts || !resvg) return undefined;
	const oxipng = tool("oxipng", "nixpkgs#oxipng", hasNix);
	return (svgFile, pngFile) => {
		const fontArgs = fonts.flatMap((file) => ["--use-font-file", file]);
		const run = ([command, ...prefix], rest) => execFileSync(command, [...prefix, ...rest], { stdio: ["ignore", "ignore", "inherit"] });
		run(resvg, ["--skip-system-fonts", ...fontArgs, "--monospace-family", "JetBrains Mono NL", "--zoom", "2", svgFile, pngFile]);
		if (oxipng) run(oxipng, ["-o", "4", "--strip", "safe", "-q", pngFile]);
	};
}

async function main() {
	if (succeeds("tmux", ["-L", SOCKET, "list-sessions"])) {
		throw new Error(`tmux server ${SOCKET} still has sessions from an earlier run`);
	}
	const selected = SCENARIOS.filter(
		(scenario) => !only || only.includes(scenario.name) || scenario.steps.some((step) => only.includes(step.capture)),
	);
	const env = makeHome();
	const captures = [];
	try {
		for (const scenario of selected) await runScenario(scenario, env, captures);
	} finally {
		if (!keep) fs.rmSync(env.root, { recursive: true, force: true });
	}

	fs.mkdirSync(outDir, { recursive: true });
	const render = pngRenderer();
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-screenshots-svg-"));
	for (const capture of captures) {
		const svg = ansiToSvg(capture.ansi, { cols: COLS, title: "pi · antigravity", trimTop: true });
		const svgFile = path.join(render ? scratch : outDir, `${capture.name}.svg`);
		fs.writeFileSync(svgFile, svg);
		if (keep) fs.writeFileSync(path.join(scratch, `${capture.name}.ansi`), capture.ansi);
		if (render) {
			render(svgFile, path.join(outDir, `${capture.name}.png`));
			console.log(`wrote ${path.join(outDir, `${capture.name}.png`)}`);
		} else {
			console.log(`wrote ${svgFile} (no resvg or fonts: PNG skipped)`);
		}
	}
	if (keep) console.log(`kept ${env.root} and ${scratch}`);
	else fs.rmSync(scratch, { recursive: true, force: true });
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
