---
type: fixed
bump: patch
---

Resuming a session (`pi --continue` / `/resume`) after a refused, failed, or aborted turn no longer locks the conversation out permanently, and SQLite checkpoint capture retries briefly across WAL flush lag.
