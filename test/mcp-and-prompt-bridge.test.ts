import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SystemMessage, Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildAgySpawnSpec, resolveAgyBinary } from "../src/acp/binary-resolver.ts";
import { DEFAULT_BRIDGE_CONFIG, type BridgeConfig } from "../src/config.ts";
import {
	doesAnnouncementMatchTool,
	LocalHttpMcpBridge,
	MAX_MCP_EXPOSED_TOOL_NAME_LEN,
	normalizeHostToolArguments,
	sanitizeJsonSchemaForMcp,
	toExposedMcpToolName,
	type ParkedToolCall,
} from "../src/mcp/http-mcp-bridge.ts";
import { filterToolsForHostMcpBridge } from "../src/mcp/pi-mcp-forwarder.ts";
import { validateToolArguments } from "../src/mcp/schema-validator.ts";
import { buildInlineStdioShimCommand } from "../src/mcp/stdio-shim.ts";
import { prepareCustomizationMount } from "../src/session/customization-mounter.ts";
import { AgyTurnMirrorBroker, classifyAgyToolCall } from "../src/tools/agy-mirror-tools.ts";
import { ToolActivationController } from "../src/ui/commands.ts";
import { THIN_CLIENT_DISABLED } from "./thin-client-skip.ts";

describe("MCP 工具参数 JSON Schema 预校验", () => {
	const editSchema = {
		type: "object",
		properties: {
			path: { type: "string", minLength: 1 },
			line: { type: "integer", minimum: 1 },
			mode: { type: "string", enum: ["replace", "insert"] },
		},
		required: ["path"],
		additionalProperties: false,
	};

	it("通过合法参数并拦截缺失必填项、错误类型与多余字段", () => {
		const ok = validateToolArguments(
			"edit",
			{ path: "src/a.ts", line: 3, mode: "replace" },
			editSchema,
		);
		assert.equal(ok.valid, true);

		const bad = validateToolArguments(
			"edit",
			{ line: 0, mode: "invalid", extra: true },
			editSchema,
		);
		assert.equal(bad.valid, false);
		assert.ok(bad.formattedError?.includes("$.path"));
		assert.ok(bad.formattedError?.includes("$.line"));
		assert.ok(bad.formattedError?.includes("$.mode"));
		assert.ok(bad.formattedError?.includes("$.extra"));

		// 支持 $defs / $ref 与 allOf 组合结构且不因顶层 additionalProperties: false 误拒合法分支字段
		const refAndAllOfSchema = {
			type: "object",
			$defs: {
				EditRange: {
					type: "object",
					properties: {
						start: { type: "integer", minimum: 1 },
						end: { type: "integer", minimum: 1 },
					},
					required: ["start"],
				},
			},
			allOf: [
				{
					type: "object",
					properties: {
						range: { $ref: "#/$defs/EditRange" },
					},
					required: ["range"],
				},
			],
			properties: {
				path: { type: "string" },
			},
			required: ["path"],
			additionalProperties: false,
		};
		assert.equal(
			validateToolArguments("ref_tool", { path: "a.ts", range: { start: 1, end: 5 } }, refAndAllOfSchema)
				.valid,
			true,
		);
		const badRef = validateToolArguments("ref_tool", { path: "a.ts", range: { start: 0 } }, refAndAllOfSchema);
		assert.equal(badRef.valid, false);
		assert.ok(badRef.formattedError?.includes("$.range.start"));
	});
});

