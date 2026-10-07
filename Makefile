# Provision tools before checks; checks never install or fetch dependencies.
MISE ?= $(shell command -v mise 2>/dev/null || true)
BUN ?= $(shell if test -n "$(MISE)"; then MISE_AUTO_INSTALL=0 "$(MISE)" which bun; else command -v bun; fi)
GIT_TOOL ?= $(shell if test -n "$(MISE)"; then MISE_AUTO_INSTALL=0 "$(MISE)" which git; else command -v git; fi)
.PHONY: check freeze dispatch-dry-run format conformance replay
check:
	@KTS_CHECK_GIT="$(GIT_TOOL)" "$(BUN)" --no-install tools/check.ts
freeze:
	@"$(BUN)" --no-install tools/freeze.ts --check
dispatch-dry-run:
	@"$(BUN)" --no-install tools/dispatch.ts --dry-run
format:
	@"$(BUN)" --no-install node_modules/@biomejs/biome/bin/biome format --write packages tools tests *.json
conformance:
	@"$(BUN)" --no-install tools/conformance.ts
replay:
	@"$(BUN)" --no-install tools/replay.ts
