---
type: fixed
bump: patch
---

Out-of-order `tool_call` updates can no longer downgrade a completed mirror tool's status, stray `tool_call_update` events no longer leak orphaned broker entries, permission and elicitation dialogs share one FIFO mutex, `agy_read`/`agy_write` errors render as error text, and `HumanPromptGate` accepts trimmed whitespace while restricting slash-command fallback to recent non-`/agy` commands.
