# Changelog

Fork releases of pi-antigravity-thin-client. The upstream changelog of pi-antigravity-bridge is in [docs/upstream/CHANGELOG.md](docs/upstream/CHANGELOG.md).

## Unreleased

## 0.1.0 - 2026-11-25

Upstream base: pi-antigravity-bridge 0.1.16.

First release under the new name, as a thin client for consumer Antigravity accounts.

### Thin-client policy

- Pins the `agy-tools` mode. Pi's MCP servers, skills and `AGENTS.md` are never passed to Antigravity, and Antigravity's conversation databases are never written.
- Sends only prompts typed in the interactive Pi session, each once. Refuses Pi's automatic retries, `/goal` continuations, injected context, extension messages, RPC input and `!` shell output before any session work. Never makes up a prompt such as "Continue.".
- Refuses to replay earlier conversation, compaction summaries or another model's history, also on the new session-restore path of upstream 0.1.16.
- Refuses auxiliary requests (compaction, titles, recaps) and headless use (subagents, workflows, `pi -p`).
- An empty quota fails as `Antigravity quota exceeded (429)`, which Pi does not retry.

### Background activity

- A widget above the editor shows Antigravity's background tasks and timers, the turns it takes on its own, and its subagents with their model and current activity.
- A session card shows each turn Antigravity took on its own; it is never sent to a model.
- Tool cards say when a command went to the background, when a timer was set and which subagent was started.
- `PI_AGY_TRACE` logs every `session/update` from Antigravity to a local JSONL file.

### Steering

- A message typed while Antigravity works waits for the running turn instead of cancelling it, so background tasks and subagents keep running. Esc still cancels.

### Package

- Reports `pi-antigravity-thin-client` as the ACP client name.
- Published from GitHub Actions with npm Trusted Publishing and provenance.
