---
type: fixed
bump: patch
---

Switching sessions (`/new`, `/resume`, `/fork`, `/agy sessions`), compacting, logging out, or switching away from an Antigravity model could leave the previous background watcher and live widget active and append autonomous turn cards or titles into the wrong Pi session. Watchers and previous-session ledgers are now stopped on transitions, and live out-of-turn activity clears when the user starts a new turn.
