import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	buildAgySpawnSpec,
	quoteWindowsCmdArg,
	resolveAgyBinary,
} from "../src/acp/binary-resolver.ts";
import { AcpProcessManager } from "../src/acp/process-manager.ts";
import type { AcpAvailableModel, AcpConfigOption } from "../src/acp/protocol.ts";
import {
	aggregateAcpModels,
	getSeedModels,
	probeLiveAntigravityCatalog,
	readCachedCatalog,
	resolveBuiltinModelCost,
	resolveSessionModelSelection,
	writeCachedCatalog,
} from "../src/catalog/model-discovery.ts";
import {
	DEFAULT_BRIDGE_CONFIG,
	loadBridgeConfig,
	resolveEffectiveFlags,
} from "../src/config.ts";
import { THIN_CLIENT_DISABLED } from "./thin-client-skip.ts";

const SAMPLE_AVAILABLE_MODELS: AcpAvailableModel[] = [
	{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
	{ modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
	{ modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
	{ modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
	{ modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
	{ modelId: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
	{ modelId: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
	{ modelId: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)" },
	{ modelId: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
	{ modelId: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
	{ modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
	{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

const SAMPLE_CONFIG_OPTIONS: AcpConfigOption[] = [
	{
		id: "model",
		name: "Model",
		type: "select",
		currentValue: "gemini-4-neon",
		options: [
			{ value: "gemini-4-neon", name: "Gemini 4 Neon" },
			{ value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
			{ value: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)" },
			{ value: "claude-opus-5-5", name: "Claude Opus 5.5" },
			{ value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
		],
	},
	{
		id: "thought_level",
		name: "Thinking Level",
		type: "select",
		currentValue: "high",
		options: [
			{ value: "low", name: "Low" },
			{ value: "medium", name: "Medium" },
			{ value: "high", name: "High" },
			{ value: "xhigh", name: "Extra" },
		],
	},
];

describe("配置加载与有效开关推导", () => {
	it("遵循环境变量 > 受信项目配置 > 全局配置 > 默认值优先级，并隔离未受信项目配置", { skip: THIN_CLIENT_DISABLED }, () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-cfg-"));
		try {
			const agentDir = path.join(tmpRoot, "agent");
			const projectDir = path.join(tmpRoot, "workspace");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });

			fs.writeFileSync(
				path.join(agentDir, "antigravity.json"),
				JSON.stringify({
					toolMode: "pi-tools",
					bridgePiMcp: true,
					mcpHoldLimitMs: 150000,
				}),
			);
			fs.writeFileSync(
				path.join(projectDir, ".pi", "antigravity.json"),
				JSON.stringify({
					toolMode: "agy-tools",
					bridgePiMcp: false,
				}),
			);

			// 未受信时不加载项目级覆盖
			const untrusted = loadBridgeConfig({
				cwd: projectDir,
				isProjectTrusted: false,
				env: { PI_CODING_AGENT_DIR: agentDir },
			});
			assert.equal(untrusted.toolMode, "pi-tools");
			assert.equal(untrusted.bridgePiMcp, true);

			// 受信时加载项目级覆盖
			const trusted = loadBridgeConfig({
				cwd: projectDir,
				isProjectTrusted: true,
				env: { PI_CODING_AGENT_DIR: agentDir },
			});
			assert.equal(trusted.toolMode, "agy-tools");
			assert.equal(trusted.bridgePiMcp, false);

			// 环境变量最高优先级覆盖
			const envOverridden = loadBridgeConfig({
				cwd: projectDir,
				isProjectTrusted: true,
				env: {
					PI_CODING_AGENT_DIR: agentDir,
					PI_AGY_TOOL_MODE: "hybrid",
					PI_AGY_BRIDGE_MCP: "on",
				},
			});
			assert.equal(envOverridden.toolMode, "hybrid");
			assert.equal(envOverridden.bridgePiMcp, true);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("开箱默认使用 pi-tools，且 auto 开关在 pi-tools 与 agy-tools 模式下自动切换合理默认值", { skip: THIN_CLIENT_DISABLED }, () => {
		const tmpEmptyAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-default-"));
		try {
			const defaultCfg = loadBridgeConfig({ env: { PI_CODING_AGENT_DIR: tmpEmptyAgentDir } });
			assert.equal(defaultCfg.toolMode, "pi-tools");
			const defaultFlags = resolveEffectiveFlags(defaultCfg);
			assert.equal(defaultFlags.bridgePiMcp, true);
			assert.equal(defaultFlags.bridgePiSkills, true);
			assert.equal(defaultFlags.bridgePiAgentsMd, true);
			assert.equal(defaultFlags.agyInheritCustomizations, false);
		} finally {
			fs.rmSync(tmpEmptyAgentDir, { recursive: true, force: true });
		}

		const agyToolsCfg = loadBridgeConfig({ env: { PI_AGY_TOOL_MODE: "agy-tools" } });
		const agyFlags = resolveEffectiveFlags(agyToolsCfg);
		assert.equal(agyFlags.bridgePiMcp, false);
		assert.equal(agyFlags.bridgePiSkills, false);
		assert.equal(agyFlags.bridgePiAgentsMd, false);
		assert.equal(agyFlags.agyInheritCustomizations, true);
	});
});

describe("跨平台可执行文件定位", () => {
	it("在 Windows 模拟环境下优先选择 .exe 并识别 .cmd 包装脚本", () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-bin-win-"));
		try {
			const binDir = path.join(tmpRoot, "Programs", "Antigravity", "bin");
			fs.mkdirSync(binDir, { recursive: true });
			const exePath = path.join(binDir, "agy.exe");
			const cmdPath = path.join(binDir, "agy.cmd");
			fs.writeFileSync(cmdPath, "@echo off\r\n");
			fs.writeFileSync(exePath, "MZ");

			const foundExe = resolveAgyBinary({
				platform: "win32",
				homeDir: tmpRoot,
				env: {
					LOCALAPPDATA: tmpRoot,
					PATH: "",
					PATHEXT: ".CMD;.EXE",
				},
			});
			assert.ok(foundExe);
			assert.equal(foundExe.binPath, exePath);
			assert.equal(foundExe.isWindowsWrapperScript, false);

			fs.unlinkSync(exePath);
			const foundCmd = resolveAgyBinary({
				platform: "win32",
				homeDir: tmpRoot,
				env: {
					LOCALAPPDATA: tmpRoot,
					PATH: binDir,
					PATHEXT: ".CMD;.EXE",
				},
			});
			assert.ok(foundCmd);
			assert.equal(foundCmd.binPath, cmdPath);
			assert.equal(foundCmd.isWindowsWrapperScript, true);

			// 验证 Windows .cmd 包装脚本含空格及特殊字符参数通过 cmd.exe /d /s /c + windowsVerbatimArguments 安全引用
			assert.equal(quoteWindowsCmdArg("C:\\Users\\John Doe\\.gemini"), '"C:\\Users\\John Doe\\.gemini"');
			assert.equal(quoteWindowsCmdArg("C:\\My Dir\\"), '"C:\\My Dir\\\\"');
			assert.equal(quoteWindowsCmdArg('C:\\My Dir\\"quoted"'), '"C:\\My Dir\\\\""quoted"""');
			assert.equal(quoteWindowsCmdArg("--flag=a;b,c"), '"--flag=a;b,c"');
			assert.equal(quoteWindowsCmdArg("%USERPROFILE%\\agy"), '"%%USERPROFILE%%\\agy"');
			const cmdSpec = buildAgySpawnSpec(
				{
					binPath: "C:\\Users\\John Doe\\AppData\\Local\\Programs\\Antigravity\\bin\\agy.cmd",
					isWindowsWrapperScript: true,
					source: "standard-location",
				},
				["acp", "--gemini-dir", "C:\\Users\\John Doe\\.gemini"],
				{ ComSpec: "C:\\Windows\\System32\\cmd.exe" },
			);
			assert.equal(cmdSpec.command, "C:\\Windows\\System32\\cmd.exe");
			assert.equal(cmdSpec.windowsVerbatimArguments, true);
			assert.deepEqual(cmdSpec.args.slice(0, 3), ["/d", "/s", "/c"]);
			assert.ok(
				cmdSpec.args[3].includes('"C:\\Users\\John Doe\\AppData\\Local\\Programs\\Antigravity\\bin\\agy.cmd"'),
			);
			assert.ok(cmdSpec.args[3].includes('"C:\\Users\\John Doe\\.gemini"'));

			const exeSpec = buildAgySpawnSpec(
				{
					binPath: "C:\\Users\\John Doe\\agy.exe",
					isWindowsWrapperScript: false,
					source: "standard-location",
				},
				["acp", "--gemini-dir", "C:\\Users\\John Doe\\.gemini"],
			);
			assert.equal(exeSpec.command, "C:\\Users\\John Doe\\agy.exe");
			assert.equal(exeSpec.windowsVerbatimArguments, undefined);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("并发进程获取隔离首个取消信号、合并并发模型探测并自动回收已取消的孤儿 session/new", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-probe-race-"));
		const statePath = path.join(tmpRoot, "probe-state.json");
		const mockBin = path.join(tmpRoot, "mock-probe-agy.mjs");
		const convDir = path.join(tmpRoot, ".gemini", "antigravity-cli", "conversations");
		fs.mkdirSync(convDir, { recursive: true });

		const script = `#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const stateFile = ${JSON.stringify(statePath)};
const convDir = ${JSON.stringify(convDir)};
const state = { initCount: 0, newCount: 0, closedIds: [] };
function flushState() { fs.writeFileSync(stateFile, JSON.stringify(state)); }
flushState();

let seq = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    state.initCount++;
    flushState();
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Mock", version: "1.5.13" } }
      }) + "\\n");
    }, 35);
    return;
  }
  if (msg.method === "session/new") {
    state.newCount++;
    const sid = "probe-sess-" + (++seq);
    fs.writeFileSync(path.join(convDir, sid + ".db"), "sqlite-placeholder");
    flushState();
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: sid,
          models: { availableModels: [{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" }] },
          configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] }]
        }
      }) + "\\n");
    }, 45);
    return;
  }
  if (msg.method === "session/close") {
    state.closedIds.push(msg.params?.sessionId);
    flushState();
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  }
});
`;
		fs.writeFileSync(mockBin, script, { mode: 0o755 });
		let binToUse = mockBin;
		if (process.platform === "win32") {
			const cmdWrap = path.join(tmpRoot, "mock-probe-agy.cmd");
			fs.writeFileSync(cmdWrap, `@node "${mockBin}" %*\r\n`);
			binToUse = cmdWrap;
		}

		const cfg = {
			...DEFAULT_BRIDGE_CONFIG,
			agyBin: binToUse,
			geminiDir: path.join(tmpRoot, ".gemini"),
		};
		const pm = new AcpProcessManager();
		// The mock rewrites its state file in place (truncate, then write), so a read can
		// land on an empty or half-written file; read again until the JSON is complete.
		const readProbeState = (): unknown => {
			for (let attempt = 0; ; attempt++) {
				try {
					return JSON.parse(fs.readFileSync(statePath, "utf8"));
				} catch (error) {
					if (!(error instanceof SyntaxError) || attempt >= 50) throw error;
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
				}
			}
		};

		try {
			// 1. 并发 acquire：调用者 1 在 initialize 途中 abort，调用者 2 必须正常拿到同一健康连接
			const ac1 = new AbortController();
			const p1 = pm.acquire(cfg, undefined, ac1.signal);
			const p2 = pm.acquire(cfg, undefined);
			setTimeout(() => ac1.abort(), 10);
			await assert.rejects(p1);
			const conn = await p2;
			assert.equal(conn.isAlive, true);

			// 2. 调用者在 session/new 途中 abort：迟到响应到达后必须自动触发 session/close 并清理孤儿 .db
			const acOrphan = new AbortController();
			const orphanReq = conn.request("session/new", { cwd: tmpRoot, mcpServers: [] }, { signal: acOrphan.signal });
			setTimeout(() => acOrphan.abort(), 10);
			await assert.rejects(orphanReq);

			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline) {
				const st = readProbeState() as { closedIds: string[] };
				if (st.closedIds.includes("probe-sess-1") && !fs.existsSync(path.join(convDir, "probe-sess-1.db"))) {
					break;
				}
				await new Promise((r) => setTimeout(r, 15));
			}
			const afterOrphan = readProbeState() as { closedIds: string[] };
			assert.ok(afterOrphan.closedIds.includes("probe-sess-1"));
			assert.equal(fs.existsSync(path.join(convDir, "probe-sess-1.db")), false);

			// 3. 4 个并发模型探测共享单一 Singleflight，仅触发 1 次新的 session/new，且通过 env 隔离写入目录绝不污染用户全局缓存
			const isolatedAgentDir = path.join(tmpRoot, "isolated-pi-agent");
			const isolatedEnv: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: isolatedAgentDir };
			const [s1, s2, s3, s4] = await Promise.all([
				probeLiveAntigravityCatalog(pm, cfg, tmpRoot, { force: true, env: isolatedEnv }),
				probeLiveAntigravityCatalog(pm, cfg, tmpRoot, { force: true, env: isolatedEnv }),
				probeLiveAntigravityCatalog(pm, cfg, tmpRoot, { force: true, env: isolatedEnv }),
				probeLiveAntigravityCatalog(pm, cfg, tmpRoot, { force: true, env: isolatedEnv }),
			]);
			assert.equal(s1.models.length, s2.models.length);
			assert.equal(s3.models.length, s4.models.length);
			assert.equal(
				fs.existsSync(path.join(isolatedAgentDir, "cache", "antigravity-models.json")),
				true,
			);
			const finalState = readProbeState() as {
				initCount: number;
				newCount: number;
				closedIds: string[];
			};
			assert.equal(finalState.initCount, 1);
			assert.equal(finalState.newCount, 2); // 1 次孤儿测试 + 1 次合并探测
			assert.ok(finalState.closedIds.includes("probe-sess-2"));
			assert.equal(fs.existsSync(path.join(convDir, "probe-sess-2.db")), false);

			// 4. 在 initialize 尚未完成时调用 disposeAll() 必须回收正在初始化的进程，绝不残留孤儿连接
			const pmInitDispose = new AcpProcessManager();
			const slowInit = pmInitDispose.acquire(cfg, undefined);
			await new Promise((r) => setTimeout(r, 15));
			await pmInitDispose.disposeAll();
			await assert.rejects(slowInit);
		} finally {
			await pm.disposeAll();
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});

describe("双轨模型家族聚合与 Thinking 档位解析", () => {
	it("将多档位变体聚合为单一模型条目，同时完整保留单档位模型原始 ID", () => {
		const { models, modelEfforts } = aggregateAcpModels(
			SAMPLE_AVAILABLE_MODELS,
			SAMPLE_CONFIG_OPTIONS,
		);

		const ids = models.map((m) => m.id);
		assert.deepEqual(ids, [
			"gemini-4-neon",
			"gemini-4-carbon",
			"gemini-pro-orchestrator",
			"claude-opus-5-5",
			"gpt-oss-120b-medium",
		]);

		assert.deepEqual(modelEfforts["gemini-4-neon"], ["low", "medium", "high", "xhigh"]);
		assert.deepEqual(modelEfforts["gemini-4-carbon"], ["low", "medium", "high"]);
		assert.deepEqual(modelEfforts["gemini-pro-orchestrator"], []);
		assert.deepEqual(modelEfforts["gpt-oss-120b-medium"], ["medium"]);

		const carbon = models.find((m) => m.id === "gemini-4-carbon")!;
		assert.equal(carbon.reasoning, true);
		assert.equal(carbon.thinkingLevelMap?.high, "high");
		assert.equal(carbon.thinkingLevelMap?.xhigh, null);
		assert.equal(carbon.thinkingLevelMap?.minimal, null);

		const orchestrator = models.find((m) => m.id === "gemini-pro-orchestrator")!;
		assert.equal(orchestrator.reasoning, false);
	});

	it("兼容双阶段裸模型下发与纯后缀模型 ID 回退", () => {
		// 1. 标准裸 ID + thought_level
		const neonSel = resolveSessionModelSelection(
			"gemini-4-neon",
			"xhigh",
			SAMPLE_CONFIG_OPTIONS,
			SAMPLE_AVAILABLE_MODELS,
		);
		assert.equal(neonSel.configModelValue, "gemini-4-neon");
		assert.equal(neonSel.configThoughtLevel, "xhigh");

		// 2. Carbon 请求不支持的 xhigh 时自动就近降级至 high
		const carbonClamped = resolveSessionModelSelection(
			"gemini-4-carbon",
			"xhigh",
			SAMPLE_CONFIG_OPTIONS,
			SAMPLE_AVAILABLE_MODELS,
		);
		assert.equal(carbonClamped.configModelValue, "gemini-4-carbon");
		assert.equal(carbonClamped.configThoughtLevel, "high");

		// 3. 服务端仅提供后缀 ID 时自动拼接后缀下发
		const suffixOnlyOpts: AcpConfigOption[] = [
			{
				id: "model",
				name: "Model",
				type: "select",
				currentValue: "gemini-4-neon-high",
				options: SAMPLE_AVAILABLE_MODELS.map((m) => ({ value: m.modelId, name: m.name })),
			},
		];
		const fallbackSel = resolveSessionModelSelection(
			"gemini-4-neon",
			"medium",
			suffixOnlyOpts,
			SAMPLE_AVAILABLE_MODELS,
		);
		assert.equal(fallbackSel.configModelValue, "gemini-4-neon-medium");
		assert.equal(fallbackSel.configThoughtLevel, undefined);
		assert.equal(fallbackSel.effectiveEffort, "medium");
	});

	it("从 Pi 内置模型目录自动解析官方参考定价，并自动为旧版零费用磁盘缓存补全价格", () => {
		const { models } = aggregateAcpModels(SAMPLE_AVAILABLE_MODELS, SAMPLE_CONFIG_OPTIONS);
		const neon = models.find((m) => m.id === "gemini-4-neon")!;
		const carbon = models.find((m) => m.id === "gemini-4-carbon")!;
		const orch = models.find((m) => m.id === "gemini-pro-orchestrator")!;
		const opus = models.find((m) => m.id === "claude-opus-5-5")!;
		const gptOss = models.find((m) => m.id === "gpt-oss-120b-medium")!;

		assert.ok(neon.cost.input > 0 && neon.cost.output > 0 && neon.cost.cacheRead > 0);
		assert.ok(carbon.cost.input > 0 && carbon.cost.output > 0);
		assert.deepEqual(orch.cost, carbon.cost);
		assert.ok(opus.cost.input > 0 && opus.cost.output > 0 && opus.cost.cacheWrite > 0);
		assert.ok(gptOss.cost.input > 0 && gptOss.cost.output > 0);

		// 支持 -thinking 尾缀与 -preview 自动映射，以及未知模型安全回退零费用
		const claudeThinkingCost = resolveBuiltinModelCost("claude-opus-4-6-thinking");
		assert.ok(claudeThinkingCost.input > 0 && claudeThinkingCost.output > 0);
		const gemini31ProCost = resolveBuiltinModelCost("gemini-3.1-pro");
		assert.ok(gemini31ProCost.input > 0 && gemini31ProCost.output > 0);
		assert.deepEqual(resolveBuiltinModelCost("unknown-future-model-xyz"), {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});

		// 种子模型均具备有效价格
		for (const seed of getSeedModels()) {
			assert.ok(seed.cost.input > 0 && seed.cost.output > 0, `种子模型 ${seed.id} 应具备非零价格`);
		}

		// 旧版全零价格缓存读出时必须自动补全非零定价
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-cost-hydrate-"));
		try {
			const isolatedEnv: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: tmpRoot };
			writeCachedCatalog(
				{
					version: 1,
					updatedAt: Date.now(),
					models: [
						{
							...neon,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
					modelEfforts: { "gemini-4-neon": ["low", "medium", "high", "xhigh"] },
				},
				isolatedEnv,
			);
			const hydrated = readCachedCatalog(isolatedEnv);
			assert.ok(hydrated);
			assert.equal(hydrated.models[0].cost.input, neon.cost.input);
			assert.equal(hydrated.models[0].cost.output, neon.cost.output);
			assert.equal(hydrated.models[0].cost.cacheRead, neon.cost.cacheRead);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});
