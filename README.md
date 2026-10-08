# Kogen TypeScript/Bun

> **Archived.** Kogen in TypeScript (Bun), built from [kogen-spec](https://github.com/KogenAI/kogen-spec) on 7 and 8 October 2026, when we built Kogen in Rust, Go and TypeScript from the same specification to choose a stack. It was stopped on 8 October, when Rust was chosen, and it is unfinished: 64 of its 66 planned work packages merged, and integration gates I0–I2 passed. More at [kogen.dev](https://kogen.dev).
>
> The comparison: [kogen-spec](https://github.com/KogenAI/kogen-spec) · [kogen-conformance](https://github.com/KogenAI/kogen-conformance) · [kogen-rs](https://github.com/KogenAI/kogen-rs) · [kogen-go](https://github.com/KogenAI/kogen-go) · [kogen-ts](https://github.com/KogenAI/kogen-ts)

Bootstrap for TypeScript/Bun with native OS support. The public CLI and private
`kogen-xspec` share the core; product behavior is not implemented yet.

Provision with `mise install` and `mise exec -- bun install --frozen-lockfile`.
Run `make check` for local formatting, lint, type checking and isolated tests.
`GIT_CONFIG_GLOBAL=/dev/null make check` uses the same gate. Checks never install.

See [the plan](docs/work/PLAN.md), [queue](docs/work/QUEUE.txt),
[worker rules](docs/work/WORKER-RULES.md) and [dispatcher guide](docs/work/DISPATCH.md).
The target is spec v1.3-draft e19dd1c; the frozen oracle remains v1.2.
Apache-2.0; see LICENSE.
