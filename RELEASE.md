# Release Process

All npm publication uses the tag-triggered GitHub Actions workflow `.github/workflows/release.yml` with npm Trusted Publishing (OIDC), including recovery. A release starts when a version tag is pushed. Pushing to `main` alone does not publish.

```text
version + changelog on main → green CI → push vX.Y.Z on that commit
→ release checks → npm → registry check → GitHub Release
```

Both stable releases and prereleases must reference commits already in `main`. Never move a release tag to another commit. Stable `X.Y.Z` versions and changelog sections are generated from `.changeset/` via `make version` (see [CONTRIBUTING.md](CONTRIBUTING.md)); prerelease `-next.N` versions are chosen explicitly by maintainers.

## Authorization

Coding agents need explicit authorization before committing, pushing, tagging, publishing or changing remote settings. Updating documentation does not authorize a release. Confirm the intended version and channel: a `next` prerelease is a real public release, not a dry run.

Never test a release, or anything else, by sending prompts to Antigravity from a script or an agent. See the thin-client rules in the [README](README.md).

If recovery cannot proceed safely, stop and report the run and version evidence, the checks you made, the blocker and the input you need. Do not bypass CI/OIDC or weaken checks.

## One-time setup

The workflow file does not configure npm or GitHub. These settings exist outside the repository:

1. GitHub Environment **`npm`** that allows deployments only from **tags matching `v*`**, without a required reviewer: the tag push is the release authorization.
2. npm Trusted Publisher for the package:

   | Setting              | Value                          |
   | -------------------- | ------------------------------ |
   | Provider             | GitHub Actions                 |
   | Organization or user | `patlux`                       |
   | Repository           | `pi-antigravity-thin-client`   |
   | Workflow filename    | `release.yml` (not a path)     |
   | Environment          | `npm`                          |
   | Allowed action       | Direct `npm publish`           |

   npm cannot register a Trusted Publisher for a name that does not exist yet. On 2026-11-25 the name was claimed once with a `0.0.0` placeholder without code (dist-tag `bootstrap`); npm added its own `0.0.0-stage` stub for the new package. Both are deprecated, and the release check ignores the stub as a previous `latest`. Every real version comes from the workflow. Do not add an `NPM_TOKEN` secret.
3. A tag ruleset that blocks updates and deletion of `v*` tags. Tag creation grants publication capability; review who can create tags.
4. GitHub Actions enabled for the repository (forks start with Actions disabled).

## Prepare a release

Confirm a clean, current checkout of `main`, the canonical repository and your own GitHub identity. Record the current npm dist-tags and the latest GitHub Release:

```sh
git status --short --branch
git remote -v
gh auth status
npm view pi-antigravity-thin-client dist-tags --json --prefer-online --registry=https://registry.npmjs.org/
gh release view --repo patlux/pi-antigravity-thin-client --json tagName,url
npm view pi-antigravity-thin-client@<version> version --json --prefer-online --registry=https://registry.npmjs.org/
git ls-remote origin refs/tags/v<version>
```

An unused version returns `E404` while the package lookup succeeds; authentication, network and other registry errors do not prove that a version is unused. If the version or tag exists, investigate recovery or choose another version; never overwrite it.

Preview the pending changesets and prepare the stable version on clean `main`:

```sh
make changeset-status
make version
```

`make version` selects the highest pending SemVer bump, reads `Upstream base: pi-antigravity-bridge X.Y.Z.` from `docs/upstream/CHANGELOG.md`, updates `package.json` and `package-lock.json`, prepends the dated section `## X.Y.Z - YYYY-MM-DD` to `CHANGELOG.md`, and removes all consumed changesets. It does not commit, tag or push.

Review the diff and run the local checks:

```sh
make verify
npm audit --audit-level=moderate
npm pack --dry-run
dir="$(mktemp -d)" && npm pack --ignore-scripts --pack-destination "$dir" && node .github/scripts/package-smoke.mjs "$dir"/pi-antigravity-thin-client-<version>.tgz
git diff --check
```

The package smoke test needs `pi` on `PATH` (or `PI_BIN`). It loads the installed tarball with a temporary home and a stub `agy`, so it never reaches Antigravity.

Commit only the generated release files (`package.json`, `package-lock.json`, `CHANGELOG.md` and the deleted `.changeset/*.md` files) as `chore: release <version>`, run `make release-check`, then push `main` and wait for CI on that exact commit.

```sh
git add package.json package-lock.json CHANGELOG.md
git add -u .changeset
git commit -m "chore: release <version>"
make release-check
```

