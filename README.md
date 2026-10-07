# Kogen TypeScript/Bun

Bootstrap for TypeScript/Bun with native OS support. The public CLI and private
`kogen-xspec` share the core; product behavior is not implemented yet.

Provision with `mise install` and `mise exec -- bun install --frozen-lockfile`.
Run `make check` for local formatting, lint, type checking and isolated tests.
`GIT_CONFIG_GLOBAL=/dev/null make check` uses the same gate. Checks never install.

See [the plan](docs/work/PLAN.md), [queue](docs/work/QUEUE.txt),
[worker rules](docs/work/WORKER-RULES.md) and [dispatcher guide](docs/work/DISPATCH.md).
The target is spec v1.3-draft e19dd1c; the frozen oracle remains v1.2.
Apache-2.0; see LICENSE.
