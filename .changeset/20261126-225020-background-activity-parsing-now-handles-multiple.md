---
type: fixed
bump: patch
---

Background activity parsing now handles multiple `[Message]` blocks per `SYSTEM_MESSAGE`, cron schedules, anchored cancellation checks (ignoring `"was cancelled"` in command stdout), turn-state recovery after cancelled/errored turns, `manage_task status` non-terminal states, `baselineStep` replay prevention on attach, `Model: "inherit"` subagents without duplicate reasoning suffixes, trailing reminders on idle subagents, OSC escape sequences in task logs, and active/recent lookup filtering for empty tool result notes.
