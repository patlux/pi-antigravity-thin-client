---
type: fixed
bump: patch
---

`/agy sessions` now records a SQLite checkpoint on imported anchors (enabling divergence checks), drops trailing unanswered user messages that would trip the prompt gate, extracts inline `tool_call` outputs, tears down an active ledger before re-importing the same conversation, and reports command errors via UI notifications.
