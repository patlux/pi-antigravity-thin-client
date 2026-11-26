import * as assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import type { ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { AgyTurnMirrorBroker, classifyAgyToolCall } from "../src/tools/agy-mirror-tools.ts";
import { getMirrorToolRenderers } from "../src/tools/agy-renderers.ts";
import { interactiveContext } from "./human-input.ts";

type RenderCallFn = NonNullable<ReturnType<typeof getMirrorToolRenderers>["renderCall"]>;
type RenderCallContext = Parameters<RenderCallFn>[2];

function makeUiContext(
	ui: Partial<ExtensionUIContext>,
	opts: { hasUI?: boolean; signal?: AbortSignal } = {},
): ExtensionContext {
	const stub = {
		hasUI: opts.hasUI ?? true,
		cwd: os.tmpdir(),
		signal: opts.signal,
		ui: {
			setStatus() {},
			...ui,
		},
	};
	const isCtx = (value: object): value is ExtensionContext => "hasUI" in value && "ui" in value;
	if (!isCtx(stub)) {
		throw new Error("invalid extension context stub");
	}
	return stub;
}

function makeTaggedTheme(): Theme {
	const impl = {
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
		bg(color: string, text: string) {
			return `[${color}]${text}[/${color}]`;
		},
		bold(text: string) {
			return `**${text}**`;
		},
	};
	const isTheme = (value: object): value is Theme => "fg" in value && "bold" in value;
	if (!isTheme(impl)) {
		throw new Error("invalid theme stub");
	}
	return impl;
}

function makeRenderCallContext(cwd = os.tmpdir()): RenderCallContext {
	const stub = {
		args: {},
		toolCallId: "tc-render-call",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		keyHint(_kb: string, desc: string) {
			return `<key:${desc}>`;
		},
	};
	const isCtx = (value: object): value is RenderCallContext => "cwd" in value && "keyHint" in value;
	if (!isCtx(stub)) {
		throw new Error("invalid render call context stub");
	}
	return stub;
}

describe("interaction_* interactive questions in handlePermissionRequest", () => {
	it("prompts with the question text directly without Approve: prefix and returns selected optionId", async () => {
		const broker = new AgyTurnMirrorBroker();
		let seenTitle: string | undefined;
		let seenOptions: string[] | undefined;

		broker.setFallbackUiContext(
			makeUiContext({
				async select(title, options) {
					seenTitle = title;
					seenOptions = [...options];
					return options[1];
				},
			}),
		);

		const result = await broker.handlePermissionRequest({
			sessionId: "sess-q",
			toolCall: {
				toolCallId: "interaction_9960062f",
				title: "Which result label should be used?",
			},
			options: [
				{ optionId: "1", name: "Verified", kind: "allow_once" },
				{ optionId: "2", name: "Needs review", kind: "allow_once" },
			],
		});

		assert.equal(seenTitle, "Which result label should be used?");
		assert.deepEqual(seenOptions, ["Verified", "Needs review"]);
		assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "2" } });
	});

	it("falls back to 'Choose an option' when interaction_* title is blank or missing", async () => {
		const broker = new AgyTurnMirrorBroker();
		const seenTitles: string[] = [];

		broker.setFallbackUiContext(
			makeUiContext({
				async select(title, options) {
					seenTitles.push(title);
					return options[0];
				},
			}),
		);

		await broker.handlePermissionRequest({
			sessionId: "sess-q",
			toolCall: { toolCallId: "interaction_blank", title: "   " },
			options: [{ optionId: "opt_1", name: "Go" }],
		});
		await broker.handlePermissionRequest({
			sessionId: "sess-q",
			toolCall: { toolCallId: "interaction_missing" },
			options: [{ optionId: "opt_2", name: "Stop" }],
		});

		assert.deepEqual(seenTitles, ["Choose an option", "Choose an option"]);
	});

	it("disambiguates duplicate option labels safely so index lookup never selects the wrong option", async () => {
		const broker = new AgyTurnMirrorBroker();
		let seenOptions: string[] = [];

		broker.setFallbackUiContext(
			makeUiContext({
				async select(_title, options) {
					seenOptions = [...options];
					// Pick the second duplicate option.
					return options[1];
				},
			}),
		);

		const result = await broker.handlePermissionRequest({
			sessionId: "sess-dup",
			toolCall: { toolCallId: "interaction_dup", title: "Pick an entry" },
			options: [
				{ optionId: "opt_a", name: "Continue" },
				{ optionId: "opt_b", name: "Continue" },
				{ optionId: "opt_c", name: "Continue (opt_a)" },
			],
		});

		assert.equal(new Set(seenOptions).size, 3);
		assert.equal(seenOptions[2], "Continue (opt_a)");
		assert.equal(seenOptions[1], "Continue (opt_b)");
		assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "opt_b" } });
	});

	it("does not append security warnings on interaction_* questions", async () => {
		const broker = new AgyTurnMirrorBroker();
		let seenOptions: string[] = [];

		broker.setFallbackUiContext(
			makeUiContext({
				async select(_title, options) {
					seenOptions = [...options];
					return options[0];
				},
			}),
		);

		const result = await broker.handlePermissionRequest({
			sessionId: "sess-q-warn",
			toolCall: { toolCallId: "interaction_warn", title: "Pick mode" },
			options: [
				{
					optionId: "fast",
					name: "Fast",
					_meta: { "agy.security.warning": { message: "Should not appear here" } },
				},
			],
		});

		assert.deepEqual(seenOptions, ["Fast"]);
		assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "fast" } });
	});
});

