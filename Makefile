.PHONY: sync check lint test identity changelog docs-lint agents-lint agents-test

# Overridable so a platform without this name can supply its own:
#   make test PYTHON=py
PYTHON ?= python3

PROSE_FILES = AGENTS.md README.md CHANGELOG.md security.md \
	docs/agent-orientation.md docs/agents-upstream-sync.md \
	plan/HANDOFF.md.example CONTRIBUTING.md.example \
	.github/PULL_REQUEST_TEMPLATE.md .github/ISSUE_TEMPLATE.md

sync:
	$(PYTHON) scripts/sync.py

check:
	$(PYTHON) scripts/sync.py --check

changelog:
	$(PYTHON) scripts/check_changelog.py

lint:
	$(PYTHON) scripts/lint_style.py
	$(PYTHON) scripts/check_policy_size.py
	$(PYTHON) scripts/check_ascii.py $(PROSE_FILES)
	$(PYTHON) scripts/check_us_spelling.py $(PROSE_FILES)
	$(PYTHON) scripts/check_english_only.py $(PROSE_FILES)
	$(PYTHON) scripts/check_hedging.py $(PROSE_FILES)
	$(PYTHON) scripts/check_conflict_markers.py

test:
	$(PYTHON) scripts/run_tests.py

identity:
	$(PYTHON) scripts/check_git_identity.py --advise

# Retained target names. The README and CI still reference these.
docs-lint:
	$(PYTHON) scripts/check_ascii.py README.md CHANGELOG.md security.md
	$(PYTHON) scripts/check_us_spelling.py README.md CHANGELOG.md security.md
	$(PYTHON) scripts/check_english_only.py README.md CHANGELOG.md security.md

agents-test:
	$(PYTHON) -m unittest discover -s tests -v

agents-lint:
	$(MAKE) lint
	$(MAKE) agents-test
	$(PYTHON) scripts/check_branch_name.py
	$(PYTHON) scripts/check_action_pins.py .github/workflows/*.yml
	$(PYTHON) scripts/check_persist_credentials.py .github/workflows/*.yml
	$(PYTHON) scripts/check_weak_hashing.py $(shell find src test scripts hooks -name '*.ts' -o -name '*.py')
	$(PYTHON) scripts/check_dockerfile_root.py Dockerfile docker-compose.yml
	$(PYTHON) scripts/check_secrets_heuristic.py $(shell find src test scripts hooks -name '*.ts' -o -name '*.py') .github/workflows/*.yml .pre-commit-config.yaml Makefile Dockerfile docker-compose.yml
