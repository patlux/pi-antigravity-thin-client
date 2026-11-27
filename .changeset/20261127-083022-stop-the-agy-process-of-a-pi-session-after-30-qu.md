---
type: added
bump: minor
---

Stop the agy process of a Pi session after 30 quiet minutes (`idleReleaseMinutes`, `PI_AGY_IDLE_RELEASE_MINUTES`). The next prompt continues the conversation in a new process, which reads the current sign-ins of Antigravity's MCP servers instead of outdated ones that sign everyone out on servers with rotating refresh tokens.
