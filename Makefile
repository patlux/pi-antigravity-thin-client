PYTHON ?= python3

.PHONY: help verify check hooks-install changeset changeset-status changeset-test version release-check

help:
	@printf '%s\n' \
	  'verify            Run changeset checks, typecheck, and Node tests' \
	  'check             Alias for verify' \
	  'hooks-install     Install the guarded changeset pre-commit hook (once per clone)' \
	  'changeset         Add a release note or an intentional empty changeset' \
	  'changeset-status  Validate pending notes and preview the next SemVer' \
	  'changeset-test    Test the changeset parser, Git hook, and release flow' \
	  'version           Prepare package.json, package-lock.json, and CHANGELOG.md on clean main; no commit/tag/push' \
	  'release-check     Read-only local release gate before pushing/tagging; never publishes'

verify: changeset-test changeset-status
	npm run check

check: verify

hooks-install:
	$(PYTHON) -B scripts/changeset.py install-hook

changeset:
	$(PYTHON) -B scripts/changeset.py add

changeset-status:
	$(PYTHON) -B scripts/changeset.py status

changeset-test:
	$(PYTHON) -B scripts/test_changeset.py -v

version:
	$(PYTHON) -B scripts/changeset.py version

release-check:
	npm run release:check
