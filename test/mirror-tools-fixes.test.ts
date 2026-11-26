import * as assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import type { ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	AgyTurnMirrorBroker,
	classifyAgyToolCall,
	type EmptyResultContext,
} from "../src/tools/agy-mirror-tools.ts";
import {
	getMirrorToolRenderers,
	withoutTimestampHeader,
} from "../src/tools/agy-renderers.ts";
import { interactiveContext } from "./human-input.ts";

type RenderResultFn = NonNullable<ReturnType<typeof getMirrorToolRenderers>["renderResult"]>;
type RenderResultContext = Parameters<RenderResultFn>[3];

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

function makeRenderContext(opts: {
	args?: Record<string, unknown>;
	isError?: boolean;
	cwd?: string;
} = {}): RenderResultContext {
	const stub = {
		args: opts.args ?? {},
		toolCallId: "tc-test",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: opts.cwd ?? os.tmpdir(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: opts.isError ?? false,
		keyHint(_kb: string, desc: string) {
			return `<key:${desc}>`;
		},
	};
	const isCtx = (value: object): value is RenderResultContext => "keyHint" in value && "isError" in value;
	if (!isCtx(stub)) {
		throw new Error("invalid render context stub");
	}
	return stub;
}

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

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (error: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await Promise.resolve();
	}
}

describe("classifyAgyToolCall precedence", () => {
	it("classifies file edits, writes, reads, searches, and run titles mentioning workflow/subagent/swarm accurately", () => {
		assert.equal(
			classifyAgyToolCall({
				title: "Edit .github/workflows/release.yml",
				kind: "edit",
				locations: [{ path: "/repo/.github/workflows/release.yml" }],
			}).mirrorToolName,
			"agy_edit",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "Edit src/subagent.ts",
			}).mirrorToolName,
			"agy_edit",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "swarm_pane/SKILL.md",
				content: [{ type: "diff", path: "swarm_pane/SKILL.md", oldText: "a", newText: "b" }],
			}).mirrorToolName,
			"agy_edit",
		);

		assert.equal(
			classifyAgyToolCall({
				title: "Write src/subagent.ts",
			}).mirrorToolName,
			"agy_write",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "Create .github/workflows/release.yml",
			}).mirrorToolName,
			"agy_write",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "Create swarm_pane/SKILL.md",
			}).mirrorToolName,
			"agy_write",
		);

		assert.equal(
			classifyAgyToolCall({
				title: ".github/workflows/release.yml",
				kind: "read",
			}).mirrorToolName,
			"agy_read",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "Read src/subagent.ts",
			}).mirrorToolName,
			"agy_read",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "View swarm_pane/SKILL.md",
			}).mirrorToolName,
			"agy_read",
		);

		assert.equal(
			classifyAgyToolCall({
				title: "Search workflow",
			}).mirrorToolName,
			"agy_search",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "Grep subagent",
			}).mirrorToolName,
			"agy_search",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "Find swarm",
			}).mirrorToolName,
			"agy_search",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "workflow",
				kind: "search",
				rawInput: { Query: "workflow" },
			}).mirrorToolName,
			"agy_search",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "subagent",
				rawInput: { Query: "subagent" },
			}).mirrorToolName,
			"agy_search",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "Fetch https://example.com/workflow",
				kind: "fetch",
			}).mirrorToolName,
			"agy_search",
		);

		assert.equal(
			classifyAgyToolCall({
				title: "Run gh workflow list",
			}).mirrorToolName,
			"agy_bash",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "Run swarm status",
			}).mirrorToolName,
			"agy_bash",
		);
	});

	it("preserves legitimate agy_subagent and internal agy_tool classifications", () => {
		const invoke = classifyAgyToolCall({
			title: "Run invoke_subagent",
			kind: "other",
			rawInput: { Role: "Verifier", TypeName: "self", Prompt: "Check the diff" },
		});
		assert.equal(invoke.mirrorToolName, "agy_subagent");
		assert.equal(invoke.arguments.tool, "invoke_subagent");
		assert.equal(invoke.arguments.agentRole, "Verifier");

		assert.equal(
			classifyAgyToolCall({ title: "Invoke subagent" }).mirrorToolName,
			"agy_subagent",
		);
		assert.equal(
			classifyAgyToolCall({ title: "Swarm worker" }).mirrorToolName,
			"agy_subagent",
		);
		assert.equal(
			classifyAgyToolCall({ title: "Start subagent", kind: "other" }).mirrorToolName,
			"agy_subagent",
		);
		assert.equal(
			classifyAgyToolCall({
				title: "Delegate work",
				rawInput: { Role: "Researcher" },
			}).mirrorToolName,
			"agy_subagent",
		);
		assert.equal(
			classifyAgyToolCall({ title: "Run manage_task", kind: "other" }).mirrorToolName,
			"agy_tool",
		);
	});
});

