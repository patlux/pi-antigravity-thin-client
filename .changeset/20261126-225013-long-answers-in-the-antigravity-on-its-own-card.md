---
type: fixed
bump: patch
---

Long answers in the "Antigravity · on its own" card showed `<truncated N bytes>` and lost their middle part. `agy` cuts fields of more than about 4 KB in `transcript.jsonl` and writes them whole only to `transcript_full.jsonl`; the package now reads `transcript_full.jsonl` and falls back to `transcript.jsonl` only when the full file is missing or empty, waiting briefly for the full transcript on newly truncated turns and decoding multi-byte UTF-8 safely across incremental reads. Cards recorded before this fix keep their cut text.
