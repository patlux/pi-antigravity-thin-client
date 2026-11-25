# Changelog

Fork releases of pi-antigravity-thin-client. The upstream changelog of pi-antigravity-bridge is in [docs/upstream/CHANGELOG.md](docs/upstream/CHANGELOG.md).

## Unreleased

## 0.2.1 - 2026-11-25

Upstream base: pi-antigravity-bridge 0.1.16.

### Changed

- The README names the goal of the package: to use an Antigravity subscription sign-in only the way Google allows. It quotes the boundary from Google's AI Developers Forum with its sources, shows how the package keeps each condition, and says what it cannot promise: the boundary is not in Google's terms or docs, and the earlier note called the forum replies statements of Google staff, but their author is not marked as staff.

### Fixed

- The widget above the editor could leave pieces of a command on the editor border and the input line. agy's title for a multi-line command (and a background task without a short label) put line breaks into one widget line, so Pi's row count went off. Every widget line is now one terminal row.

### Added

- Tests that agy receives exactly the typed text, without Pi's system prompt, rules or tools, and that no Pi tool or MCP tool reaches Antigravity whatever the configuration says.

## 0.2.0 - 2026-11-25

Upstream base: pi-antigravity-bridge 0.1.16.

### Added

- README screenshots of the background widget, timers, the cards for turns Antigravity takes on its own, subagents and messages typed during a turn, plus a gallery preview image (`pi.image`). `scripts/screenshots/capture.mjs` takes them again against a scripted stand-in for `agy`.

### Removed

- `/agy mode` and `/agy bridge`. The thin client always uses Antigravity's own tools and never passes Pi's MCP servers, skills or `AGENTS.md`; both subcommands now only say so.
- The `AGY:native(default)` footer badge. It showed the tool mode, which nobody can change here.

### Changed

- All interface texts are English: upstream's Chinese notifications, errors and `/agy` help, and the fork's German widget, card and tool texts. The autonomous-turn card is now "Antigravity · on its own".

### Fixed

- A subagent that waits for its own timer shows "waiting for timer" right away, before agy writes the answer that ends its turn.
- `/agy mode pi-tools` reported a switch, saved `toolMode` to `antigravity.json` and took Antigravity's mirror tools out of Pi's active tools, while the bridge kept running agy-tools.

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

- A widget above the editor shows Antigravity's background tasks and timers, the turns it takes on its own, and its subagents with their model, reasoning level and current activity.
- A session card shows each turn Antigravity took on its own; it is never sent to a model.
- Tool cards say when a command went to the background, when a timer was set and which subagent was started.
- `PI_AGY_TRACE` logs every `session/update` from Antigravity to a local JSONL file.

### Steering

- A message typed while Antigravity works waits for the running turn instead of cancelling it, so background tasks and subagents keep running. Esc still cancels.

### Package

- Reports `pi-antigravity-thin-client` as the ACP client name.
- Published from GitHub Actions with npm Trusted Publishing and provenance.
