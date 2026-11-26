---
type: fixed
bump: patch
---

Spawned `agy acp` processes now set `AGY_CLI_DISABLE_AUTO_UPDATE="true"` by default, allow 90 seconds for cold `initialize` unpacking, clean up `.meta`, `brain/<id>/`, and `annotations/<id>.pbtxt` for empty probe and orphaned sessions, and tolerate up to 5 seconds for post-cancel prompt settling.
