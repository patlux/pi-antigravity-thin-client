---
type: fixed
bump: patch
---

Out-of-turn `usage_update` notifications now trigger an immediate background poll when live autonomous activity is showing so the finished card replaces the live line promptly; SQLite step usage parsing also accounts for protobuf field 10 (`responseTokens`), and mirror broker payloads cap huge outputs and diffs in memory.
