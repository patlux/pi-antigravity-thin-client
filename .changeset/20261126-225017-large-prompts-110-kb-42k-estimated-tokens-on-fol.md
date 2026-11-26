---
type: fixed
bump: patch
---

Large prompts (> 110 KB / ~42k estimated tokens) on follow-up or resumed turns, and `pi-traffic-optimization` projections, no longer tear down the live session or fail with a bogus replay refusal in thin-client mode.
