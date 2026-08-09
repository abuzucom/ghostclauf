.PHONY: sync check agents-lint

sync:
	python scripts/sync.py

check:
	python scripts/sync.py --check

agents-lint:
	python scripts/check_ascii.py AGENTS.md
	python scripts/check_us_spelling.py AGENTS.md
	python scripts/check_english_only.py AGENTS.md
	python scripts/check_branch_name.py
	python scripts/check_persist_credentials.py .github/workflows/*.yml
	python scripts/check_weak_hashing.py $(shell find src test scripts hooks -name '*.ts' -o -name '*.py')
	python scripts/check_dockerfile_root.py Dockerfile docker-compose.yml
	python scripts/check_secrets_heuristic.py $(shell find src test scripts hooks -name '*.ts' -o -name '*.py') .github/workflows/*.yml .pre-commit-config.yaml Makefile Dockerfile docker-compose.yml