describe("mirror tool renderers and timestamp header stripping", () => {
	const theme = makeTaggedTheme();

	it("returns empty string from withoutTimestampHeader when only timestamp lines are present", () => {
		assert.equal(withoutTimestampHeader("Created At: 2026-11-26T20:59:02+01:00"), "");
		assert.equal(
			withoutTimestampHeader(
				"Created At: 2026-11-26T20:59:02+01:00\nCompleted At: 2026-11-26T20:59:07+01:00",
			),
			"",
		);
		assert.equal(
			withoutTimestampHeader("Created At: 2026-11-26T20:59:02+01:00\n   \n"),
			"",
		);
		assert.equal(
			withoutTimestampHeader("Created At: 2026-11-26T20:59:02+01:00\n  indented line"),
			"  indented line",
		);
	});

	it("renders Running... for partial agy_bash results containing only timestamps, and empty output when completed", () => {
		const renderResult = getMirrorToolRenderers("agy_bash").renderResult;
		assert.ok(renderResult);

		const partialOnlyTimestamps = renderResult(
			{
				content: [{ type: "text", text: "Created At: 2026-11-26T20:59:02+01:00" }],
				details: {},
			},
			{ expanded: false, isPartial: true },
			theme,
			makeRenderContext(),
		);
		assert.deepEqual(
			partialOnlyTimestamps.render(120).map((line) => line.trimEnd()),
			["<muted>Running...</muted>"],
		);

		const completedOnlyTimestamps = renderResult(
			{
				content: [
					{
						type: "text",
						text: "Created At: 2026-11-26T20:59:02+01:00\nCompleted At: 2026-11-26T20:59:07+01:00",
					},
				],
				details: {},
			},
			{ expanded: false, isPartial: false },
			theme,
			makeRenderContext(),
		);
		assert.deepEqual(completedOnlyTimestamps.render(120), []);
	});

	it("strips timestamp headers in the generic agy_tool branch as well", () => {
		const renderResult = getMirrorToolRenderers("agy_tool").renderResult;
		assert.ok(renderResult);

		const manageTaskOutput = renderResult(
			{
				content: [
					{
						type: "text",
						text: "Created At: 2026-11-26T20:59:02+01:00\nCompleted At: 2026-11-26T20:59:03+01:00\nTask task-2 is running",
					},
				],
				details: {},
			},
			{ expanded: false, isPartial: false },
			theme,
			makeRenderContext(),
		);
		assert.deepEqual(
			manageTaskOutput.render(120).map((line) => line.trimEnd()),
			["<toolOutput>Task task-2 is running</toolOutput>"],
		);

		const manageTaskError = renderResult(
			{
				content: [
					{
						type: "text",
						text: "Created At: 2026-11-26T20:59:02+01:00\nCompleted At: 2026-11-26T20:59:03+01:00\nTask not found",
					},
				],
				details: {},
			},
			{ expanded: false, isPartial: false },
			theme,
			makeRenderContext({ isError: true }),
		);
		assert.deepEqual(
			manageTaskError.render(120).map((line) => line.trimEnd()),
			["<error>Task not found</error>"],
		);

		const partialGenericOnlyTimestamps = renderResult(
			{
				content: [{ type: "text", text: "Created At: 2026-11-26T20:59:02+01:00" }],
				details: {},
			},
			{ expanded: false, isPartial: true },
			theme,
			makeRenderContext(),
		);
		assert.deepEqual(
			partialGenericOnlyTimestamps.render(120).map((line) => line.trimEnd()),
			["<muted>Running...</muted>"],
		);

		const completedGenericOnlyTimestamps = renderResult(
			{
				content: [
					{
						type: "text",
						text: "Created At: 2026-11-26T20:59:02+01:00\nCompleted At: 2026-11-26T20:59:03+01:00",
					},
				],
				details: {},
			},
			{ expanded: false, isPartial: false },
			theme,
			makeRenderContext(),
		);
		assert.deepEqual(completedGenericOnlyTimestamps.render(120), []);
	});

	it("renders agy_read and agy_write error results with error color instead of syntax highlighting", () => {
		const errorText = "ENOENT: no such file or directory\nconst broken = true;";

		for (const toolName of ["agy_read", "agy_write"] as const) {
			const renderResult = getMirrorToolRenderers(toolName).renderResult;
			assert.ok(renderResult);

			const renderedError = renderResult(
				{
					content: [{ type: "text", text: errorText }],
					details: { path: "/repo/src/example.ts" },
				},
				{ expanded: false, isPartial: false },
				theme,
				makeRenderContext({ args: { path: "/repo/src/example.ts" }, isError: true }),
			);

			assert.deepEqual(
				renderedError.render(120).map((line) => line.trimEnd()),
				[
					"<error>ENOENT: no such file or directory</error>",
					"<error>const broken = true;</error>",
				],
			);

			const renderedPlainOk = renderResult(
				{
					content: [{ type: "text", text: "plain file body" }],
					details: { path: "/repo/notes.unknownext" },
				},
				{ expanded: false, isPartial: false },
				theme,
				makeRenderContext({ args: { path: "/repo/notes.unknownext" }, isError: false }),
			);
			assert.deepEqual(
				renderedPlainOk.render(120).map((line) => line.trimEnd()),
				["<toolOutput>plain file body</toolOutput>"],
			);
		}
	});
});

