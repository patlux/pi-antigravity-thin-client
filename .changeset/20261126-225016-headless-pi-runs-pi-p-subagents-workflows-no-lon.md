---
type: fixed
bump: patch
---

Headless Pi runs (`pi -p`, subagents, workflows) no longer spawn `agy acp` during `session_start` to refresh a stale model catalog.
