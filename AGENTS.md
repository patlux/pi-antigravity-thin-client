# AGENTS.md

pi-antigravity-thin-client is a Pi extension that connects Pi to Google Antigravity (`agy acp`) as a thin client. It is a fork of onprs/Pi-Antigravity-Bridge; most source comments come from upstream and are in Chinese.

## Rules

- Never send prompts to Antigravity yourself: no tmux keystrokes into a Pi session that uses an `antigravity/…` model, no `pi -p`, no scripts. Only a person typing in the interactive session may prompt Antigravity. Ask the user to run live tests.
- Tests must never reach a real `agy`. Use the mock in `test/turn-coordinator-e2e.test.ts` or a stub binary through `PI_AGY_BIN`.
- The only exceptions to the tmux rule are `scripts/screenshots/capture.mjs` and `scripts/e2e/resume.mjs`. They type into Pi only against their mock (`scripts/screenshots/mock-agy.mjs`, `scripts/e2e/mock-agy.mjs`), set as `PI_AGY_BIN` and as the first `agy` on `PATH` of a temporary home; `resume.mjs` also leaves every other directory with an `agy` out of `PATH` and checks that `agy` resolves to the mock. Keep it that way; never point them at a real `agy`.
- Keep the thin-client policy intact (`src/thin-client-policy.ts`, `src/human-prompt-gate.ts`, the refusals in `src/session/reconcile.ts` and `src/session/turn-coordinator.ts`). Never weaken or skip the thin-client tests.
- Keep upstream code close to upstream so merges stay small; put fork features in their own modules (`src/background/`, `src/ui/background-activity.ts`).
- All interface texts (notifications, errors, widget, cards, command help) are English. Translate Chinese texts that upstream merges bring in.
- TypeScript: no `any`, no `as unknown as`, no `void`-prefixed calls in new code.
- Changesets: read [CONTRIBUTING.md](CONTRIBUTING.md) before committing. Every non-merge, non-release commit adds a new Markdown note in `.changeset/` (or an explicit empty note via `python3 -B scripts/changeset.py add --empty` for docs, tests, or tooling). Install the hook once per clone with `make hooks-install`; never bypass it.
- Versions: prepare versions only on clean `main` through `make version` after an explicit release request, never by hand-editing `package.json` or `CHANGELOG.md`. Commit generated release files separately (`chore: release <version>`).

## Commands

```sh
npm ci
make hooks-install      # install the changeset pre-commit hook once per clone
make verify             # changeset tests/status, typecheck, and all Node tests
make changeset          # add a release note or empty changeset
make changeset-status   # validate pending notes and preview the next SemVer
make version            # prepare package.json, package-lock.json, and CHANGELOG.md
make release-check      # read-only local release gate before pushing/tagging
npm run check           # typecheck and all Node tests
npm run test:release    # release-rule tests only
npm run test:e2e-resume # real Pi in tmux against a mock agy: continuing conversations
```

Run `npm run test:e2e-resume` after changes to session restore (`src/session/`), anchors or `/agy sessions`. It needs `pi` and `tmux` and takes about a minute.

## Releases and upstream merges

Follow [CONTRIBUTING.md](CONTRIBUTING.md) and [RELEASE.md](RELEASE.md). Publication runs only through the tag-triggered GitHub Actions workflow with npm Trusted Publishing.