describe("AgyTurnMirrorBroker out-of-order status preservation", () => {
	it("does not downgrade completed status when delayed pending tool_call arrives, while merging missing metadata", async () => {
		const broker = new AgyTurnMirrorBroker();

		// 1. Terminal tool_call_update arrives first with output and no metadata.
		broker.registerOrUpdateCall("sess-ooo", {
			toolCallId: "tc-ooo-1",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "final output" } }],
		});

		// 2. Initial tool_call is dequeued later with non-terminal status and metadata.
		broker.registerOrUpdateCall("sess-ooo", {
			toolCallId: "tc-ooo-1",
			title: "echo final output",
			kind: "execute",
			status: "pending",
			rawInput: { CommandLine: "echo final output" },
			locations: [{ path: "/repo/script.sh", line: 12 }],
			content: [{ type: "content", content: { type: "text", text: "stale placeholder" } }],
		});

		const result = await broker.executeMirrorCall(
			"tc-ooo-1",
			undefined,
			undefined,
			interactiveContext(os.tmpdir()),
		);

		assert.equal(result.details.status, "completed");
		assert.equal(result.details.title, "echo final output");
		assert.equal(result.details.kind, "execute");
		assert.equal(result.details.command, "echo final output");
		assert.equal(result.details.path, "/repo/script.sh");
		assert.equal(result.details.line, 12);
		assert.deepEqual(result.content, [{ type: "text", text: "final output" }]);
	});

	it("preserves failed status and error output when delayed in_progress tool_call arrives", async () => {
		const broker = new AgyTurnMirrorBroker();

		broker.registerOrUpdateCall("sess-ooo-fail", {
			toolCallId: "tc-ooo-fail",
			status: "failed",
			content: [{ type: "content", content: { type: "text", text: "permission denied" } }],
		});

		broker.registerOrUpdateCall("sess-ooo-fail", {
			toolCallId: "tc-ooo-fail",
			title: "Read /etc/shadow",
			kind: "read",
			status: "in_progress",
			locations: [{ path: "/etc/shadow", line: 1 }],
		});

		await assert.rejects(
			() =>
				broker.executeMirrorCall(
					"tc-ooo-fail",
					undefined,
					undefined,
					interactiveContext(os.tmpdir()),
				),
			/permission denied/,
		);
	});

	it("merges missing tool and args into emptyResultNote context when completed update precedes tool_call", async () => {
		const broker = new AgyTurnMirrorBroker();
		const observed: EmptyResultContext[] = [];
		broker.setEmptyResultNote((context) => {
			observed.push(context);
			return context.toolName ? `Completed ${context.toolName}` : undefined;
		});

		broker.registerOrUpdateCall("sess-ooo-note", {
			toolCallId: "tc-ooo-note",
			status: "completed",
		});
		broker.registerOrUpdateCall("sess-ooo-note", {
			toolCallId: "tc-ooo-note",
			title: "Run schedule",
			kind: "other",
			status: "pending",
		});

		const result = await broker.executeMirrorCall(
			"tc-ooo-note",
			undefined,
			undefined,
			interactiveContext(os.tmpdir()),
		);

		assert.equal(result.details.status, "completed");
		assert.deepEqual(result.content, [{ type: "text", text: "Completed schedule" }]);
		assert.deepEqual(observed, [
			{
				agySessionId: "sess-ooo-note",
				kind: "other",
				title: "Run schedule",
				command: undefined,
				toolName: "schedule",
				args: { title: "Run schedule", kind: "other", tool: "schedule" },
			},
		]);
	});

	it("keeps existing terminal metadata instead of overwriting it with stale non-terminal metadata", async () => {
		const broker = new AgyTurnMirrorBroker();

		broker.registerOrUpdateCall("sess-ooo-keep", {
			toolCallId: "tc-ooo-keep",
			title: "Final title",
			status: "completed",
			rawOutput: "done",
		});
		broker.registerOrUpdateCall("sess-ooo-keep", {
			toolCallId: "tc-ooo-keep",
			title: "Initial title",
			kind: "execute",
			status: "pending",
			rawInput: { CommandLine: "echo done" },
		});

		const result = await broker.executeMirrorCall(
			"tc-ooo-keep",
			undefined,
			undefined,
			interactiveContext(os.tmpdir()),
		);

		assert.equal(result.details.status, "completed");
		assert.equal(result.details.title, "Final title");
		assert.equal(result.details.kind, "execute");
		assert.equal(result.details.command, "echo done");
	});
});

