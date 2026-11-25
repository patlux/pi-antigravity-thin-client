#!/usr/bin/env node
/**
 * Install an exact package tarball outside the checkout and load it with a real Pi.
 *
 * Pi runs with a temporary home and a stub `agy` that only records that it was started,
 * so this check never reaches Antigravity or a Google account. Loading the extension and
 * listing its models must not start agy at all.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE = "pi-antigravity-thin-client";

const tarball = process.argv[2];
assert.ok(tarball?.endsWith(".tgz"), "Usage: node .github/scripts/package-smoke.mjs /path/package.tgz");
assert.notEqual(process.platform, "win32", "The package smoke test needs a POSIX shell for the stub agy");
const packagePath = resolve(tarball);
const temp = mkdtempSync(join(tmpdir(), "agy-thin-package-"));

function run(command, args, options) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
	return result.stdout;
}

try {
	const home = join(temp, "home");
	mkdirSync(home);
	const npmrc = join(temp, "npmrc");
	writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n", { mode: 0o600 });
	writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));

	const marker = join(temp, "agy-started");
	const stubAgy = join(temp, "agy");
	writeFileSync(stubAgy, `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`, { mode: 0o755 });

	// Only tool-discovery and OS variables: no npm tokens, Pi auth or developer extensions.
	const env = Object.fromEntries(
		["PATH", "TMPDIR", "LANG", "PI_BIN"]
			.filter((key) => process.env[key] !== undefined)
			.map((key) => [key, process.env[key]]),
	);
	Object.assign(env, {
		HOME: home,
		NPM_CONFIG_USERCONFIG: npmrc,
		NPM_CONFIG_CACHE: join(temp, "npm-cache"),
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		PI_SKIP_VERSION_CHECK: "1",
		PI_OFFLINE: "1",
		PI_AGY_BIN: stubAgy,
		TERM: "dumb",
	});

	run(
		"npm",
		["install", "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund", "--package-lock=false", packagePath],
		{ cwd: temp, env },
	);
	const installed = join(temp, "node_modules", PACKAGE);
	const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
	assert.equal(manifest.name, PACKAGE);
	const extensions = manifest.pi?.extensions;
	assert.ok(Array.isArray(extensions) && extensions.length > 0, "package declares no Pi extension");

	const pi = env.PI_BIN ?? "pi";
	const args = ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp"];
	for (const extension of extensions) args.push("-e", join(installed, extension));
	args.push("--list-models", "antigravity");
	const output = run(pi, args, { cwd: temp, env });

	assert.match(output, /^antigravity\s+\S+/m, `Pi listed no antigravity models:\n${output}`);
	assert.equal(existsSync(marker), false, "loading the extension must not start agy");
	console.log(`[package-smoke] PASS: ${manifest.name}@${manifest.version} loads in Pi and lists its models without starting agy`);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
