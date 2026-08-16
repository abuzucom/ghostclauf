.PHONY: sync check docs-lint agents-lint

sync:
	python scripts/sync.py

check:
	python scripts/sync.py --check

docs-lint:
	python scripts/check_ascii.py README.md CHANGELOG.md security.md
	python scripts/check_us_spelling.py README.md CHANGELOG.md security.md
	python scripts/check_english_only.py README.md CHANGELOG.md security.md

agents-lint:
	python scripts/check_ascii.py AGENTS.md plan/HANDOFF.md.example CONTRIBUTING.md.example .github/PULL_REQUEST_TEMPLATE.md .github/ISSUE_TEMPLATE.md
	python scripts/check_us_spelling.py AGENTS.md plan/HANDOFF.md.example CONTRIBUTING.md.example .github/PULL_REQUEST_TEMPLATE.md .github/ISSUE_TEMPLATE.md
	python scripts/check_english_only.py AGENTS.md plan/HANDOFF.md.example CONTRIBUTING.md.example .github/PULL_REQUEST_TEMPLATE.md .github/ISSUE_TEMPLATE.md
	python scripts/check_hedging.py AGENTS.md plan/HANDOFF.md.example CONTRIBUTING.md.example .github/PULL_REQUEST_TEMPLATE.md .github/ISSUE_TEMPLATE.md
	$(MAKE) docs-lint
	python scripts/check_branch_name.py
	python scripts/check_persist_credentials.py .github/workflows/*.yml
	python scripts/check_weak_hashing.py $(shell find src test scripts hooks -name '*.ts' -o -name '*.py')
	python scripts/check_dockerfile_root.py Dockerfile docker-compose.yml
	python scripts/check_secrets_heuristic.py $(shell find src test scripts hooks -name '*.ts' -o -name '*.py') .github/workflows/*.yml .pre-commit-config.yaml Makefile Dockerfile docker-compose.yml
