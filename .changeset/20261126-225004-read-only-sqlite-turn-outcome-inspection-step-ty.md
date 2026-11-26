---
type: added
bump: minor
---

Read-only SQLite turn outcome inspection (`step_type = 17`) on `end_turn` and `refusal` to surface silent upstream failures — quota exhaustion with reset timestamps/delays, `INVALID_THINKING_SIGNATURE`, 403 `VALIDATION_REQUIRED` links, `SUBSCRIPTION_REQUIRED`, and API errors — cleanly as non-retryable errors.
