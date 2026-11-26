# Changelog

Fork releases of pi-antigravity-thin-client. The upstream changelog of pi-antigravity-bridge is in [docs/upstream/CHANGELOG.md](docs/upstream/CHANGELOG.md).

## Unreleased

### Added

- Native Antigravity `swarm` visibility: the background widget now reads `.system_generated/swarm/members.json` read-only to display active, parked, and recently finished swarm workers (deduplicated against subagents), and mirror tool cards render `swarm`, `post_message`, `read_board`, `swarm_wait`, and `update_steps` with concise summaries.
- Complete ACP `elicitation/create` (plus v1 `session/elicitation` and `_session/elicitation`) form support: titled `oneOf` choices, `array` multi-select with `minItems`/`maxItems`, optional `<id>__other` / `<id>_other` free-text companion folding, skippable optional fields, and `ask_question` field titles.
- Support for Antigravity's `auto` execution mode in configuration and `/agy agent-mode` (falling back to `default` with a warning when a session does not advertise `auto`), plus `current_mode_update` synchronization and a version hint in `/agy status` when `agy` is older than `1.5.1`.
- Per-model `thought_level` discovery via zero-quota `session/set_config_option` probing during catalog refresh, along with grouped `configOptions` and category-based option matching.
- Read-only SQLite turn outcome inspection (`step_type = 17`) on `end_turn` and `refusal` to surface silent upstream failures — quota exhaustion with reset timestamps/delays, `INVALID_THINKING_SIGNATURE`, 403 `VALIDATION_REQUIRED` links, `SUBSCRIPTION_REQUIRED`, and API errors — cleanly as non-retryable errors.
- A 15-minute prompt inactivity watchdog (paused while permission or elicitation dialogs are open or mirror tools are executing) so stalled `agy` turns fail cleanly instead of hanging indefinitely.

### Fixed

- Interactive `interaction_*` questions sent over `session/request_permission` now render as questions instead of `"Approve: …"` prompts and no longer fail the turn when a chosen option carries a `reject_*` kind; normal approval prompts surface `_meta["agy.security.warning"]` warnings and enrich generic titles with command or file details.
- `/agy logout` now calls ACP v1 `"logout"` first and falls back to `"auth/logout"` on `-32601` (Method not found).
- Spawned `agy acp` processes now set `AGY_CLI_DISABLE_AUTO_UPDATE="true"` by default, allow 90 seconds for cold `initialize` unpacking, clean up `.meta`, `brain/<id>/`, and `annotations/<id>.pbtxt` for empty probe and orphaned sessions, and tolerate up to 5 seconds for post-cancel prompt settling.
- Out-of-turn `usage_update` notifications now trigger an immediate background poll when live autonomous activity is showing so the finished card replaces the live line promptly; SQLite step usage parsing also accounts for protobuf field 10 (`responseTokens`), and mirror broker payloads cap huge outputs and diffs in memory.
- Failed `session/set_config_option` switches for `model` or `mode` now warn via UI notification instead of failing silently.
- Long answers in the "Antigravity · on its own" card showed `<truncated N bytes>` and lost their middle part. `agy` cuts fields of more than about 4 KB in `transcript.jsonl` and writes them whole only to `transcript_full.jsonl`; the package now reads `transcript_full.jsonl` and falls back to `transcript.jsonl` only when the full file is missing or empty, waiting briefly for the full transcript on newly truncated turns and decoding multi-byte UTF-8 safely across incremental reads. Cards recorded before this fix keep their cut text.
- Shell commands, file operations (`read`, `edit`, `write`), and searches whose path, query, or command line contains `workflow`, `subagent`, or `swarm` were shown as subagent cards. Explicit command, file, and search classifications now run before subagent title heuristics.
- Switching sessions (`/new`, `/resume`, `/fork`, `/agy sessions`), compacting, logging out, or switching away from an Antigravity model could leave the previous background watcher and live widget active and append autonomous turn cards or titles into the wrong Pi session. Watchers and previous-session ledgers are now stopped on transitions, and live out-of-turn activity clears when the user starts a new turn.
- Headless Pi runs (`pi -p`, subagents, workflows) no longer spawn `agy acp` during `session_start` to refresh a stale model catalog.
- Large prompts (> 110 KB / ~42k estimated tokens) on follow-up or resumed turns, and `pi-traffic-optimization` projections, no longer tear down the live session or fail with a bogus replay refusal in thin-client mode.
- Resuming a session (`pi --continue` / `/resume`) after a refused, failed, or aborted turn no longer locks the conversation out permanently, and SQLite checkpoint capture retries briefly across WAL flush lag.
- `/agy sessions` now records a SQLite checkpoint on imported anchors (enabling divergence checks), drops trailing unanswered user messages that would trip the prompt gate, extracts inline `tool_call` outputs, tears down an active ledger before re-importing the same conversation, and reports command errors via UI notifications.
- Background activity parsing now handles multiple `[Message]` blocks per `SYSTEM_MESSAGE`, cron schedules, anchored cancellation checks (ignoring `"was cancelled"` in command stdout), turn-state recovery after cancelled/errored turns, `manage_task status` non-terminal states, `baselineStep` replay prevention on attach, `Model: "inherit"` subagents without duplicate reasoning suffixes, trailing reminders on idle subagents, OSC escape sequences in task logs, and active/recent lookup filtering for empty tool result notes.
- Out-of-order `tool_call` updates can no longer downgrade a completed mirror tool's status, stray `tool_call_update` events no longer leak orphaned broker entries, permission and elicitation dialogs share one FIFO mutex, `agy_read`/`agy_write` errors render as error text, and `HumanPromptGate` accepts trimmed whitespace while restricting slash-command fallback to recent non-`/agy` commands.