describe("本地 Streamable HTTP MCP 服务端", () => {
	it("完整处理鉴权、OAuth 元数据 404、空体 DELETE、参数自愈、挂起结算与超时剥离", async () => {
		const bridge = new LocalHttpMcpBridge(5_000);
		const tools: Tool[] = [
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

		const parkedList: ParkedToolCall[] = [];
		let holdTimedOut = false;

		const token = bridge.registerSessionBinding({
			agySessionId: "sess-1",
			tools,
			onParkedCall: (call) => parkedList.push(call),
			onHoldTimeout: async () => {
				holdTimedOut = true;
			},
		});

		try {
			const port = await bridge.ensureListening();
			const baseUrl = `http://127.0.0.1:${port}`;

			const wellKnown = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
			assert.equal(wellKnown.status, 404);

			const unauth = await fetch(`${baseUrl}/mcp`, { method: "POST", body: "{}" });
			assert.equal(unauth.status, 401);

			const authHeaders = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			};

			const delRes = await fetch(`${baseUrl}/mcp`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			});
			assert.equal(delRes.status, 200);

			const discoverRes = (await (
				await fetch(`${baseUrl}/mcp`, {
					method: "POST",
					headers: authHeaders,
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
				})
			).json()) as { error?: { code: number } };
			assert.equal(discoverRes.error?.code, -32601);

			const listRes = (await (
				await fetch(`${baseUrl}/mcp`, {
					method: "POST",
					headers: authHeaders,
					body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
				})
			).json()) as { result: { tools: Array<{ name: string }> } };
			assert.equal(listRes.result.tools.length, 1);
			assert.equal(listRes.result.tools[0].name, "read");

			const invalidCallRes = (await (
				await fetch(`${baseUrl}/mcp`, {
					method: "POST",
					headers: authHeaders,
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 3,
						method: "tools/call",
						params: { name: "read", arguments: {} },
					}),
				})
			).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
			assert.equal(invalidCallRes.result.isError, true);
			assert.equal(parkedList.length, 0);

			bridge.recordAcpToolAnnouncement("sess-1", "mcp_pi_tools_read");
			const callPromise = fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: authHeaders,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 4,
					method: "tools/call",
					params: { name: "read", arguments: { path: "README.md" } },
				}),
			}).then((r) => r.json());

			await new Promise((r) => setTimeout(r, 40));
			assert.equal(parkedList.length, 1);
			parkedList[0].settle({
				content: [
					{ type: "text", text: "file content" },
					{ type: "image", data: "YWJj", mimeType: "image/png" },
				],
			});

			const settledJson = (await callPromise) as {
				result: { isError: boolean; content: Array<{ type: string }> };
			};
			assert.equal(settledJson.result.isError, false);
			assert.equal(settledJson.result.content.length, 2);
			assert.equal(settledJson.result.content[1].type, "image");
			assert.equal(holdTimedOut, false);
		} finally {
			await bridge.dispose();
		}

		// 验证超过守护阈值时自动触发预取消剥离并释放连接
		const shortHoldBridge = new LocalHttpMcpBridge(60);
		let detachedCall: ParkedToolCall | undefined;
		let timeoutCallbackCount = 0;
		const shortToken = shortHoldBridge.registerSessionBinding({
			agySessionId: "sess-2",
			tools,
			onParkedCall: (c) => {
				detachedCall = c;
			},
			onHoldTimeout: async () => {
				timeoutCallbackCount++;
			},
		});

		try {
			const p2 = await shortHoldBridge.ensureListening();
			shortHoldBridge.recordAcpToolAnnouncement("sess-2", "mcp_pi_tools_read");
			const detachJson = (await (
				await fetch(`http://127.0.0.1:${p2}/mcp`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${shortToken}`,
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 99,
						method: "tools/call",
						params: { name: "read", arguments: { path: "slow.ts" } },
					}),
				})
			).json()) as { result: { isError: boolean } };

			assert.equal(detachJson.result.isError, true);
			assert.equal(timeoutCallbackCount, 1);
			assert.equal(detachedCall?.isDetached, true);
		} finally {
			await shortHoldBridge.dispose();
		}
	});
});

describe("官方原生 Plugin 生态挂载、纯净模式上下文与零系统提示词注入安全红线", () => {
	it("静态扫描全部源码确保不存在任何 _meta.antigravity.systemPrompt 注入逻辑", () => {
		const testDir = path.dirname(fileURLToPath(import.meta.url));
		const srcRoot = path.resolve(testDir, "..", "src");

		const collectTsFiles = (dir: string): string[] => {
			const out: string[] = [];
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					out.push(...collectTsFiles(full));
				} else if (entry.isFile() && entry.name.endsWith(".ts")) {
					out.push(full);
				}
			}
			return out;
		};

		for (const file of collectTsFiles(srcRoot)) {
			const source = fs.readFileSync(file, "utf8");
			// 仅允许 protocol.ts 在只读响应类型中声明服务端通告的能力，禁止出现任何请求注入或 append 调用
			if (!file.endsWith(path.join("acp", "protocol.ts"))) {
				assert.equal(
					source.includes("systemPrompt"),
					false,
					`源码文件 ${file} 不得包含任何 systemPrompt 触碰或注入字段`,
				);
			}
		}
	});

	it("pi-tools 纯净模式下生成完整 <workspace_context> 用户上下文块，且兼容 edit 工具字符串化 edits 归一化", { skip: THIN_CLIENT_DISABLED }, async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-pure-ctx-"));
		try {
			const wsDir = path.join(tmpRoot, "repo");
			const extSkillDir = path.join(tmpRoot, "external-pi-skills", "calc-guard");
			fs.mkdirSync(path.join(wsDir, ".git"), { recursive: true });
			fs.mkdirSync(extSkillDir, { recursive: true });

			const wsAgentsMd = path.join(wsDir, "AGENTS.md");
			const globalPiAgentsMd = path.join(tmpRoot, "global-AGENTS.md");
			const extSkillMd = path.join(extSkillDir, "SKILL.md");

			fs.writeFileSync(wsAgentsMd, "# Workspace Rule\nKeep commits atomic.\n");
			fs.writeFileSync(globalPiAgentsMd, "# Global Pi Rule\nReport progress briefly.\n");
			fs.writeFileSync(
				extSkillMd,
				"---\nname: calc-guard\ndescription: Calc verification rules.\n---\n# Calc Guard\n",
			);

			const sysMsg: SystemMessage = {
				role: "system",
				content: "",
				toolsAdded: [
					{ name: "read", description: "r", parameters: {} },
					{ name: "edit", description: "e", parameters: {} },
					{ name: "bash", description: "b", parameters: {} },
				],
				sections: {
					preamble: "You are a coding assistant running inside pi...",
					project_context: [
						"<project_context>",
						`<project_instructions path="${wsAgentsMd}">workspace rule</project_instructions>`,
						`<project_instructions path="${globalPiAgentsMd}">global pi rule</project_instructions>`,
						"</project_context>",
					].join("\n"),
					skills: [
						"<skills>",
						`<available_skills><skill><name>calc-guard</name><location>${extSkillMd}</location></skill></available_skills>`,
						"</skills>",
					].join("\n"),
					mcp_servers: "<mcp_servers>\n<server name=\"docs\" exposure=\"codemode\" />\n</mcp_servers>",
				},
				timestamp: 1,
			};

			const pureCfg: BridgeConfig = {
				...DEFAULT_BRIDGE_CONFIG,
				toolMode: "pi-tools",
				geminiDir: path.join(tmpRoot, ".gemini"),
			};

			const pureMount = prepareCustomizationMount([sysMsg], pureCfg, wsDir);
			assert.equal(pureMount.mountedPluginPaths.length, 0);
			assert.deepEqual(pureMount.additionalDirectories, [fs.realpathSync(extSkillDir)]);
			assert.ok(pureMount.workspaceContextBlock);
			// 绝不包含宿主系统提示词 preamble，同时完整保留工作区与全局 AGENTS.md、外部技能索引与 MCP 服务器目录
			assert.ok(!pureMount.workspaceContextBlock.includes("running inside pi"));
			assert.ok(pureMount.workspaceContextBlock.includes("Keep commits atomic."));
			assert.ok(pureMount.workspaceContextBlock.includes("Report progress briefly."));
			assert.ok(pureMount.workspaceContextBlock.includes("calc-guard"));
			assert.ok(pureMount.workspaceContextBlock.includes("<tool_guidelines>"));
			assert.ok(pureMount.workspaceContextBlock.includes("<mcp_servers>"));
			assert.ok(pureMount.workspaceContextBlock.includes('exposure="codemode"'));

			// 验证 LocalHttpMcpBridge 对 edit 工具字符串化 edits 参数的自动兼容归一化
			const bridge = new LocalHttpMcpBridge(5_000);
			const parked: ParkedToolCall[] = [];
			const editTool: Tool = {
				name: "edit",
				description: "Edit file",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
						edits: {
							type: "array",
							items: {
								type: "object",
								properties: {
									oldText: { type: "string" },
									newText: { type: "string" },
								},
								required: ["oldText", "newText"],
							},
						},
					},
					required: ["path", "edits"],
				},
			};
			const token = bridge.registerSessionBinding({
				agySessionId: "sess-edit",
				tools: [editTool],
				onParkedCall: (c) => parked.push(c),
				onHoldTimeout: async () => {},
			});
			try {
				const port = await bridge.ensureListening();
				bridge.recordAcpToolAnnouncement("sess-edit", "mcp_pi_tools_edit");
				const callFuture = fetch(`http://127.0.0.1:${port}/mcp`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 77,
						method: "tools/call",
						params: {
							name: "edit",
							arguments: {
								path: "calc.ts",
								edits: JSON.stringify([{ oldText: "a + b", newText: "a * b" }]),
							},
						},
					}),
				}).then((r) => r.json());

				await new Promise((r) => setTimeout(r, 30));
				assert.equal(parked.length, 1);
				assert.ok(Array.isArray(parked[0].arguments.edits));
				parked[0].settle({ content: [{ type: "text", text: "OK" }] });
				const out = (await callFuture) as { result: { isError: boolean } };
				assert.equal(out.result.isError, false);
			} finally {
				await bridge.dispose();
			}
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("生成符合 agy plugin validate --strict 规范的原生挂载包并自动去重工作区已有配置", { skip: THIN_CLIENT_DISABLED }, () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-native-mount-"));
		try {
			const piAgentDir = path.join(tmpRoot, "pi-agent");
			const wsDir = path.join(tmpRoot, "repo");
			const extSkillDir = path.join(tmpRoot, "external-pi-skills", "my-skill");
			const nativeSkillDir = path.join(wsDir, ".agents", "skills", "shared-skill");
			fs.mkdirSync(path.join(wsDir, ".git"), { recursive: true });
			fs.mkdirSync(extSkillDir, { recursive: true });
			fs.mkdirSync(nativeSkillDir, { recursive: true });

			const wsAgentsMd = path.join(wsDir, "AGENTS.md");
			const globalPiAgentsMd = path.join(tmpRoot, "global-AGENTS.md");
			const extSkillMd = path.join(extSkillDir, "SKILL.md");
			const nativeSkillMd = path.join(nativeSkillDir, "SKILL.md");

			fs.writeFileSync(wsAgentsMd, "# Workspace Rule\nAlready discovered by AGY.\n");
			fs.writeFileSync(globalPiAgentsMd, "# Global Pi Rule\nUse strict checks.\n");
			fs.writeFileSync(
				extSkillMd,
				"---\nname: my-skill\ndescription: Use when testing mounted Pi skills.\n---\n# My Skill\n",
			);
			fs.writeFileSync(
				nativeSkillMd,
				"---\nname: shared-skill\ndescription: Already native.\n---\n# Shared\n",
			);

			const sysMsg: SystemMessage = {
				role: "system",
				content: "",
				sections: {
					preamble: "You are a coding assistant running inside pi...",
					project_context: [
						"<project_context>",
						`<project_instructions path="${wsAgentsMd}">workspace rule</project_instructions>`,
						`<project_instructions path="${globalPiAgentsMd}">global pi rule</project_instructions>`,
						"</project_context>",
					].join("\n"),
					skills: [
						"<skills>",
						`<skill><name>shared-skill</name><location>${nativeSkillMd}</location></skill>`,
						`<skill><name>my-skill</name><location>${extSkillMd}</location></skill>`,
						"</skills>",
					].join("\n"),
				},
				timestamp: 1,
			};

			const cfg: BridgeConfig = {
				...DEFAULT_BRIDGE_CONFIG,
				toolMode: "hybrid",
				bridgePiAgentsMd: true,
				bridgePiSkills: true,
				agyInheritCustomizations: true,
				geminiDir: path.join(tmpRoot, ".gemini"),
			};

			const mounted = prepareCustomizationMount([sysMsg], cfg, wsDir, {
				PI_CODING_AGENT_DIR: piAgentDir,
			});

			assert.equal(mounted.mountedPluginPaths.length, 1);
			assert.equal(mounted.additionalDirectories.length, 1);

			const pluginDir = mounted.mountedPluginPaths[0];
			const rulesMd = fs.readFileSync(path.join(pluginDir, "rules", "AGENTS.md"), "utf8");
			const skillsManifest = JSON.parse(
				fs.readFileSync(path.join(pluginDir, "skills.json"), "utf8"),
			) as { entries: Array<{ path: string; include_only: string[] }> };

			// 绝不包含宿主 preamble，且自动剔除已被 AGY 原生扫描的 wsAgentsMd 与 nativeSkillDir
			assert.ok(!rulesMd.includes("running inside pi"));
			assert.ok(!rulesMd.includes("Workspace Rule"));
			assert.ok(rulesMd.includes("Global Pi Rule"));
			assert.equal(skillsManifest.entries.length, 1);
			assert.deepEqual(skillsManifest.entries[0].include_only, ["my-skill"]);

			// 若本机已安装 agy，执行官方严格插件校验器确认 0 error / 0 warning
			const agyBin = resolveAgyBinary();
			if (agyBin) {
				const validateSpec = buildAgySpawnSpec(agyBin, [
					"plugin",
					"validate",
					pluginDir,
					"--strict",
					"--json",
				]);
				const validateRes = spawnSync(validateSpec.command, validateSpec.args, {
					encoding: "utf8",
					windowsVerbatimArguments: validateSpec.windowsVerbatimArguments,
				});
				assert.equal(validateRes.status, 0, `agy plugin validate failed: ${validateRes.stderr}`);
				const report = JSON.parse(validateRes.stdout) as {
					components: { rules: number; skills: number };
				};
				assert.equal(report.components.rules, 1);
				assert.equal(report.components.skills, 1);
			}

			// hybrid 工具过滤应剔除基础 read/edit/bash，保留第三方工具
			const allTools: Tool[] = [
				{ name: "read", description: "r", parameters: {} },
				{ name: "bash", description: "b", parameters: {} },
				{ name: "agy_edit", description: "m", parameters: {} },
				{ name: "custom_deploy", description: "d", parameters: {} },
			];
			const hostTools = filterToolsForHostMcpBridge(allTools, cfg);
			assert.deepEqual(
				hostTools.map((t) => t.name),
				["custom_deploy"],
			);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("agy-tools 开启 bridgePiMcp 时遵循 MCP 暴露策略、保留动态解锁工具，且 Stdio 转发桥支持并发与 SSE 变更通知", { skip: THIN_CLIENT_DISABLED }, async () => {
		let activeTools = ["read", "bash", "codemode", "mcp__github__search"];
		const fakePi = {
			getActiveTools: () => [...activeTools],
			getAllTools: () => [
				{ name: "read" },
				{ name: "bash" },
				{ name: "codemode" },
				{ name: "tool_search" },
				{ name: "mcp__github__search" },
				{ name: "mcp__deferred__secret_query" },
				{ name: "mcp__hidden__internal_admin" },
			],
			setActiveTools: (next: string[]) => {
				activeTools = [...next];
			},
		} as unknown as ExtensionAPI;

		const ctrl = new ToolActivationController(fakePi);
		const fakeCtx = { model: { provider: "antigravity", id: "gemini-4-neon" } } as unknown as ExtensionContext;
		ctrl.syncForContext(fakeCtx, {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			bridgePiMcp: true,
			piMcpBridgeStrategy: "via-host",
		});

		assert.ok(activeTools.includes("agy_read"));
		assert.ok(activeTools.includes("codemode"));
		assert.ok(activeTools.includes("tool_search"));
		assert.ok(activeTools.includes("mcp__github__search"));
		// 未在用户激活集中的 deferred / hidden MCP 工具绝不强行激活
		assert.ok(!activeTools.includes("mcp__deferred__secret_query"));
		assert.ok(!activeTools.includes("mcp__hidden__internal_admin"));
		assert.ok(!activeTools.includes("read"));

		// 模拟会话途中 tool_search 动态激活了 mcp__deferred__secret_query，跨轮次及切入 hybrid 后必须持续保留
		activeTools = [...activeTools, "mcp__deferred__secret_query"];
		ctrl.syncForContext(fakeCtx, {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "hybrid",
			bridgePiMcp: true,
		});
		assert.ok(activeTools.includes("mcp__deferred__secret_query"));
		ctrl.syncForContext(fakeCtx, {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "hybrid",
			bridgePiMcp: true,
		});
		assert.ok(activeTools.includes("mcp__deferred__secret_query"));

		// 验证未开启 codemode 的用户进入 agy-tools + bridgePiMcp 时绝不被强行启用 codemode，且退出后不泄漏临时注入的 tool_search
		let noCodemodeActive = ["read", "bash", "mcp__github__search"];
		const fakePiNoCodemode = {
			getActiveTools: () => [...noCodemodeActive],
			getAllTools: () => [
				{ name: "read" },
				{ name: "bash" },
				{ name: "codemode" },
				{ name: "tool_search" },
				{ name: "mcp__github__search" },
			],
			setActiveTools: (next: string[]) => {
				noCodemodeActive = [...next];
			},
		} as unknown as ExtensionAPI;
		const ctrlNoCode = new ToolActivationController(fakePiNoCodemode);
		ctrlNoCode.syncForContext(fakeCtx, {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "agy-tools",
			bridgePiMcp: true,
			piMcpBridgeStrategy: "via-host",
		});
		assert.ok(!noCodemodeActive.includes("codemode"));
		assert.ok(noCodemodeActive.includes("tool_search"));
		// 切回 pi-tools 时完整恢复原工具列表且不泄漏 codemode / 临时补入的 tool_search
		ctrlNoCode.syncForContext(fakeCtx, {
			...DEFAULT_BRIDGE_CONFIG,
			toolMode: "pi-tools",
		});
		assert.deepEqual(noCodemodeActive.sort(), ["bash", "mcp__github__search", "read"]);

		// 验证镜像工具收到纯 diff 的 tool_call_update 时保留先前流式文本输出不清空
		const diffBroker = new AgyTurnMirrorBroker();
		diffBroker.registerOrUpdateCall("sess-diff", {
			toolCallId: "tc-diff-1",
			kind: "edit",
			title: "Edit a.ts",
			status: "in_progress",
			content: [{ type: "content", content: { type: "text", text: "Applying patch..." } }],
		});
		diffBroker.registerOrUpdateCall("sess-diff", {
			toolCallId: "tc-diff-1",
			status: "completed",
			content: [{ type: "diff", path: "a.ts", oldText: "old", newText: "new" }],
		});
		const diffRes = await diffBroker.executeMirrorCall(
			"tc-diff-1",
			undefined,
			undefined,
			fakeCtx,
		);
		assert.ok(
			diffRes.content.some((c) => c.type === "text" && c.text.includes("Applying patch...")),
		);
		assert.equal(diffRes.details?.diffs?.length, 1);

		// 验证通用字段 name / Description 不会把普通原生工具误判为 agy_subagent
		const bashWithDesc = classifyAgyToolCall({
			title: "Execute command",
			kind: "execute",
			rawInput: { CommandLine: "npm test", Description: "Run unit tests", name: "test-step" },
		});
		assert.equal(bashWithDesc.mirrorToolName, "agy_bash");
		const genericWithName = classifyAgyToolCall({
			title: "Check status",
			rawInput: { name: "build-check", Description: "Verify CI status" },
		});
		assert.equal(genericWithName.mirrorToolName, "agy_tool");

		// 验证内联 Stdio 转发桥在首个请求挂起时不会阻塞后续并发 ping 请求，且支持 SSE tools/list_changed 推送
		const bridge = new LocalHttpMcpBridge(5_000);
		const parked: ParkedToolCall[] = [];
		const token = bridge.registerSessionBinding({
			agySessionId: "sess-stdio",
			tools: [{ name: "slow_tool", description: "slow", parameters: { type: "object", properties: {} } }],
			onParkedCall: (c) => parked.push(c),
			onHoldTimeout: async () => {},
		});

		const waitUntil = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
			const deadline = Date.now() + timeoutMs;
			while (!predicate()) {
				if (Date.now() > deadline) {
					throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
				}
				await new Promise((r) => setTimeout(r, 15));
			}
		};

		let child: ReturnType<typeof spawn> | undefined;
		try {
			const port = await bridge.ensureListening();
			bridge.recordAcpToolAnnouncement("sess-stdio", "mcp_pi_tools_slow_tool");
			const spec = buildInlineStdioShimCommand(`http://127.0.0.1:${port}/mcp`, token);
			const envObj: NodeJS.ProcessEnv = { ...process.env };
			for (const pair of spec.env) envObj[pair.name] = pair.value;

			child = spawn(spec.command, spec.args, { env: envObj, stdio: ["pipe", "pipe", "pipe"] });
			const messages: Array<{ id?: number; method?: string }> = [];
			child.stdout!.setEncoding("utf8");
			let outBuf = "";
			child.stdout!.on("data", (chunk: string) => {
				outBuf += chunk;
				let nl = outBuf.indexOf("\n");
				while (nl !== -1) {
					const raw = outBuf.slice(0, nl).trim();
					outBuf = outBuf.slice(nl + 1);
					if (raw) messages.push(JSON.parse(raw) as { id?: number; method?: string });
					nl = outBuf.indexOf("\n");
				}
			});

			// 先发挂起的 tools/call (id=1)，等待服务端确认已进入 Park-and-Yield 挂起态
			child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow_tool", arguments: {} } })}\n`);
			await waitUntil(() => parked.length === 1);

			// 紧接着并发发送 ping (id=2)，必须在 id=1 仍处于挂起态时先行返回
			child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} })}\n`);
			await waitUntil(() => messages.some((m) => m.id === 2));

			parked[0].settle({ content: [{ type: "text", text: "done" }] });
			await waitUntil(() => messages.some((m) => m.id === 1));

			// 更新工具绑定列表，验证内联 Stdio 转发桥通过 GET /mcp SSE 收到 notifications/tools/list_changed
			bridge.updateBindingTools(token, [
				{ name: "slow_tool", description: "slow", parameters: { type: "object", properties: {} } },
				{ name: "newly_unlocked_tool", description: "new", parameters: { type: "object", properties: {} } },
			]);
			await waitUntil(() => messages.some((m) => m.method === "notifications/tools/list_changed"));
		} finally {
			if (child) {
				try {
					child.stdin?.destroy();
					child.stdout?.destroy();
					child.stderr?.destroy();
					child.kill("SIGKILL");
				} catch {
					// 忽略子进程销毁异常
				}
			}
			await bridge.dispose();
		}
	});

	it("适配 pi-traffic-optimization：规整 context_recall 的 TypeBox 字面量 anyOf 为标准 enum，并在纯净模式注入 ctx:// 召回指引", { skip: THIN_CLIENT_DISABLED }, () => {
		const recallRawSchema = {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				id: { type: "string" },
				part: {
					anyOf: [
						{ const: "content", type: "string" },
						{ const: "arguments", type: "string" },
						{ const: "structured", type: "string" },
					],
				},
				imageVersion: {
					anyOf: [{ const: "optimized" }, { const: "original" }],
				},
				view: {
					anyOf: [{ const: "snapshot" }, { const: "current" }, { const: "diff" }],
				},
				fixedVersion: { const: 1 },
				mixedUnion: {
					anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
				},
			},
		};

		const sanitized = sanitizeJsonSchemaForMcp(recallRawSchema) as {
			$schema?: unknown;
			properties: Record<string, Record<string, unknown>>;
		};
		assert.equal(sanitized.$schema, undefined);
		assert.deepEqual(sanitized.properties.part, {
			type: "string",
			enum: ["content", "arguments", "structured"],
		});
		assert.deepEqual(sanitized.properties.imageVersion, {
			type: "string",
			enum: ["optimized", "original"],
		});
		assert.deepEqual(sanitized.properties.view, {
			type: "string",
			enum: ["snapshot", "current", "diff"],
		});
		assert.deepEqual(sanitized.properties.fixedVersion, {
			type: "integer",
			enum: [1],
		});
		// 非字面量联合必须完整保留 anyOf，绝不破坏普通复合类型
		assert.ok(Array.isArray(sanitized.properties.mixedUnion.anyOf));

		// 规整后的 Schema 预校验必须放行合法枚举并拦截非法值
		assert.equal(
			validateToolArguments("context_recall", { id: "ctx://tool/abc", view: "diff", part: "content" }, sanitized).valid,
			true,
		);
		const invalidView = validateToolArguments("context_recall", { view: "invalid_mode" }, sanitized);
		assert.equal(invalidView.valid, false);
		assert.ok(invalidView.formattedError?.includes('"diff"'));

		// 验证 pi-tools 纯净模式下包含 context_recall 时，会在用户上下文 <tool_guidelines> 中附带 ctx:// 优先召回指引
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-traffic-opt-guide-"));
		try {
			const cfg: BridgeConfig = {
				...DEFAULT_BRIDGE_CONFIG,
				toolMode: "pi-tools",
				geminiDir: path.join(tmpRoot, ".gemini"),
			};
			const sysMsg: SystemMessage = {
				role: "system",
				content: "",
				timestamp: 1,
				toolsAdded: [
					{ name: "read", description: "Read", parameters: { type: "object", properties: {} } as never },
					{
						name: "context_recall",
						description: "Recall archived context",
						parameters: recallRawSchema as never,
					},
				],
			};
			const mount = prepareCustomizationMount([sysMsg], cfg, tmpRoot);
			assert.ok(mount.workspaceContextBlock?.includes("ctx://"));
			assert.ok(mount.workspaceContextBlock?.includes("context_recall"));

			// 验证 agy_read 镜像工具能归一化 file:// URI 并提取 StartLine/EndLine 映射为 line 与 limit
			const sampleFile = path.join(tmpRoot, "demo.ts");
			const classifiedRead = classifyAgyToolCall({
				title: "View demo.ts",
				kind: "read",
				rawInput: { uri: pathToFileURL(sampleFile).href, StartLine: 10, EndLine: 24 },
			});
			assert.equal(classifiedRead.mirrorToolName, "agy_read");
			assert.equal(classifiedRead.arguments.path, sampleFile);
			assert.equal(classifiedRead.arguments.line, 10);
			assert.equal(classifiedRead.arguments.limit, 15);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("支持跨 TCP 分片多字节中文解码、可选 null 剥离、超长工具短别名还原、精确公告门控及扩展准则与自定义段挂载", { skip: THIN_CLIENT_DISABLED }, async () => {
		const bridge = new LocalHttpMcpBridge(10_000);
		try {
			const longToolName =
				"mcp__aws_billing_and_cost_management__get_reservation_purchase_recommendation";
			const exposedLongName = toExposedMcpToolName(longToolName);
			assert.ok(
				exposedLongName.length <= MAX_MCP_EXPOSED_TOOL_NAME_LEN,
				`暴露别名长度应 <= ${MAX_MCP_EXPOSED_TOOL_NAME_LEN}: ${exposedLongName}`,
			);
			assert.equal(toExposedMcpToolName("read"), "read");

			// 验证精确公告匹配：read 不应抢占 read_mcp_resource 的前置宣告
			assert.equal(doesAnnouncementMatchTool("mcp_pi_tools_read_mcp_resource", "read"), false);
			assert.equal(
				doesAnnouncementMatchTool("mcp_pi_tools_read_mcp_resource", "read_mcp_resource"),
				true,
			);
			assert.equal(doesAnnouncementMatchTool("list_resources", "read"), false);
			assert.equal(doesAnnouncementMatchTool(`mcp_pi_tools_${exposedLongName}`, longToolName), true);

			// 验证根自引用 $ref: "#" 校验通过且不重复报错
			const recursiveSchema = {
				type: "object",
				properties: {
					label: { type: "string" },
					child: { $ref: "#" },
				},
				required: ["label"],
			};
			assert.equal(
				validateToolArguments("tree", { label: "root", child: { label: "leaf" } }, recursiveSchema)
					.valid,
				true,
			);
			const badTree = validateToolArguments(
				"tree",
				{ label: "root", child: { label: 123 } },
				recursiveSchema,
			);
			assert.equal(badTree.valid, false);
			assert.equal(badTree.issues.length, 1);

			// 验证非 nullable 可选字段上的显式 null 剥离与字符串化数组/对象反序列化
			const complexTool: Tool = {
				name: "search_demo",
				description: "Demo search",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string" },
						offset: { type: "integer" },
						tags: { type: "array", items: { type: "string" } },
						filter: {
							type: "object",
							properties: { lang: { type: "string" }, limit: { type: "integer" } },
							required: ["lang"],
						},
					},
					required: ["query"],
					additionalProperties: false,
				} as never,
			};
			const normArgs = normalizeHostToolArguments(
				"search_demo",
				{
					query: "测试",
					offset: null,
					tags: '["a", "b"]',
					filter: '{"lang":"zh","limit":null}',
				},
				complexTool,
			);
			assert.deepEqual(normArgs, {
				query: "测试",
				tags: ["a", "b"],
				filter: { lang: "zh" },
			});

			// 验证跨 TCP 分片拆开 3 字节 UTF-8 中文字符 + 超长工具短别名调用还原 + 预校验拒绝消费宣告
			let capturedCall: ParkedToolCall | undefined;
			const writeTool: Tool = {
				name: "write",
				description: "Write file",
				parameters: {
					type: "object",
					properties: { path: { type: "string" }, content: { type: "string" } },
					required: ["path", "content"],
				} as never,
			};
			const longTool: Tool = {
				name: longToolName,
				description: "AWS recommendation",
				parameters: {
					type: "object",
					properties: { service: { type: "string" }, cursor: { type: "string" } },
					required: ["service"],
					additionalProperties: false,
				} as never,
			};
			const token = bridge.registerSessionBinding({
				agySessionId: "sess-utf8",
				tools: [writeTool, longTool],
				onParkedCall: (call) => {
					capturedCall = call;
					call.settle({ content: [{ type: "text", text: "ok" }] });
				},
				onHoldTimeout: async () => {},
			});
			const port = await bridge.ensureListening();

			// 1) tools/list 应暴露短别名并在描述标注原名
			const listRes = (await fetch(`http://127.0.0.1:${port}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
			}).then((r) => r.json())) as { result: { tools: Array<{ name: string; description: string }> } };
			const listedLong = listRes.result.tools.find((t) => t.name === exposedLongName);
			assert.ok(listedLong);
			assert.ok(listedLong.description.includes(longToolName));

			// 2) 先宣告一次 write 但发一个缺失必填项的非法调用，验证宣告被及时消费不残留
			bridge.recordAcpToolAnnouncement("sess-utf8", "mcp_pi_tools_write");
			const badCallRes = (await fetch(`http://127.0.0.1:${port}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "write", arguments: { path: "only-path.txt" } },
				}),
			}).then((r) => r.json())) as { result: { isError: boolean } };
			assert.equal(badCallRes.result.isError, true);
			bridge.markSessionTurnCancelled("sess-utf8");
			const cancelledAfterReject = (await fetch(`http://127.0.0.1:${port}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: { name: "write", arguments: { path: "a.txt", content: "hi" } },
				}),
			}).then((r) => r.json())) as { result: { isError: boolean; content: Array<{ text: string }> } };
			assert.equal(cancelledAfterReject.result.isError, true);
			assert.ok(cancelledAfterReject.result.content[0].text.includes("cancelled"));
			bridge.clearSessionCancelled("sess-utf8");

			// 3) 将多字节中文 JSON 请求体在 3 字节 UTF-8 字符中间强行拆成多帧发送，验证无 U+FFFD 乱码且短别名还原为原工具名
			bridge.recordAcpToolAnnouncement("sess-utf8", `mcp_pi_tools_${exposedLongName}`);
			const chinesePayload = JSON.stringify({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: {
					name: exposedLongName,
					arguments: { service: "中文跨分片完整性校验🚀测试", cursor: null },
				},
			});
			const payloadBuf = Buffer.from(chinesePayload, "utf8");
			const zhOffset = payloadBuf.indexOf(Buffer.from("跨", "utf8"));
			assert.ok(zhOffset > 0);
			// 在“跨”字第 1 个字节与第 2 个字节之间切分
			const part1 = payloadBuf.subarray(0, zhOffset + 1);
			const part2 = payloadBuf.subarray(zhOffset + 1, zhOffset + 2);
			const part3 = payloadBuf.subarray(zhOffset + 2);

			const splitResp = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
				const req = http.request(
					{
						hostname: "127.0.0.1",
						port,
						path: "/mcp",
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${token}`,
							"Transfer-Encoding": "chunked",
						},
					},
					(res) => {
						const chunks: Buffer[] = [];
						res.on("data", (c: Buffer) => chunks.push(c));
						res.on("end", () =>
							resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
						);
					},
				);
				req.on("error", reject);
				req.write(part1);
				setTimeout(() => {
					req.write(part2);
					setTimeout(() => {
						req.write(part3);
						req.end();
					}, 8);
				}, 8);
			});
			assert.equal(splitResp.statusCode, 200);
			assert.ok(capturedCall);
			assert.equal(capturedCall.toolName, longToolName, "短别名调用应自动还原为完整原始工具名");
			assert.equal(capturedCall.arguments.service, "中文跨分片完整性校验🚀测试");
			assert.equal("cursor" in capturedCall.arguments, false, "非必填字段上的显式 null 应被自动剥离");

			// 4) 验证 stdio-shim 在收到 401 非 2xx 响应时输出合规 JSON-RPC 错误帧而非裸错误体
			const badShimSpec = buildInlineStdioShimCommand(`http://127.0.0.1:${port}/mcp`, "invalid-token");
			const shimEnv: NodeJS.ProcessEnv = { ...process.env };
			for (const pair of badShimSpec.env) {
				shimEnv[pair.name] = pair.value;
			}
			const shimStdout = await new Promise<string>((resolve, reject) => {
				const child = spawn(badShimSpec.command, badShimSpec.args, {
					env: shimEnv,
					stdio: ["pipe", "pipe", "pipe"],
				});
				let out = "";
				child.stdout.on("data", (c: Buffer) => {
					out += c.toString("utf8");
					if (out.includes("\n")) {
						child.stdin.end();
					}
				});
				child.on("error", reject);
				child.on("close", () => resolve(out));
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping", params: {} })}\n`);
			});
			const shimOut = JSON.parse(shimStdout.trim()) as {
				jsonrpc: string;
				id: number;
				error?: { code: number; message: string };
			};
			assert.equal(shimOut.jsonrpc, "2.0");
			assert.equal(shimOut.id, 99);
			assert.ok(shimOut.error?.message.includes("401"));

			// 5) 验证 pi-tools 纯净模式下完整挂载扩展工具 promptGuidelines、<mcp_servers> 指引、addendum 与自定义段
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-ext-guidelines-"));
			try {
				const sysMsg: SystemMessage = {
					role: "system",
					content: "",
					timestamp: 1,
					toolsAdded: [
						{ name: "read", description: "Read", parameters: { type: "object", properties: {} } as never },
						{ name: "codemode", description: "Codemode", parameters: { type: "object", properties: {} } as never },
					],
					sections: {
						mcp_servers: "<mcp_servers>\n- mcp__demo (codemode): Demo MCP\n</mcp_servers>",
						addendum: "<addendum>\nAlways verify edge cases.\n</addendum>",
						custom_memory: "Remember workspace conventions.",
					},
				};
				const mount = prepareCustomizationMount(
					[sysMsg],
					{ ...DEFAULT_BRIDGE_CONFIG, toolMode: "pi-tools", geminiDir: path.join(tmpDir, ".gemini") },
					tmpDir,
					process.env,
					{
						registeredTools: [
							{
								name: "codemode",
								promptGuidelines: [
									"Use codemode to batch independent tool calls (Promise.allSettled)",
								],
							},
						],
					},
				);
				assert.ok(mount.workspaceContextBlock?.includes("Promise.allSettled"));
				assert.ok(mount.workspaceContextBlock?.includes("searchTools / describeNamespace"));
				assert.ok(mount.workspaceContextBlock?.includes("Always verify edge cases."));
				assert.ok(mount.workspaceContextBlock?.includes("<custom_memory>"));
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		} finally {
			await bridge.dispose();
		}
	});
});
