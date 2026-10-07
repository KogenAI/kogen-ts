#!/bin/sh
# One command: test the spec, generate traces, test every implementation, run the mutation studies.
set -e
cd "$(dirname "$0")"
[ -x node_modules/.bin/quint ] || npm install --silent @informalsystems/quint
echo "== 1. the spec against its own scenarios (+ invariants on every step)"
python3 harness/xspec.py spec
echo "== 2. model-based traces from the spec (invariant-checked)"
python3 harness/xspec.py gen --traces 1000 --steps 30 --seed 42
for impl in go rust elixir; do
  echo "== 3. conformance: $impl"
  (cd impls/$impl && ./build.sh >/dev/null 2>&1)
  python3 harness/xspec.py conform -- impls/$impl/run.sh || true
done
echo "== 4. seeded bugs in the Go implementation"
python3 harness/mutate.py
echo "== 5. seeded bugs in the spec"
python3 harness/spec_mutants.py