describe("permission security warnings and richer approval titles", () => {
	it("appends _meta['agy.security.warning'] to the matching approval option and bounds to <= 512 chars", async () => {
		const broker = new AgyTurnMirrorBroker();
		let seenOptions: string[] = [];

		broker.setFallbackUiContext(
			makeUiContext({
				async select(_title, options) {
					seenOptions = [...options];
					return options[0];
				},
			}),
		);

		const longWarning = `${"W".repeat(508)}🚀 extra details that must be truncated\nsecond line`;
		const res = await broker.handlePermissionRequest({
			sessionId: "sess-sec",
			toolCall: { toolCallId: "cmd-1", kind: "execute", title: "Run build" },
			options: [
				{
					optionId: "allow_always",
					name: "Allow always",
					kind: "allow_always",
					_meta: {
						"agy.security.warning": {
							title: "Risky",
							message: longWarning,
						},
					},
				},
				{
					optionId: "allow_title_only",
					name: "Allow host",
					kind: "allow_always",
					_meta: {
						"agy.security.warning": {
							title: "Title fallback warning",
						},
					},
				},
				{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
				{ optionId: "deny", name: "Deny", kind: "reject_once" },
			],
		});

		assert.deepEqual(res, { outcome: { outcome: "selected", optionId: "allow_always" } });
		assert.ok(seenOptions[0].startsWith("Allow always — Warning: "));
		const extractedWarning = seenOptions[0].slice("Allow always — Warning: ".length);
		assert.ok(extractedWarning.length <= 512, `expected <= 512, got ${extractedWarning.length}`);
		assert.ok(extractedWarning.endsWith("..."));
		assert.ok(!extractedWarning.includes("\n"));
		// High surrogate at boundary must not be left unpaired.
		assert.equal(/[\uD800-\uDBFF]$/.test(extractedWarning.slice(0, -3)), false);

		assert.equal(seenOptions[1], "Allow host — Warning: Title fallback warning");
		assert.equal(seenOptions[2], "Allow once");
		assert.equal(seenOptions[3], "Deny");
	});

	it("enriches missing or generic approval titles from tracked callState or rawInput in concise single-line form", async () => {
		const broker = new AgyTurnMirrorBroker();
		const seenTitles: string[] = [];

		broker.setFallbackUiContext(
			makeUiContext({
				async select(title, options) {
					seenTitles.push(title);
					return options[0];
				},
			}),
		);

		// 1. Tracked callState command enriches generic "Run command"
		broker.registerOrUpdateCall("sess-enrich", {
			toolCallId: "tc-cmd-tracked",
			kind: "execute",
			title: "Run command",
			status: "pending",
			rawInput: { CommandLine: "npm test\n--verbose" },
		});
		await broker.handlePermissionRequest({
			sessionId: "sess-enrich",
			toolCall: { toolCallId: "tc-cmd-tracked", title: "Run command" },
			options: [{ optionId: "allow", name: "Allow" }],
		});

		// 2. rawInput path enriches generic "Edit file"
		await broker.handlePermissionRequest({
			sessionId: "sess-enrich",
			toolCall: {
				toolCallId: "tc-edit-raw",
				title: "Edit file",
				kind: "edit",
				rawInput: { TargetFile: "/repo/src/app.ts" },
			},
			options: [{ optionId: "allow", name: "Allow" }],
		});

		// 3. Generic placeholder "Antigravity Tool" enriched via tracked path
		broker.registerOrUpdateCall("sess-enrich", {
			toolCallId: "tc-path-tracked",
			kind: "read",
			title: "Read file",
			status: "pending",
			locations: [{ path: "/repo/README.md" }],
		});
		await broker.handlePermissionRequest({
			sessionId: "sess-enrich",
			toolCall: { toolCallId: "tc-path-tracked", title: "Antigravity Tool" },
			options: [{ optionId: "allow", name: "Allow" }],
		});

		// 4. Missing title enriched via rawInput CommandLine
		await broker.handlePermissionRequest({
			sessionId: "sess-enrich",
			toolCall: {
				toolCallId: "tc-missing-title",
				rawInput: { command: "git status --short" },
			},
			options: [{ optionId: "allow", name: "Allow" }],
		});

		// 5. Non-generic title stays untouched
		await broker.handlePermissionRequest({
			sessionId: "sess-enrich",
			toolCall: { toolCallId: "tc-specific", title: "Run build" },
			options: [{ optionId: "allow", name: "Allow" }],
		});

		assert.deepEqual(seenTitles, [
			"Approve: Run command: npm test --verbose",
			"Approve: Edit file: /repo/src/app.ts",
			"Approve: /repo/README.md",
			"Approve: git status --short",
			"Approve: Run build",
		]);
	});
});

describe("complete elicitation/create form support", () => {
	it("supports oneOf titled options on string fields and returns const values", async () => {
		const broker = new AgyTurnMirrorBroker();
		let seenTitle = "";
		let seenOptions: string[] = [];

		broker.setFallbackUiContext(
			makeUiContext({
				async select(title, options) {
					seenTitle = title;
					seenOptions = [...options];
					return options[0];
				},
			}),
		);

		const res = await broker.handleElicitationRequest({
			sessionId: "sess-oneof",
			mode: "form",
			message: "1 question",
			requestedSchema: {
				type: "object",
				properties: {
					db: {
						type: "string",
						title: "Which database should we use?",
						oneOf: [
							{ const: "pg", title: "PostgreSQL", description: "Relational SQL" },
							{ const: "sqlite", title: "SQLite" },
						],
					},
				},
				required: ["db"],
			},
		});

		assert.equal(seenTitle, "Which database should we use?");
		assert.deepEqual(seenOptions, ["PostgreSQL — Relational SQL", "SQLite"]);
		assert.deepEqual(res, { action: "accept", content: { db: "pg" } });
	});

	it("supports array multi-select with items.anyOf, toggle loop, and minItems/maxItems enforcement", async () => {
		const broker = new AgyTurnMirrorBroker();
		const prompts: Array<{ title: string; options: string[] }> = [];
		const warnings: string[] = [];

		// Sequence of user actions:
		// 1. Click "Done (0 selected)" -> rejected because minItems = 2
		// 2. Toggle "[ ] TypeScript — Typed JS" ON
		// 3. Toggle "[ ] Rust" ON
		// 4. Try toggling "[ ] Go" ON -> blocked because maxItems = 2
		// 5. Toggle "[x] TypeScript — Typed JS" OFF
		// 6. Toggle "[ ] Go" ON (now Rust + Go = 2)
		// 7. Click "Done (2 selected)" -> succeeds!
		const script = [
			"Done (0 selected)",
			"[ ] TypeScript — Typed JS",
			"[ ] Rust",
			"[ ] Go",
			"[x] TypeScript — Typed JS",
			"[ ] Go",
			"Done (2 selected)",
		];
		let step = 0;

		broker.setFallbackUiContext(
			makeUiContext({
				notify(msg, level) {
					if (level === "warning") warnings.push(msg);
				},
				async select(title, options) {
					prompts.push({ title, options: [...options] });
					const next = script[step++];
					assert.ok(next !== undefined, `unexpected select call #${step}`);
					assert.ok(options.includes(next), `expected "${next}" in ${JSON.stringify(options)}`);
					return next;
				},
			}),
		);

		const res = await broker.handleElicitationRequest({
			sessionId: "sess-multi",
			mode: "form",
			message: "1 question",
			requestedSchema: {
				type: "object",
				properties: {
					langs: {
						type: "array",
						title: "Select 2 languages",
						minItems: 2,
						maxItems: 2,
						items: {
							anyOf: [
								{ const: "ts", title: "TypeScript", description: "Typed JS" },
								{ const: "rs", title: "Rust" },
								{ const: "go", title: "Go" },
							],
						},
					},
				},
				required: ["langs"],
			},
		});

		assert.deepEqual(res, { action: "accept", content: { langs: ["rs", "go"] } });
		assert.equal(prompts.length, 7);
		// Required with minItems = 2 must not offer "Skip".
		assert.equal(prompts[0].options.includes("Skip"), false);
		assert.equal(warnings.length, 2);
		assert.match(warnings[0], /at least 2/i);
		assert.match(warnings[1], /at most 2/i);
	});

	it("supports array multi-select with items.enum and Skip for optional or minItems=0 fields", async () => {
		const broker = new AgyTurnMirrorBroker();
		const seenMenus: string[][] = [];
		const responses = ["Skip", "Skip"];
		let idx = 0;

		broker.setFallbackUiContext(
			makeUiContext({
				async select(_title, options) {
					seenMenus.push([...options]);
					return responses[idx++];
				},
			}),
		);

		const res = await broker.handleElicitationRequest({
			sessionId: "sess-multi-skip",
			mode: "form",
			message: "Targets",
			requestedSchema: {
				type: "object",
				properties: {
					optionalTags: {
						type: "array",
						title: "Optional tags",
						minItems: 1,
						items: { type: "string", enum: ["alpha", "beta"] },
					},
					requiredZeroMin: {
						type: "array",
						title: "Extras",
						minItems: 0,
						items: { type: "string", enum: ["docs", "tests"] },
					},
				},
				required: ["requiredZeroMin"],
			},
		});

		assert.ok(seenMenus[0].includes("Skip"));
		assert.ok(seenMenus[1].includes("Skip"));
		// Optional field omitted; required minItems:0 field receives [].
		assert.deepEqual(res, { action: "accept", content: { requiredZeroMin: [] } });
	});

	it("folds optional <id>__other and <id>_other companions into one prompt and omits <id> when custom text is entered", async () => {
		const broker = new AgyTurnMirrorBroker();
		const selectPrompts: Array<{ title: string; options: string[] }> = [];
		const inputPrompts: string[] = [];

		let selectIdx = 0;
		const selectReplies = ["Other (enter custom text)", "Yes", "Other (enter custom text)"];
		let inputIdx = 0;
		const inputReplies = ["SQLite", "Only on Fridays"];

		broker.setFallbackUiContext(
			makeUiContext({
				async select(title, options) {
					selectPrompts.push({ title, options: [...options] });
					return selectReplies[selectIdx++];
				},
				async input(title) {
					inputPrompts.push(title);
					return inputReplies[inputIdx++];
				},
			}),
		);

		const res = await broker.handleElicitationRequest({
			sessionId: "sess-companion",
			mode: "form",
			message: "3 questions",
			requestedSchema: {
				type: "object",
				properties: {
					q0: {
						type: "string",
						title: "Which database?",
						oneOf: [
							{ const: "Postgres", title: "Postgres" },
							{ const: "MySQL", title: "MySQL" },
						],
					},
					q0__other: { type: "string", title: "Other database" },
					q1: {
						type: "string",
						title: "Deploy now?",
						enum: ["Yes", "No"],
					},
					q1__other: { type: "string", title: "Other schedule" },
					q2: {
						type: "string",
						title: "Notify channel?",
						enum: ["Slack", "Email"],
					},
					q2_other: { type: "string", title: "Other channel" },
				},
			},
		});

		// Companion fields were folded, so only 3 selects and 2 custom inputs ran.
		assert.equal(selectPrompts.length, 3);
		assert.equal(inputPrompts.length, 2);
		assert.deepEqual(
			selectPrompts.map((p) => p.title),
			["Which database?", "Deploy now?", "Notify channel?"],
		);
		assert.ok(selectPrompts[0].options.includes("Other (enter custom text)"));
		assert.ok(selectPrompts[0].options.includes("(Skip)"));

		assert.deepEqual(res, {
			action: "accept",
			content: {
				q0__other: "SQLite",
				q1: "Yes",
				q2_other: "Only on Fridays",
			},
		});
		assert.equal("q0" in (res.content ?? {}), false);
		assert.equal("q1__other" in (res.content ?? {}), false);
		assert.equal("q2" in (res.content ?? {}), false);
	});

	it("keeps companion __other separate for multi-select fields", async () => {
		const broker = new AgyTurnMirrorBroker();
		let selectStep = 0;
		const selectScript = ["[ ] Postgres", "Done (1 selected)"];
		let inputCalls = 0;

		broker.setFallbackUiContext(
			makeUiContext({
				async select() {
					return selectScript[selectStep++];
				},
				async input() {
					inputCalls++;
					return "SQLite";
				},
			}),
		);

		const res = await broker.handleElicitationRequest({
			sessionId: "sess-multi-companion",
			mode: "form",
			message: "Databases",
			requestedSchema: {
				type: "object",
				properties: {
					q0: {
						type: "array",
						title: "Databases?",
						items: { anyOf: [{ const: "Postgres", title: "Postgres" }] },
					},
					q0__other: { type: "string", title: "Other" },
				},
			},
		});

		assert.equal(inputCalls, 1);
		assert.deepEqual(res, {
			action: "accept",
			content: { q0: ["Postgres"], q0__other: "SQLite" },
		});
	});

	it("skips optional fields without cancelling the form, and cancels when a required field or single-field form is cancelled", async () => {
		const broker = new AgyTurnMirrorBroker();

		// 1. Multi-field form: skip optional select, optional boolean, optional number, optional text; fill required fields.
		let selectStep = 0;
		const selectReplies: Array<string | undefined> = ["(Skip)", undefined, "prod"];
		let inputStep = 0;
		const inputReplies: Array<string | undefined> = ["", "   ", "42"];

		broker.setFallbackUiContext(
			makeUiContext({
				async select() {
					return selectReplies[selectStep++];
				},
				async input() {
					return inputReplies[inputStep++];
				},
			}),
		);

		const multiRes = await broker.handleElicitationRequest({
			sessionId: "sess-opt",
			mode: "form",
			message: "Configure",
			requestedSchema: {
				type: "object",
				properties: {
					optChoice: { type: "string", title: "Choice", enum: ["a", "b"] },
					optBool: { type: "boolean", title: "Verbose" },
					optNum: { type: "integer", title: "Retries" },
					optNote: { type: "string", title: "Note" },
					reqEnv: { type: "string", title: "Env", enum: ["staging", "prod"] },
					reqPort: { type: "integer", title: "Port" },
				},
				required: ["reqEnv", "reqPort"],
			},
		});

		assert.deepEqual(multiRes, {
			action: "accept",
			content: { reqEnv: "prod", reqPort: 42 },
		});

		// 2. Cancelling a required field cancels the entire form.
		broker.setFallbackUiContext(
			makeUiContext({
				async select() {
					return undefined;
				},
			}),
		);
		const reqCancel = await broker.handleElicitationRequest({
			sessionId: "sess-req-cancel",
			mode: "form",
			message: "Configure",
			requestedSchema: {
				type: "object",
				properties: {
					reqEnv: { type: "string", enum: ["staging", "prod"] },
					optNote: { type: "string" },
				},
				required: ["reqEnv"],
			},
		});
		assert.deepEqual(reqCancel, { action: "cancel" });

		// 3. Cancelling (Escape) on a single-field optional form cancels, while "(Skip)" accepts empty content.
		const singleEscape = await broker.handleElicitationRequest({
			sessionId: "sess-single-esc",
			mode: "form",
			message: "1 question",
			requestedSchema: {
				type: "object",
				properties: {
					choice: { type: "string", title: "Pick one?", enum: ["A", "B"] },
					choice__other: { type: "string", title: "Other" },
				},
			},
		});
		assert.deepEqual(singleEscape, { action: "cancel" });

		broker.setFallbackUiContext(
			makeUiContext({
				async select() {
					return "(Skip)";
				},
			}),
		);
		const singleSkip = await broker.handleElicitationRequest({
			sessionId: "sess-single-skip",
			mode: "form",
			message: "1 question",
			requestedSchema: {
				type: "object",
				properties: {
					choice: { type: "string", title: "Pick one?", enum: ["A", "B"] },
				},
			},
		});
		assert.deepEqual(singleSkip, { action: "accept", content: {} });
	});

	it("uses property.title as question text for agy ask_question count messages while keeping descriptive message prefixes", async () => {
		const broker = new AgyTurnMirrorBroker();
		const seenTitles: string[] = [];

		broker.setFallbackUiContext(
			makeUiContext({
				async select(title, options) {
					seenTitles.push(title);
					return options[0];
				},
			}),
		);

		await broker.handleElicitationRequest({
			sessionId: "sess-ask",
			mode: "form",
			message: "2 questions",
			requestedSchema: {
				type: "object",
				properties: {
					q1: { type: "string", title: "Use strict mode?", enum: ["Yes", "No"] },
					q2: { type: "string", title: "Target runtime?", enum: ["Node", "Bun"] },
				},
			},
		});

		await broker.handleElicitationRequest({
			sessionId: "sess-desc",
			mode: "form",
			message: "Deploy settings",
			requestedSchema: {
				type: "object",
				properties: {
					env: { type: "string", title: "Environment", enum: ["staging", "prod"] },
				},
			},
		});

		assert.deepEqual(seenTitles, [
			"Use strict mode?",
			"Target runtime?",
			"Deploy settings — Environment",
		]);
	});

	it("preserves backward compatibility for enumNames, number, boolean, url mode, and aborted signals", async () => {
		const broker = new AgyTurnMirrorBroker();
		let selectStep = 0;
		const selectReplies = ["Production", "Yes"];
		let inputStep = 0;
		const inputReplies = ["0.75", "v2"];

		broker.setFallbackUiContext(
			makeUiContext({
				async confirm() {
					return false;
				},
				async select() {
					return selectReplies[selectStep++];
				},
				async input() {
					return inputReplies[inputStep++];
				},
			}),
		);

		const declinedUrl = await broker.handleElicitationRequest({
			sessionId: "sess-compat",
			mode: "url",
			message: "Login required",
			url: "https://example.com/login",
		});
		assert.deepEqual(declinedUrl, { action: "decline" });

		const formRes = await broker.handleElicitationRequest({
			sessionId: "sess-compat",
			mode: "form",
			message: "Settings",
			requestedSchema: {
				type: "object",
				properties: {
					env: {
						type: "string",
						title: "Env",
						enum: ["stg", "prd"],
						enumNames: ["Staging", "Production"],
					},
					confirm: { type: "boolean", title: "Confirm" },
					ratio: { type: "number", title: "Ratio" },
					tag: { type: "string", title: "Tag" },
				},
				required: ["env", "confirm", "ratio", "tag"],
			},
		});
		assert.deepEqual(formRes, {
			action: "accept",
			content: { env: "prd", confirm: true, ratio: 0.75, tag: "v2" },
		});

		const abortController = new AbortController();
		abortController.abort();
		let dialogOpened = false;
		broker.setFallbackUiContext(
			makeUiContext(
				{
					async input() {
						dialogOpened = true;
						return "never";
					},
				},
				{ signal: abortController.signal },
			),
		);
		const abortedRes = await broker.handleElicitationRequest({
			sessionId: "sess-abort",
			mode: "form",
			message: "Prompt",
		});
		assert.equal(dialogOpened, false);
		assert.deepEqual(abortedRes, { action: "cancel" });
	});
});

describe("native swarm tools, update_steps classification, renderers, and bounded payloads", () => {
	it("classifies native swarm tools via title or _meta.antigravity.swarm and ignores MCP-flagged calls", () => {
		const addWorker = classifyAgyToolCall({
			title: "Run swarm",
			kind: "other",
			rawInput: { action: "add", name: "parser", brief: "Audit parser" },
		});
		assert.equal(addWorker.mirrorToolName, "agy_tool");
		assert.equal(addWorker.arguments.tool, "swarm");
		assert.equal(addWorker.arguments.title, "Add swarm worker @parser");

		const addSharded = classifyAgyToolCall({
			title: "Running swarm",
			kind: "other",
			rawInput: { action: "add", name: "audit", tasks: ["a.ts", "b.ts", "c.ts"] },
		});
		assert.equal(addSharded.mirrorToolName, "agy_tool");
		assert.equal(addSharded.arguments.tool, "swarm");
		assert.equal(addSharded.arguments.title, "Add 3 swarm workers (@audit-1..3)");

		const killWorker = classifyAgyToolCall({
			title: "Run swarm",
			kind: "other",
			rawInput: { action: "kill", name: "@parser" },
		});
		assert.equal(killWorker.mirrorToolName, "agy_tool");
		assert.equal(killWorker.arguments.tool, "swarm");
		assert.equal(killWorker.arguments.title, "Stop swarm worker @parser");

		const metaSwarm = classifyAgyToolCall({
			title: "Add swarm worker @verifier",
			kind: "other",
			_meta: { antigravity: { swarm: { tool: "swarm", action: "add" } } },
		});
		assert.equal(metaSwarm.mirrorToolName, "agy_tool");
		assert.equal(metaSwarm.arguments.tool, "swarm");
		assert.equal(metaSwarm.arguments.title, "Add swarm worker @verifier");

		const postMain = classifyAgyToolCall({
			title: "Run post_message",
			kind: "other",
			rawInput: { text: "@coordinator done" },
		});
		assert.equal(postMain.mirrorToolName, "agy_tool");
		assert.equal(postMain.arguments.tool, "post_message");
		assert.equal(postMain.arguments.title, "Post to swarm board");

		const postChannel = classifyAgyToolCall({
			title: "Running post_message",
			kind: "other",
			rawInput: { channel: "#backend", text: "ready" },
		});
		assert.equal(postChannel.mirrorToolName, "agy_tool");
		assert.equal(postChannel.arguments.tool, "post_message");
		assert.equal(postChannel.arguments.title, "Post to #backend");

		const readBoard = classifyAgyToolCall({
			title: "Run read_board",
			kind: "read",
			rawInput: { since: 4 },
		});
		assert.equal(readBoard.mirrorToolName, "agy_tool");
		assert.equal(readBoard.arguments.tool, "read_board");
		assert.equal(readBoard.arguments.title, "Read swarm board");

		const readStatus = classifyAgyToolCall({
			title: "Run read_board",
			kind: "other",
			rawInput: { status: true },
		});
		assert.equal(readStatus.mirrorToolName, "agy_tool");
		assert.equal(readStatus.arguments.tool, "read_board");
		assert.equal(readStatus.arguments.title, "Read swarm status");

		const waitBoard = classifyAgyToolCall({
			title: "Run swarm_wait",
			kind: "think",
			rawInput: { since: 10 },
		});
		assert.equal(waitBoard.mirrorToolName, "agy_tool");
		assert.equal(waitBoard.arguments.tool, "swarm_wait");
		assert.equal(waitBoard.arguments.title, "Wait for swarm board");

		// MCP-flagged calls must NOT be treated as native swarm tools.
		const mcpSwarm = classifyAgyToolCall({
			title: "Run swarm",
			kind: "other",
			rawInput: { action: "add", name: "parser" },
			_meta: { is_mcp_tool_call: true },
		});
		assert.equal(mcpSwarm.mirrorToolName, "agy_tool");
		assert.equal(mcpSwarm.arguments.tool, undefined);
		assert.equal(mcpSwarm.arguments.title, "Run swarm");
	});

	it("classifies update_steps with a concise progress title", () => {
		const active = classifyAgyToolCall({
			title: "Run update_steps",
			kind: "other",
			rawInput: {
				steps: [
					{ title: "Inspect files", status: "done" },
					{ title: "Implement form support", status: "in_progress" },
					{ title: "Run tests", status: "pending" },
				],
			},
		});
		assert.equal(active.mirrorToolName, "agy_tool");
		assert.equal(active.arguments.tool, "update_steps");
		assert.equal(active.arguments.title, "Update plan (1/3): Implement form support");

		const allDone = classifyAgyToolCall({
			title: "Running update_steps",
			kind: "other",
			rawInput: {
				steps: [
					{ title: "Step 1", status: "completed" },
					{ title: "Step 2", status: "done" },
				],
			},
		});
		assert.equal(allDone.mirrorToolName, "agy_tool");
		assert.equal(allDone.arguments.tool, "update_steps");
		assert.equal(allDone.arguments.title, "Update plan (2/2 done)");

		const emptySteps = classifyAgyToolCall({
			title: "Run update_steps",
			kind: "other",
		});
		assert.equal(emptySteps.mirrorToolName, "agy_tool");
		assert.equal(emptySteps.arguments.tool, "update_steps");
		assert.equal(emptySteps.arguments.title, "Update plan");
	});

	it("renders swarm tools and update_steps cleanly in agy_tool renderCall without raw internal names", () => {
		const theme = makeTaggedTheme();
		const ctx = makeRenderCallContext();
		const renderCall = getMirrorToolRenderers("agy_tool").renderCall;
		assert.ok(renderCall);

		const cases: Array<{ args: Record<string, unknown>; expected: string }> = [
			{
				args: { tool: "swarm", title: "Add swarm worker @parser" },
				expected: "<toolTitle>**swarm**</toolTitle> <accent>Add swarm worker @parser</accent>",
			},
			{
				args: { tool: "post_message", title: "Post to swarm board" },
				expected: "<toolTitle>**swarm**</toolTitle> <accent>Post to swarm board</accent>",
			},
			{
				args: { tool: "read_board", title: "Run read_board" },
				expected: "<toolTitle>**swarm**</toolTitle> <accent>Read swarm board</accent>",
			},
			{
				args: { tool: "swarm_wait", title: "Wait for swarm board" },
				expected: "<toolTitle>**swarm**</toolTitle> <accent>Wait for swarm board</accent>",
			},
			{
				args: { tool: "update_steps", title: "Update plan (1/3): Implement form support" },
				expected:
					"<toolTitle>**plan**</toolTitle> <accent>Update plan (1/3): Implement form support</accent>",
			},
			{
				args: { tool: "update_steps", title: "Run update_steps" },
				expected: "<toolTitle>**plan**</toolTitle> <accent>Update plan</accent>",
			},
		];

		for (const testCase of cases) {
			const rendered = renderCall(testCase.args, theme, ctx);
			const lines = rendered.render(200).map((line: string) => line.trimEnd());
			assert.deepEqual(lines, [testCase.expected]);
		}
	});

	it("preserves formatted swarm titles across follow-up updates without rawInput", async () => {
		const broker = new AgyTurnMirrorBroker();
		broker.registerOrUpdateCall("sess-swarm", {
			toolCallId: "tc-swarm-1",
			title: "Run swarm",
			kind: "other",
			status: "in_progress",
			rawInput: { action: "add", name: "helper" },
		});
		broker.registerOrUpdateCall("sess-swarm", {
			toolCallId: "tc-swarm-1",
			title: "Run swarm",
			kind: "other",
			status: "completed",
			rawOutput: { status: "added" },
		});

		const res = await broker.executeMirrorCall(
			"tc-swarm-1",
			undefined,
			undefined,
			interactiveContext(os.tmpdir()),
		);
		assert.equal(res.details.title, "Add swarm worker @helper");
	});

	it("bounds runaway text blocks, rawOutput, and diff strings while keeping normal outputs untouched", async () => {
		const broker = new AgyTurnMirrorBroker();

		// 1. Normal outputs stay untouched.
		broker.registerOrUpdateCall("sess-bound", {
			toolCallId: "tc-normal",
			kind: "edit",
			title: "Edit small.ts",
			status: "completed",
			content: [
				{ type: "content", content: { type: "text", text: "Normal output" } },
				{ type: "diff", path: "small.ts", oldText: "const a = 1;", newText: "const a = 2;" },
			],
		});
		const normalRes = await broker.executeMirrorCall(
			"tc-normal",
			undefined,
			undefined,
			interactiveContext(os.tmpdir()),
		);
		assert.deepEqual(normalRes.content, [{ type: "text", text: "Normal output" }]);
		assert.deepEqual(normalRes.details.diffs, [
			{ path: "small.ts", oldText: "const a = 1;", newText: "const a = 2;" },
		]);

		// 2. Runaway text block (> 128 KiB) keeps tail + marker without splitting emoji surrogate pair.
		const textLimit = 128 * 1024;
		const tailMarker = "FINAL_LINE_OK\n";
		const tailPadding = "x".repeat(textLimit - tailMarker.length - 1);
		const hugeText = `${"noise\n".repeat(40_000)}🚀${tailPadding}${tailMarker}`;

		broker.registerOrUpdateCall("sess-bound", {
			toolCallId: "tc-huge-text",
			kind: "execute",
			title: "echo huge",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: hugeText } }],
		});
		const hugeTextRes = await broker.executeMirrorCall(
			"tc-huge-text",
			undefined,
			undefined,
			interactiveContext(os.tmpdir()),
		);
		const storedBlock = hugeTextRes.content[0];
		assert.equal(storedBlock.type, "text");
		assert.ok(storedBlock.text.startsWith("[Earlier output truncated]\n\n"));
		assert.ok(storedBlock.text.endsWith(tailMarker));
		assert.ok(storedBlock.text.length <= textLimit + "[Earlier output truncated]\n\n".length);
		// Low surrogate must not remain orphaned after the truncation marker.
		const afterMarker = storedBlock.text.slice("[Earlier output truncated]\n\n".length);
		assert.equal(/^[\uDC00-\uDFFF]/.test(afterMarker), false);

		// 3. Runaway rawOutput (object with huge string) is bounded cleanly.
		const hugeRawObj = { combinedOutput: `${"a".repeat(300_000)}RAW_END` };
		broker.registerOrUpdateCall("sess-bound", {
			toolCallId: "tc-huge-raw",
			kind: "execute",
			title: "raw huge",
			status: "completed",
			rawOutput: hugeRawObj,
		});
		const hugeRawRes = await broker.executeMirrorCall(
			"tc-huge-raw",
			undefined,
			undefined,
			interactiveContext(os.tmpdir()),
		);
		const rawBlock = hugeRawRes.content[0];
		assert.equal(rawBlock.type, "text");
		assert.ok(rawBlock.text.includes("[Earlier output truncated]"));
		assert.ok(rawBlock.text.includes("RAW_END"));
		assert.ok(rawBlock.text.length <= textLimit + "[Earlier output truncated]\n\n".length);

		// 4. Runaway diff (> 512 KiB) is bounded cleanly.
		const diffLimit = 512 * 1024;
		const hugeDiff = `${"d".repeat(700_000)}DIFF_TAIL`;
		broker.registerOrUpdateCall("sess-bound", {
			toolCallId: "tc-huge-diff",
			kind: "edit",
			title: "Edit giant.txt",
			status: "completed",
			content: [{ type: "diff", path: "giant.txt", oldText: hugeDiff, newText: hugeDiff }],
		});
		const hugeDiffRes = await broker.executeMirrorCall(
			"tc-huge-diff",
			undefined,
			undefined,
			interactiveContext(os.tmpdir()),
		);
		const diff = hugeDiffRes.details.diffs?.[0];
		assert.ok(diff);
		assert.ok(diff.oldText.startsWith("[Earlier output truncated]\n\n"));
		assert.ok(diff.oldText.endsWith("DIFF_TAIL"));
		assert.ok(diff.oldText.length <= diffLimit + "[Earlier output truncated]\n\n".length);
		assert.ok(diff.newText.startsWith("[Earlier output truncated]\n\n"));
		assert.ok(diff.newText.endsWith("DIFF_TAIL"));
		assert.ok(diff.newText.length <= diffLimit + "[Earlier output truncated]\n\n".length);
	});
});
