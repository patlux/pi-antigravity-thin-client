---
type: fixed
bump: patch
---

`/agy logout` now calls ACP v1 `"logout"` first and falls back to `"auth/logout"` on `-32601` (Method not found).
