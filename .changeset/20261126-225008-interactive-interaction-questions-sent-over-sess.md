---
type: fixed
bump: patch
---

Interactive `interaction_*` questions sent over `session/request_permission` now render as questions instead of `"Approve: …"` prompts and no longer fail the turn when a chosen option carries a `reject_*` kind; normal approval prompts surface `_meta["agy.security.warning"]` warnings and enrich generic titles with command or file details.
