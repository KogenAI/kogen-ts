# 6. Non-goals and implementer freedom

Core v1 is the unit of comparison. Every implementation builds exactly this, nothing more, in a conformance build.

## 6.1 Out of core v1
| Item | Why |
|---|---|
| `init`, `update`, `provider test`, `guide`, `doctor`, `completion`, `mcp` | Decided commands, but not part of this CLI generation (features/24). |
| Daemon, TUI, interactive sessions | Decided never. |
| Parallel Builds; per-domain claims | Later: same UX, plus config. |
| Splitting one Intent into sub-Builds | Decided as Kogen's job; not yet built. |
| Providers other than ChatGPT and Grok, API keys | ChatGPT and Grok are §4. Others plug into §4.1 and §4.6. |
| A model judge | Selection is deterministic (§3.8.3). |
| A second witness | Shaping-guarantee lever, pending measurement. It plugs into §3.2.7. |
| Automatic retry of crashed Builds | Open (decisions `build.crash`). |
| `limits` semantics; Intent sync between machines | No consumer yet. `blocks_on` is §2.11. |
| Stack adapters beyond `exunit`, `rails`, and `command` | Further adapters plug into §2.4.2. |
| Spend ceilings, USD ledger | Subscriptions only. Usage is recorded in `model_stage`. |

## 6.2 Left to the implementer
- Language, runtime, packaging and internal architecture. Only the CLI, the files and the journal are observed.
- The HTTP, JSON and YAML libraries. The YAML subset of §2.6 must still behave as specified: accepting more is non-conformant.
- How process custody (§5.1), the sandbox (§5.3) and the credential store (§4.6) work on each OS.
- Prompt wording, apart from the marker sentences, the quoted message templates and the information each prompt must carry.
- The contents of `transcript.jsonl`, the contents of log files, and the wording of unquoted `detail` text.

## 6.3 Never
- Borrow another tool's login.
- Read AGENTS.md or CLAUDE.md as instructions.
- Add AI attribution or extra trailers to commits.
- Run workspace hooks.
- Put a secret or model-generated command in argv. The shell tool runs a private script (§4.7).
- Land what the land policy does not allow.
- Re-plan a started Build, return it to shaping, or end it other than as listed in §3.0.
