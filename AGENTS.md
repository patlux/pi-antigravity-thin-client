# AGENTS.md

pi-antigravity-thin-client is a Pi extension that connects Pi to Google Antigravity (`agy acp`) as a thin client. It is a fork of onprs/Pi-Antigravity-Bridge; most source comments come from upstream and are in Chinese.

## Rules

- Never send prompts to Antigravity yourself: no tmux keystrokes into a Pi session that uses an `antigravity/…` model, no `pi -p`, no scripts. Only a person typing in the interactive session may prompt Antigravity. Ask the user to run live tests.
- Tests must never reach a real `agy`. Use the mock in `test/turn-coordinator-e2e.test.ts` or a stub binary through `PI_AGY_BIN`.
- Keep the thin-client policy intact (`src/thin-client-policy.ts`, `src/human-prompt-gate.ts`, the refusals in `src/session/reconcile.ts` and `src/session/turn-coordinator.ts`). Never weaken or skip the thin-client tests.
- Keep upstream code close to upstream so merges stay small; put fork features in their own modules (`src/background/`, `src/ui/background-activity.ts`).
- All interface texts (notifications, errors, widget, cards, command help) are English. Translate Chinese texts that upstream merges bring in.
- TypeScript: no `any`, no `as unknown as`, no `void`-prefixed calls in new code.

## Commands

```sh
npm ci
npm run check          # typecheck and all tests
npm run test:release   # release-rule tests only
```

## Releases and upstream merges

Follow [RELEASE.md](RELEASE.md). Publication runs only through the tag-triggered GitHub Actions workflow with npm Trusted Publishing.