### Changed

- The answer of a turn Antigravity took on its own now stands below the "Antigravity · on its own" card, padded like any other answer, instead of inside the card's background. The card keeps the header, what woke Antigravity, the tool calls and the interruption note.
- Command and generic tool cards no longer show agy's `Created At:` / `Completed At:` lines; the run time is in the card header, and partial cards with only timestamp lines show `Running...`. The tool result itself is unchanged.

## 0.2.3 - 2026-11-26

Upstream base: pi-antigravity-bridge 0.1.16.

### Fixed

- Background timers cancelled with `manage_task` (`kill`) — or cancelled early by a `TimerCondition` message — stayed listed as running in the widget above the editor because `agy` does not write a `messages/*.json` file for a cancelled timer. Task state now also reads `manage_task` results (`kill`, `status`, `list`) and message deliveries from `transcript.jsonl`.
- Timers of a minute or longer (`Timer: 35m`, `Timer: 2m 30s`, `Timer: 1h 5m`, ...) were shown as shell commands with their full prompt because the parser only matched durations in seconds (`30s`). Multi-unit durations are now recognized as timers and displayed compactly with their remaining time.

## 0.2.2 - 2026-11-26

Upstream base: pi-antigravity-bridge 0.1.16.

### Added

- `npm run test:e2e-resume` (`scripts/e2e/resume.mjs`): runs the real Pi in tmux against a stand-in for `agy` and checks `pi --continue` after Antigravity worked on its own, the refusal in a forked Pi session and `/agy sessions`, including every ACP request.

### Fixed

- A Pi session with an Antigravity conversation could not be continued after Pi restarted (`/resume`, `pi --continue`) once Antigravity had worked on its own after the last prompt: a background task, a timer or a subagent added steps, or a background command changed its status when it ended. The package took that for a branch and refused the next prompt. It now reopens the conversation with `session/resume` and sends only the typed prompt.

### Changed

- When the Antigravity conversation got further prompts after the point Pi continues from (`/tree` to an earlier message, a forked Pi session, another client), the refusal now says so instead of the generic replay refusal.
- The README describes how to continue a Pi session or an Antigravity conversation (`/agy sessions`) and why that stays within the thin-client boundary.

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