(For an explicit `-next.N` prerelease, which is outside `make version`'s stable SemVer flow, set the prerelease version and dated changelog section manually with `Upstream base: pi-antigravity-bridge X.Y.Z.`.)

## Tag the release commit

```sh
git switch main
git pull --ff-only
git status --short --branch
git log -1 --oneline
node -p 'require("./package.json").version'

git tag -a v0.2.0 -m "Release 0.2.0" <verified-commit>
git push origin refs/tags/v0.2.0
```

Push the single intended tag, not `--tags`, with your own Git credentials: tags created with a workflow's `GITHUB_TOKEN` do not trigger another workflow.

| Accepted tag    | npm dist-tag | GitHub Release         |
| --------------- | ------------ | ---------------------- |
| `vX.Y.Z`        | `latest`     | Stable/latest          |
| `vX.Y.Z-next.N` | `next`       | Prerelease, not latest |

Other `v*` tags start validation but cannot publish. Wait for a release to finish before pushing another tag: GitHub keeps only one pending run in the `npm-release` concurrency group and can replace it.

## What the workflow does

1. **Validate:** canonical repository, tag push, exact event commit, clean tracked checkout, current remote tag, membership in `main`, package and lockfile versions, dated changelog section with upstream base, package and repository identity, no `publishConfig`.
2. **Check:** the CI workflow for this commit: typecheck and tests on Ubuntu and Windows with Node 22 and 24, the packed package in a real Pi, workflow syntax, `npm audit`, no install lifecycle scripts.
3. **Package:** run the checks again on Node 24, audit, pack once without lifecycle scripts, check the file allowlist and load that tarball in a real Pi with a stub `agy`. Upload tarball, SHA-512 and release notes as one Actions artifact.
4. **Publish:** on a fresh runner in environment `npm`, verify artifact, Git refs and registry state again, then publish that exact tarball through OIDC without lifecycle scripts or dependency installation. Only this job has `id-token: write`. Provenance is generated automatically.
5. **Verify:** wait up to five minutes until npm shows the version under its dist-tag (npm processes new versions for a minute or two), then download the public tarball, compare its SHA-512 with the tested artifact, check the dist-tag and load it in a real Pi again.
6. **GitHub Release:** only after verification, create the release from the tag with its changelog section.

No step uses an Antigravity account.

## Monitor and finish

```sh
gh run list --repo patlux/pi-antigravity-thin-client --workflow release.yml --branch v<version> --event push --json databaseId,headSha,status,conclusion,url
gh run watch <run-id> --repo patlux/pi-antigravity-thin-client --exit-status
npm view pi-antigravity-thin-client@<version> version dist.integrity dist.attestations --json --prefer-online --registry=https://registry.npmjs.org/
gh release view v<version> --repo patlux/pi-antigravity-thin-client --json tagName,isDraft,isPrerelease,url
```

A local `gh run watch` timeout does not cancel the remote run. A release is complete when the run's `headSha` matches the tag, all jobs passed, the version and dist-tag are on npm with provenance, and the GitHub Release exists with the right stable or prerelease status.

## Recovery

- **Version briefly absent after publish:** npm can acknowledge a publish before the version is visible everywhere (0.1.0 took about two minutes). Recheck with `--prefer-online` at bounded intervals, then rerun the failed jobs; do not republish or move a tag.
- **GitHub API error while creating the release:** the release may exist anyway (0.1.0 got HTTP 504 and was created). Check `gh release view v<version>` before rerunning; the rerun leaves a matching release unchanged.
- **Validation or tests fail before publish:** nothing is published. Fix the cause in a new commit with a new version and tag; do not move the failed tag. A transient infrastructure failure can be retried for the same commit.
- **Publish reports an error:** check the exact version on npm first. Do not blindly repeat `npm publish`.
- **Version exists, later steps failed:** after confirming the registry matches, rerun only the failed jobs (`gh run rerun <run-id> --repo patlux/pi-antigravity-thin-client --failed`). Publishing is skipped when registry integrity and dist-tag match exactly.
- **Version differs, registry errors or dist-tag moved:** the workflow fails closed and never overwrites versions or rolls dist-tags back. Resolve it explicitly.
- **Published package fails the registry check:** the version is public and cannot be rolled back by CI. Investigate before publishing a corrected version or deprecating the broken one.

Recovery stays within the CI/OIDC path. There is no alternative publishing path.

## Merge upstream changes

The fork follows [onprs/Pi-Antigravity-Bridge](https://github.com/onprs/Pi-Antigravity-Bridge) (remote `upstream`). Upstream uses the same `vX.Y.Z` tag names for its own versions, so fetch it without tags; tags in this repository are fork versions only:

```sh
git remote add upstream https://github.com/onprs/Pi-Antigravity-Bridge.git
git config remote.upstream.tagOpt --no-tags
git fetch upstream
git merge upstream/main
```

- `README.md` and `CHANGELOG.md` belong to the fork. Take the upstream changes to them into `docs/upstream/README.zh-CN.md` and `docs/upstream/CHANGELOG.md` (which `make version` reads for the `Upstream base:` line).
- Review every upstream change for anything that sends Antigravity content the user did not type, and neutralize it: prompts made up by the bridge ("Continue."), automatic retries or continuations, replayed or preloaded history, auxiliary requests, Pi MCP/skill/`AGENTS.md` bridges, writes to Antigravity's databases, other tool modes than `agy-tools`.
- Translate new Chinese interface texts from upstream to English; `test/interface-language.test.ts` fails until every string literal in `src/` is English. Comments may stay Chinese.
- New upstream tests for disabled features get `{ skip: THIN_CLIENT_DISABLED }`; tests for features the fork keeps run with typed input (`test/human-input.ts`).
- `make verify` must pass with the thin-client tests unchanged. Add a regression test when an upstream change opens a new path to Antigravity.
- Add a changeset for the upstream merge, then cut the new fork version with `make version` (which records the new upstream base from `docs/upstream/CHANGELOG.md`).
