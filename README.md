# Pi Antigravity Bridge

> **Thin-client fork (local).** Based on upstream v0.1.15 (`c74fd17`). For consumer `oauth-personal`
> use this fork keeps Antigravity as the agent and Pi as a frontend only (`src/thin-client-policy.ts`):
> `agy-tools` mode is pinned; Pi MCP servers, skills and `AGENTS.md` are never bridged; agy's
> conversation databases are never written; earlier conversation, compaction summaries or another
> model's history are never replayed; auxiliary requests (compaction, titles, recaps) and headless
> use (subagents, workflows, `pi -p`) are refused. Start a new Pi session for each Antigravity
> conversation. Upstream tests for the disabled features are skipped (`test/thin-client-skip.ts`).
>
> No automated loops (`src/human-prompt-gate.ts`): only prompts typed in the Pi session reach agy,
> each once. Pi's automatic retries, `/goal` continuations, injected context, extension messages
> (`pi.sendMessage`, `pi.sendUserMessage`), RPC input and `!` shell output are refused before any
> session work; the bridge never makes up a prompt of its own. An empty quota fails as
> `quota exceeded (429)`, which Pi does not retry. Prompts typed into the TUI by another program
> (tmux scripts, orchestrators, watchdogs) look typed and cannot be told apart: never drive an
> Antigravity session that way.
>
> Background work (`src/background/`): agy moves long commands and `schedule` timers into
> background tasks and, when one ends, takes a turn on its own without a client prompt. ACP
> clients see nothing of it, so the bridge reads agy's local conversation files
> (`brain/<id>/.system_generated/`: transcript, task notes, task logs) and shows a live widget
> for running tasks and a card (`antigravity-autonomous` session entry, never in the model
> context) for every turn agy took by itself. Tool cards say when a command went to the
> background or a timer was set. This only reads local files; nothing is sent to agy.
> `PI_AGY_TRACE=1` (or a file path) logs every `session/update` agy sends to a local JSONL file.
>
> Steering: a message typed while agy works no longer cancels the agy turn (cancelling stops
> agy's background tasks and subagents). It waits and goes out as the next prompt when the
> running agy turn ends; agy's answer continues the same Pi step. Esc still cancels.

将 Google Antigravity CLI（`agy`）作为原生模型与 Agent 后端接入 [Pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent`），在完整的 Pi TUI 交互界面中直接使用 Antigravity 提供的模型、思考档位与工具生态。

<p align="center">
  <img src="https://raw.githubusercontent.com/onprs/Pi-Antigravity-Bridge/main/assets/tui-demo.svg" alt="Pi Antigravity Bridge TUI 交互演示" width="100%" />
</p>

## 功能特性

- **原生模型与思考控制**：通过 `/model` 选择当前账号可用的 Gemini、Claude 等模型，直接联动 Pi 的 Thinking 档位切换与思考块折叠展示。
- **三种工具运行模式**：
  - `pi-tools`（默认）：通过标准 MCP 挂载并使用 Pi 内置工具、第三方 Pi 扩展工具与审批流程，保持原生 Pi 交互体验。
  - `agy-tools`：使用 Antigravity 原生文件、终端、搜索、Subagents 与沙箱能力，并在 Pi 聊天流中呈现为原生工具卡片与对比 Diff。
  - `hybrid`：同时启用 Antigravity 原生工具与 Pi 专属扩展工具。
- **可选生态挂载**：支持独立控制是否将 Pi 的 MCP、Skills 与 `AGENTS.md` 规则桥接至 Antigravity。
- **完整会话体验**：支持多模态图片输入、运行中实时转向（Steering）、`/resume` 会话恢复、`/fork` 与 `/tree` 分支导航、`/compact` 上下文压缩以及导入本机已有的 Antigravity 会话。
- **跨平台支持**：支持 Windows、Ubuntu（Linux）与 macOS。

## 环境要求

- Node.js `>= 22.5.0`
- 已安装 `@earendil-works/pi-coding-agent`（`pi` 命令可用）
- 已安装官方 Google Antigravity CLI（`agy` 命令可用，推荐 `>= 1.5.13`）

## 安装

通过 npm 安装：

```bash
pi install npm:pi-antigravity-bridge
```

或通过 GitHub 仓库安装：

```bash
pi install https://github.com/onprs/Pi-Antigravity-Bridge.git
```

单次会话临时加载试用：

```bash
pi -e npm:pi-antigravity-bridge
```

升级与卸载：

```bash
pi update --extensions
pi remove npm:pi-antigravity-bridge
```

## 快速开始

1. 确保本机 `agy` 已登录（若尚未登录，可在终端运行 `agy acp --login`，或在启动 `pi` 后执行 `/agy login`）。
2. 启动 `pi`，输入 `/model` 并选择 `antigravity` 分组下的模型（如 `gemini-4-neon`、`gemini-4-carbon`、`claude-sonnet-5-5`）。
3. 使用快捷键循环切换 Thinking 档位，直接开始对话。

## 斜杠命令

在 Pi 交互界面中可使用以下 `/agy` 命令：

| 命令 | 说明 |
|---|---|
| `/agy` 或 `/agy status` | 查看可执行文件路径、订阅等级、当前模式、桥接状态与上下文占用 |
| `/agy mode [pi-tools \| agy-tools \| hybrid]` | 查看或切换工具运行模式 |
| `/agy bridge [mcp \| skills \| agents-md] [on \| off \| auto]` | 控制是否将 Pi 的 MCP、Skills 或 `AGENTS.md` 桥接至 Antigravity |
| `/agy agent-mode [default \| accept-edits \| plan]` | 在 `agy-tools` 或 `hybrid` 模式下切换 Antigravity 执行权限策略 |
| `/agy refresh` | 重新探测并刷新当前账号可用的模型列表 |
| `/agy sessions` | 浏览本机 Antigravity 历史会话并导入为新的 Pi 会话 |
| `/agy login` / `/agy logout` | 引导执行官方 `agy` 登录或登出当前账号 |

## 配置说明

全局配置文件位于 `~/.pi/agent/antigravity.json`（受信项目可在项目根目录 `.pi/antigravity.json` 覆盖配置）：

```json
{
  "toolMode": "pi-tools",
  "bridgePiMcp": "auto",
  "bridgePiSkills": "auto",
  "bridgePiAgentsMd": "auto",
  "piMcpBridgeStrategy": "via-host",
  "agyInheritCustomizations": "auto",
  "agyInheritMcp": "auto",
  "shareAgySkillsToPi": false,
  "agyExecutionMode": "default",
  "processPerSession": true,
  "enableSqliteFork": true,
  "sandbox": false,
  "mcpHoldLimitMs": 165000
}
```

### 常用配置项说明

- `toolMode`：默认工具模式，可选 `"pi-tools"`、`"agy-tools"`、`"hybrid"`。
- `bridgePiMcp` / `bridgePiSkills` / `bridgePiAgentsMd`：设为 `"auto"` 时，在 `pi-tools` 模式下默认开启，在 `agy-tools` 与 `hybrid` 模式下默认关闭；设为 `true` 或 `false` 时在所有模式下强制生效。
- `shareAgySkillsToPi`：设为 `true` 时，将 `~/.gemini/config/skills` 与项目 `.agents/skills` 中的技能同步提供给 Pi。
- `agyExecutionMode`：控制 Antigravity 原生工具权限行为，可选 `"default"`（按规则询问）、`"accept-edits"`（自动批准工作区文件修改）、`"plan"`（先规划后执行）。
- `sandbox`：设为 `true` 时启用 Antigravity 终端沙箱。

### 环境变量

| 环境变量 | 作用 |
|---|---|
| `PI_AGY_BIN` | 指定 `agy` 可执行文件的完整路径 |
| `PI_AGY_GEMINI_DIR` | 指定自定义 Gemini 数据目录（默认 `~/.gemini`） |
| `PI_AGY_TOOL_MODE` | 覆盖启动默认工具模式（`pi-tools`、`agy-tools`、`hybrid`） |
| `PI_AGY_BRIDGE_MCP` | 覆盖 `bridgePiMcp`（`true`、`false`、`auto`） |
| `PI_AGY_BRIDGE_SKILLS` | 覆盖 `bridgePiSkills`（`true`、`false`、`auto`） |
| `PI_AGY_BRIDGE_AGENTS_MD` | 覆盖 `bridgePiAgentsMd`（`true`、`false`、`auto`） |

## 账号与隐私说明

- 本扩展不读取、不解密、不复制或保存 `agy` 内部的任何 OAuth 令牌与账号凭据，认证状态完全由本机官方 `agy` 自行管理。
- 本扩展保持 Antigravity 官方系统提示词不变，仅通过官方公开的 ACP、MCP 与原生插件清单机制挂载所需工具、规则及技能。
- Gemini 系列模型面向所有客户端开放；Claude 等第三方模型的可用范围取决于当前账号权限与 Antigravity 官方客户端开放策略。

## 开源协议

[MIT](./LICENSE)