describe("AgyTurnMirrorBroker UI dialog serialization", () => {
	it("serializes permission and elicitation requests in strict FIFO order without overlap", async () => {
		const broker = new AgyTurnMirrorBroker();
		let activeDialogs = 0;
		let maxConcurrentDialogs = 0;
		const timeline: string[] = [];

		const permDeferred = createDeferred<string | undefined>();
		const inputDeferred = createDeferred<string | undefined>();

		broker.setFallbackUiContext(
			makeUiContext({
				async select(title) {
					activeDialogs++;
					maxConcurrentDialogs = Math.max(maxConcurrentDialogs, activeDialogs);
					timeline.push(`select:start:${title}`);
					try {
						return await permDeferred.promise;
					} finally {
						timeline.push(`select:end:${title}`);
						activeDialogs--;
					}
				},
				async input(title) {
					activeDialogs++;
					maxConcurrentDialogs = Math.max(maxConcurrentDialogs, activeDialogs);
					timeline.push(`input:start:${title}`);
					try {
						return await inputDeferred.promise;
					} finally {
						timeline.push(`input:end:${title}`);
						activeDialogs--;
					}
				},
			}),
		);

		const permPromise = broker.handlePermissionRequest({
			sessionId: "sess-ui",
			toolCall: { toolCallId: "tc-perm", title: "Run build" },
			options: [{ optionId: "allow", name: "Allow once" }],
		});
		const elicitPromise = broker.handleElicitationRequest({
			sessionId: "sess-ui",
			mode: "form",
			message: "Enter token",
		});

		await flushMicrotasks();
		assert.deepEqual(timeline, ["select:start:Approve: Run build"]);

		permDeferred.resolve("Allow once");
		await flushMicrotasks();
		assert.deepEqual(timeline, [
			"select:start:Approve: Run build",
			"select:end:Approve: Run build",
			"input:start:Enter token",
		]);

		inputDeferred.resolve("secret-value");
		const [permResult, elicitResult] = await Promise.all([permPromise, elicitPromise]);

		assert.equal(maxConcurrentDialogs, 1);
		assert.deepEqual(permResult, { outcome: { outcome: "selected", optionId: "allow" } });
		assert.deepEqual(elicitResult, { action: "accept", content: { response: "secret-value" } });
		assert.deepEqual(timeline, [
			"select:start:Approve: Run build",
			"select:end:Approve: Run build",
			"input:start:Enter token",
			"input:end:Enter token",
		]);
	});

	it("holds a permission prompt until a multi-step elicitation finishes completely", async () => {
		const broker = new AgyTurnMirrorBroker();
		let activeDialogs = 0;
		let maxConcurrentDialogs = 0;
		const timeline: string[] = [];

		const field1Deferred = createDeferred<string | undefined>();
		const field2Deferred = createDeferred<string | undefined>();
		const permDeferred = createDeferred<string | undefined>();
		let selectCalls = 0;

		broker.setFallbackUiContext(
			makeUiContext({
				async select(title) {
					activeDialogs++;
					maxConcurrentDialogs = Math.max(maxConcurrentDialogs, activeDialogs);
					timeline.push(`select:start:${title}`);
					selectCalls++;
					const currentDeferred = selectCalls === 1 ? field1Deferred : permDeferred;
					try {
						return await currentDeferred.promise;
					} finally {
						timeline.push(`select:end:${title}`);
						activeDialogs--;
					}
				},
				async input(title) {
					activeDialogs++;
					maxConcurrentDialogs = Math.max(maxConcurrentDialogs, activeDialogs);
					timeline.push(`input:start:${title}`);
					try {
						return await field2Deferred.promise;
					} finally {
						timeline.push(`input:end:${title}`);
						activeDialogs--;
					}
				},
			}),
		);

		const elicitPromise = broker.handleElicitationRequest({
			sessionId: "sess-ui-2",
			mode: "form",
			message: "Deploy settings",
			requestedSchema: {
				type: "object",
				properties: {
					env: { title: "Environment", enum: ["staging", "prod"] },
					tag: { title: "Release tag", type: "string" },
				},
			},
		});
		const permPromise = broker.handlePermissionRequest({
			sessionId: "sess-ui-2",
			toolCall: { toolCallId: "tc-perm-2", title: "Deploy" },
			options: [{ optionId: "allow", name: "Allow" }],
		});

		await flushMicrotasks();
		assert.deepEqual(timeline, ["select:start:Deploy settings — Environment"]);

		field1Deferred.resolve("staging");
		await flushMicrotasks();
		assert.deepEqual(timeline, [
			"select:start:Deploy settings — Environment",
			"select:end:Deploy settings — Environment",
			"input:start:Deploy settings — Release tag",
		]);

		field2Deferred.resolve("v1.2.3");
		await flushMicrotasks();
		assert.deepEqual(timeline, [
			"select:start:Deploy settings — Environment",
			"select:end:Deploy settings — Environment",
			"input:start:Deploy settings — Release tag",
			"input:end:Deploy settings — Release tag",
			"select:start:Approve: Deploy",
		]);

		permDeferred.resolve("Allow");
		const [elicitResult, permResult] = await Promise.all([elicitPromise, permPromise]);

		assert.equal(maxConcurrentDialogs, 1);
		assert.deepEqual(elicitResult, {
			action: "accept",
			content: { env: "staging", tag: "v1.2.3" },
		});
		assert.deepEqual(permResult, { outcome: { outcome: "selected", optionId: "allow" } });
	});

	it("serializes url-mode elicitation confirm prompts with permission prompts", async () => {
		const broker = new AgyTurnMirrorBroker();
		let activeDialogs = 0;
		let maxConcurrentDialogs = 0;
		const timeline: string[] = [];

		const confirmDeferred = createDeferred<boolean>();
		const permDeferred = createDeferred<string | undefined>();

		broker.setFallbackUiContext(
			makeUiContext({
				async confirm(title) {
					activeDialogs++;
					maxConcurrentDialogs = Math.max(maxConcurrentDialogs, activeDialogs);
					timeline.push(`confirm:start:${title}`);
					try {
						return await confirmDeferred.promise;
					} finally {
						timeline.push(`confirm:end:${title}`);
						activeDialogs--;
					}
				},
				async select(title) {
					activeDialogs++;
					maxConcurrentDialogs = Math.max(maxConcurrentDialogs, activeDialogs);
					timeline.push(`select:start:${title}`);
					try {
						return await permDeferred.promise;
					} finally {
						timeline.push(`select:end:${title}`);
						activeDialogs--;
					}
				},
			}),
		);

		const urlElicit = broker.handleElicitationRequest({
			sessionId: "sess-ui-url",
			mode: "url",
			url: "https://example.com/auth",
			message: "Authorize",
		});
		const perm = broker.handlePermissionRequest({
			sessionId: "sess-ui-url",
			toolCall: { toolCallId: "tc-url-perm", title: "Continue" },
			options: [{ optionId: "allow", name: "Allow" }],
		});

		await flushMicrotasks();
		assert.deepEqual(timeline, ["confirm:start:Authorize"]);

		confirmDeferred.resolve(true);
		await flushMicrotasks();
		assert.deepEqual(timeline, [
			"confirm:start:Authorize",
			"confirm:end:Authorize",
			"select:start:Approve: Continue",
		]);

		permDeferred.resolve("Allow");
		const [elicitRes, permRes] = await Promise.all([urlElicit, perm]);

		assert.equal(maxConcurrentDialogs, 1);
		assert.deepEqual(elicitRes, { action: "accept" });
		assert.deepEqual(permRes, { outcome: { outcome: "selected", optionId: "allow" } });
	});

	it("keeps the UI dialog queue healthy after a failed elicitation request", async () => {
		const broker = new AgyTurnMirrorBroker();
		broker.setFallbackUiContext(
			makeUiContext({
				async input() {
					throw new Error("dialog crashed");
				},
				async select() {
					return "Allow";
				},
			}),
		);

		const failedElicit = broker.handleElicitationRequest({
			sessionId: "sess-ui-err",
			mode: "form",
			message: "Will fail",
		});
		const nextPerm = broker.handlePermissionRequest({
			sessionId: "sess-ui-err",
			toolCall: { toolCallId: "tc-after-err", title: "Next action" },
			options: [{ optionId: "allow", name: "Allow" }],
		});

		await assert.rejects(() => failedElicit, /dialog crashed/);
		assert.deepEqual(await nextPerm, { outcome: { outcome: "selected", optionId: "allow" } });
	});
});
