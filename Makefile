# Provision outside checks. Resolve Bun once before isolating test HOME.
MISE := $(shell command -v mise 2>/dev/null || test ! -x "$(HOME)/.local/bin/mise" || echo "$(HOME)/.local/bin/mise")
BUN ?= $(shell if test -n "$(MISE)"; then "$(MISE)" which bun; else command -v bun; fi)
GIT_TOOL ?= $(shell "$(MISE)" which git)
.PHONY: check format conformance replay
check:
	@KTS_CHECK_GIT="$(GIT_TOOL)" "$(BUN)" --no-install tools/check.ts
format:
	@"$(BUN)" --no-install node_modules/@biomejs/biome/bin/biome format --write packages tools tests *.json
conformance:
	@"$(BUN)" --no-install tools/conformance.ts
replay:
	@"$(BUN)" --no-install tools/replay.ts
