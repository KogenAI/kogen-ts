# Coverage of careful-rebuild `a8c98c68`

Every `lib/**/*.ex` file at that commit is listed. The section is the behaviour a rewrite implements. `internal` means the file adds no observation beyond that section.

No row is UNSPECIFIED. Observable behaviour that v1.1 left out is now in the cited section: agents (§1.7.5), Rails (§2.4.3), scheduling (§2.11), the ladder as tested (§3.1), assumption recheck (§3.2.8), `finish` (§3.6), flakes (§3.7.2), advisory quality (§3.7.4), prompt caching (§4.9), and Grok (§4.10).

This commit has no Grok client, no v2 cache key, and no `finish` tool. Those files arrive with T99, T98, and T94. Their behaviour is already specified. DRIFT-v1.2 records that the tree lags.

| Module | Section | What a black box can see |
|---|---|---|
| `lib/kogen/agents.ex` | §1.7.5 | Prints agent observations on status. |
| `lib/kogen/agents/codec.ex` | §1.7.5 | internal |
| `lib/kogen/agents/execution.ex` | §1.7.5 | internal |
| `lib/kogen/agents/output.ex` | §1.7.5 | internal |
| `lib/kogen/agents/store.ex` | §1.7.5 | internal |
| `lib/kogen/build.ex` | §3.5 | internal |
| `lib/kogen/build/cycle.ex` | §3.5 | Steps one attempt: plan, develop, verify, repair, escalate, or finish. |
| `lib/kogen/build/cycle/escalation.ex` | §3.5 | internal |
| `lib/kogen/build/cycle/event_data.ex` | §3.5 | internal |
| `lib/kogen/build/cycle/parallel.ex` | §3.5 | internal |
| `lib/kogen/build/cycle/provider_failure.ex` | §4.5 | Pauses on login or a usage limit and reruns the stage. |
| `lib/kogen/build/cycle/repair.ex` | §3.5 | internal |
| `lib/kogen/build/cycle/state.ex` | §3.5 | internal |
| `lib/kogen/build/cycle/steer.ex` | §3.5 | internal |
| `lib/kogen/build/cycle/stop.ex` | §3.5 | internal |
| `lib/kogen/build/demotion.ex` | §3.8.2 | Drops demoted acceptance items out of the red count. |
| `lib/kogen/build/gate_metrics.ex` | §3.1 | internal |
| `lib/kogen/build/gate_summary.ex` | §3.1 | internal |
| `lib/kogen/build/recipe.ex` | §3.1 | internal |
| `lib/kogen/build/selector.ex` | §3.8.3 | Picks the best candidate by checks, acceptance, then diff size. |
| `lib/kogen/build/verification.ex` | §3.8.1 | Decides whether demoted acceptance failures still leave a landable tree. |
| `lib/kogen/check_learning.ex` | §3.7.4 | Stores advisory check proposals. They do not change the gate. |
| `lib/kogen/check_learning/adoption.ex` | §3.7.4 | internal |
| `lib/kogen/check_learning/codec.ex` | §3.7.4 | internal |
| `lib/kogen/check_learning/effect.ex` | §3.7.4 | internal |
| `lib/kogen/check_learning/mining.ex` | §3.7.4 | internal |
| `lib/kogen/check_learning/qualification.ex` | §3.7.4 | internal |
| `lib/kogen/check_learning/sample.ex` | §3.7.4 | internal |
| `lib/kogen/check_learning/store.ex` | §3.7.4 | internal |
| `lib/kogen/checks.ex` | §3.7 | Runs fix, checks, and acceptance. |
| `lib/kogen/checks/baseline_fix.ex` | §3.7 | internal |
| `lib/kogen/checks/feedback.ex` | §3.7 | internal |
| `lib/kogen/checks/final_pass.ex` | §3.7 | internal |
| `lib/kogen/checks/final_pass/cache.ex` | §3.7 | internal |
| `lib/kogen/checks/fixer.ex` | §3.7 | internal |
| `lib/kogen/checks/ledger.ex` | §3.7 | internal |
| `lib/kogen/checks/ledger/elixir_runner.ex` | §2.4 | internal |
| `lib/kogen/checks/ledger/rails.ex` | §2.4.3 | Rails acceptance runner and Ruby syntax check. |
| `lib/kogen/checks/ledger/report.ex` | §2.4 | internal |
| `lib/kogen/checks/ledger/validation.ex` | §2.4 | internal |
| `lib/kogen/checks/ledger_codec.ex` | §3.7 | internal |
| `lib/kogen/checks/ledger_row.ex` | §3.7 | internal |
| `lib/kogen/checks/receipt_builder.ex` | §3.7 | internal |
| `lib/kogen/checks/run_state.ex` | §3.7 | internal |
| `lib/kogen/checks/runner.ex` | §3.7 | internal |
| `lib/kogen/checks/shape_formatter.ex` | §3.7 | internal |
| `lib/kogen/checks/shaping.ex` | §3.2.3 | Validates a shaped Intent and acceptance test. |
| `lib/kogen/checks/shaping/reclassifier.ex` | §3.2.3 | internal |
| `lib/kogen/checks/timing.ex` | §3.7 | internal |
| `lib/kogen/checks/verification.ex` | §3.7 | internal |
| `lib/kogen/cli.ex` | §1 | internal |
| `lib/kogen/cli/args.ex` | §1 | internal |
| `lib/kogen/cli/arguments.ex` | §1.2 | Parses the fixed command tree. |
| `lib/kogen/cli/help.ex` | §1.4 | Prints the static help pages. |
| `lib/kogen/cli/moved.ex` | §1.8 | Prints a moved: line. |
| `lib/kogen/cli/version.ex` | §1.7.7 | Prints kogen <sha8> (<date>). |
| `lib/kogen/contracts.ex` | §2 | internal |
| `lib/kogen/contracts/acceptance_item.ex` | §2 | internal |
| `lib/kogen/contracts/check_baseline.ex` | §2 | internal |
| `lib/kogen/contracts/check_output.ex` | §2 | internal |
| `lib/kogen/contracts/check_spec.ex` | §2 | internal |
| `lib/kogen/contracts/command_exit.ex` | §2 | internal |
| `lib/kogen/contracts/developer_failure.ex` | §2 | internal |
| `lib/kogen/contracts/failure.ex` | §2 | internal |
| `lib/kogen/contracts/finding.ex` | §2 | internal |
| `lib/kogen/contracts/gate_timing.ex` | §2 | internal |
| `lib/kogen/contracts/intent.ex` | §2 | internal |
| `lib/kogen/contracts/json.ex` | §2 | internal |
| `lib/kogen/contracts/mise_environment.ex` | §2 | internal |
| `lib/kogen/contracts/model_request.ex` | §2 | internal |
| `lib/kogen/contracts/model_response.ex` | §2 | internal |
| `lib/kogen/contracts/proc_port.ex` | §2 | internal |
| `lib/kogen/contracts/proc_result.ex` | §2 | internal |
| `lib/kogen/contracts/project.ex` | §2 | internal |
| `lib/kogen/contracts/provider_error.ex` | §2 | internal |
| `lib/kogen/contracts/provider_port.ex` | §2 | internal |
| `lib/kogen/contracts/receipt.ex` | §2 | internal |
| `lib/kogen/contracts/redact.ex` | §2 | internal |
| `lib/kogen/contracts/role_prompt.ex` | §2 | internal |
| `lib/kogen/contracts/shape_warning.ex` | §2 | internal |
| `lib/kogen/contracts/shape_warning_codec.ex` | §2 | internal |
| `lib/kogen/contracts/shaping_check.ex` | §2 | internal |
| `lib/kogen/contracts/stack.ex` | §2.4.3 | Picks Elixir or Rails acceptance paths and the test command. |
| `lib/kogen/contracts/tool_call.ex` | §2 | internal |
| `lib/kogen/contracts/worker_guard.ex` | §2 | internal |
| `lib/kogen/contracts/yaml.ex` | §2 | internal |
| `lib/kogen/contracts/yaml/scanner.ex` | §2.6 | internal |
| `lib/kogen/conversation.ex` | §4.9.6 | Opt-in checkpoint when build.context_bytes is set. |
| `lib/kogen/conversation/budget.ex` | §4.9.2 | Turn-budget note as an appended user item. |
| `lib/kogen/diagnostics.ex` | §3.7.3 | Turns gate output into findings and builder feedback. |
| `lib/kogen/diagnostics/dialyzer_summary.ex` | §3.7.3 | internal |
| `lib/kogen/diagnostics/ex_unit_details.ex` | §3.7.3 | internal |
| `lib/kogen/diagnostics/gate_assessment.ex` | §3.7.3 | internal |
| `lib/kogen/diagnostics/parser.ex` | §3.7.3 | internal |
| `lib/kogen/diagnostics/parser/common.ex` | §2.4.4 | internal |
| `lib/kogen/diagnostics/parser/compile.ex` | §2.4.4 | internal |
| `lib/kogen/diagnostics/parser/credo_failures.ex` | §2.4.4 | internal |
| `lib/kogen/diagnostics/parser/dialyzer.ex` | §2.4.4 | internal |
| `lib/kogen/diagnostics/renderer.ex` | §3.7.3 | internal |
| `lib/kogen/diagnostics/report.ex` | §3.7.3 | internal |
| `lib/kogen/diagnostics/ruby.ex` | §3.7.3 | internal |
| `lib/kogen/engine.ex` | §3.4 | Starts one Build in a candidate workspace. |
| `lib/kogen/engine/build/acceptance_progress.ex` | §3.4 | internal |
| `lib/kogen/engine/build/candidate_snapshot.ex` | §3.4 | internal |
| `lib/kogen/engine/build/check_proposals.ex` | §3.4 | internal |
| `lib/kogen/engine/build/check_stage.ex` | §3.4 | internal |
| `lib/kogen/engine/build/commit.ex` | §3.4 | internal |
| `lib/kogen/engine/build/engine.ex` | §3.4 | internal |
| `lib/kogen/engine/build/escalation.ex` | §3.4 | internal |
| `lib/kogen/engine/build/finish.ex` | §3.4 | internal |
| `lib/kogen/engine/build/gate_support.ex` | §3.4 | internal |
| `lib/kogen/engine/build/lifecycle.ex` | §3.4 | internal |
| `lib/kogen/engine/build/reviewer.ex` | §3.4 | internal |
| `lib/kogen/engine/build/run_events.ex` | §3.4 | internal |
| `lib/kogen/engine/build/setup.ex` | §3.4 | internal |
| `lib/kogen/engine/build/stage_runner.ex` | §3.4 | internal |
| `lib/kogen/engine/build/types.ex` | §3.4 | internal |
| `lib/kogen/engine/rails_environment.ex` | §2.4.3 | Bundler and Rails environment for a candidate. |
| `lib/kogen/engine/runtime.ex` | §5.2 | internal |
| `lib/kogen/flakes.ex` | §3.7.2 | One same-seed retry. At most two base-red tests are excused. |
| `lib/kogen/flakes/evidence.ex` | §3.7.2 | internal |
| `lib/kogen/harness.ex` | §3.2 | Runs shaping, planning, and the builder conversation. |
| `lib/kogen/harness/codec.ex` | §3.6 | internal |
| `lib/kogen/harness/context.ex` | §3.6 | internal |
| `lib/kogen/harness/continuation.ex` | §4.9.6 | Installs an accepted checkpoint before the next turn. |
| `lib/kogen/harness/developer.ex` | §3.6 | Builder loop. v1.2 completion is finish {}. This commit still treats text as a done claim. |
| `lib/kogen/harness/developer_support.ex` | §3.6 | internal |
| `lib/kogen/harness/exchange.ex` | §4.5 | Sends one model request with the cache key and the retry policy. |
| `lib/kogen/harness/gate.ex` | §3.6 | internal |
| `lib/kogen/harness/gate/arguments.ex` | §3.7 | internal |
| `lib/kogen/harness/gate/test_count.ex` | §3.7 | internal |
| `lib/kogen/harness/gate_command_runner.ex` | §3.6 | internal |
| `lib/kogen/harness/mutation_advice.ex` | §3.7.4 | Appends mutation advice. It does not change the verdict. |
| `lib/kogen/harness/one_shot.ex` | §3.6 | internal |
| `lib/kogen/harness/phase_timing.ex` | §3.6 | internal |
| `lib/kogen/harness/plan_sanitizer.ex` | §3.6 | internal |
| `lib/kogen/harness/plan_shell_prompts.ex` | §3.6 | internal |
| `lib/kogen/harness/prompt_cache_key.ex` | §4.9.1 | At this commit the key is still v1. v1.2 requires the v2 key. See DRIFT. |
| `lib/kogen/harness/rails_shaping.ex` | §2.4.3 | Rails acceptance instructions for the shaper. |
| `lib/kogen/harness/recording.ex` | §3.6 | internal |
| `lib/kogen/harness/shaper_tools.ex` | §3.6 | internal |
| `lib/kogen/harness/shaping.ex` | §3.2 | Runs the shaper conversation and its read, search, and write tools. |
| `lib/kogen/harness/stages.ex` | §3.6 | internal |
| `lib/kogen/harness/tooling_context.ex` | §3.6 | internal |
| `lib/kogen/harness/tools.ex` | §3.6 | internal |
| `lib/kogen/harness/types.ex` | §3.6 | internal |
| `lib/kogen/http.ex` | §4 | internal |
| `lib/kogen/http/transport.ex` | §4.3 | internal |
| `lib/kogen/http/transport/proxy.ex` | §4.3 | internal |
| `lib/kogen/intent.ex` | §2.1.3 | Hashes intent.md bytes only. |
| `lib/kogen/intent/advisory.ex` | §2.2 | internal |
| `lib/kogen/intent/lint.ex` | §2.2 | internal |
| `lib/kogen/intent/parser.ex` | §2.2 | internal |
| `lib/kogen/intent/parser/frontmatter.ex` | §2.1.2 | internal |
| `lib/kogen/intent/parser/scheduling.ex` | §2.11 | Parses blocks_on and priority. |
| `lib/kogen/intent/parser_structs.ex` | §2.2 | internal |
| `lib/kogen/intent/shaping_codec.ex` | §2.2 | internal |
| `lib/kogen/kernel.ex` | §1 | Dispatches the fixed CLI. |
| `lib/kogen/kernel/accounts.ex` | §1 | internal |
| `lib/kogen/kernel/approval.ex` | §1 | internal |
| `lib/kogen/kernel/approval_checks.ex` | §1 | internal |
| `lib/kogen/kernel/approval_manifest.ex` | §1 | internal |
| `lib/kogen/kernel/base.ex` | §1 | internal |
| `lib/kogen/kernel/build_config.ex` | §1 | internal |
| `lib/kogen/kernel/cli.ex` | §1 | internal |
| `lib/kogen/kernel/cli/error_output.ex` | §1.5 | Prints class/reason lines and exit codes. |
| `lib/kogen/kernel/cli/intent_removal.ex` | §1.7 | internal |
| `lib/kogen/kernel/cli/queue_command.ex` | §1.7 | internal |
| `lib/kogen/kernel/cli/runner.ex` | §1.7 | internal |
| `lib/kogen/kernel/cli/signal.ex` | §1.7 | internal |
| `lib/kogen/kernel/cli/status_command.ex` | §1.7 | internal |
| `lib/kogen/kernel/cli/status_output.ex` | §1.7.5 | Overview, slug text, and status JSON. |
| `lib/kogen/kernel/cli/task_input.ex` | §1.7 | internal |
| `lib/kogen/kernel/intent_removal.ex` | §1 | internal |
| `lib/kogen/kernel/origin.ex` | §1 | internal |
| `lib/kogen/kernel/project_context.ex` | §1 | internal |
| `lib/kogen/kernel/queueing.ex` | §1 | internal |
| `lib/kogen/kernel/runtime_discovery.ex` | §1 | internal |
| `lib/kogen/kernel/shape_execution.ex` | §1 | internal |
| `lib/kogen/kernel/shape_paths.ex` | §1 | internal |
| `lib/kogen/kernel/types.ex` | §1 | internal |
| `lib/kogen/kernel/workspaces.ex` | §1 | internal |
| `lib/kogen/mix.ex` | §6.2 | internal |
| `lib/kogen/proc.ex` | §5.1 | Runs a child with a deadline and a captured tail. |
| `lib/kogen/proc/request.ex` | §5.1 | internal |
| `lib/kogen/proc/runner.ex` | §5.1 | internal |
| `lib/kogen/proc/sandbox.ex` | §5.3 | Confines macOS commands. Other hosts run unconfined. The missing warning is DRIFT. |
| `lib/kogen/proc/toolchain.ex` | §5.1 | internal |
| `lib/kogen/proc/wrapper.ex` | §5.1 | internal |
| `lib/kogen/project.ex` | §2.3 | Loads project.yaml and merges machine build settings. |
| `lib/kogen/project/build_settings.ex` | §2.3 | internal |
| `lib/kogen/project/gate_paths.ex` | §2.3 | internal |
| `lib/kogen/project/loader.ex` | §2.3 | internal |
| `lib/kogen/project/setup_inputs.ex` | §2.9 | Accepts or rejects declared setup_inputs. |
| `lib/kogen/project/setup_key.ex` | §2.9 | Setup cache key. This commit hashes a runtime term. v1.2 requires the canonical JSON. |
| `lib/kogen/project/setup_links.ex` | §2.3 | internal |
| `lib/kogen/project/setup_reuse.ex` | §2.3 | internal |
| `lib/kogen/project/stack_defaults.ex` | §2.4.3 | Fills Rails checks, format, and setup when a Rails app is detected. |
| `lib/kogen/provider.ex` | §4.1 | internal |
| `lib/kogen/provider/chat_gpt.ex` | §4.2 | ChatGPT Responses client. No Grok client in this commit. |
| `lib/kogen/provider/chat_gpt/auth.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/callback.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/codec.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/codec/errors.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/codec/recording.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/credential_store.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/credential_store/profile.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/file_store.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/host_id.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/id_token.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/keychain_store.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/lock.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/loopback.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/oidc.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/pkce.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/refresh.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/refresh/codec.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/siwc.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/siwc/token_response.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/siwc_codec.ex` | §4.2 | internal |
| `lib/kogen/provider/chat_gpt/sse.ex` | §4.2 | internal |
| `lib/kogen/provider/fake.ex` | §4.8 | Replays a scripted provider. |
| `lib/kogen/quality.ex` | §3.7.4 | Source, clone, mutation, and reach advice. Not a gate. |
| `lib/kogen/quality/analysis.ex` | §3.7.4 | internal |
| `lib/kogen/quality/baseline.ex` | §3.7.4 | internal |
| `lib/kogen/quality/clones.ex` | §3.7.4 | internal |
| `lib/kogen/quality/codec.ex` | §3.7.4 | internal |
| `lib/kogen/quality/mutation.ex` | §3.7.4 | internal |
| `lib/kogen/quality/mutation/plan.ex` | §3.7.4 | internal |
| `lib/kogen/quality/process.ex` | §3.7.4 | internal |
| `lib/kogen/quality/reach.ex` | §3.7.4 | internal |
| `lib/kogen/quality/report.ex` | §3.7.4 | internal |
| `lib/kogen/quality/request.ex` | §3.7.4 | internal |
| `lib/kogen/quality/snapshot.ex` | §3.7.4 | internal |
| `lib/kogen/quality/source.ex` | §3.7.4 | internal |
| `lib/kogen/quality/source/external_resource.ex` | §3.7.4 | internal |
| `lib/kogen/quality/source/map_shapes.ex` | §3.7.4 | internal |
| `lib/kogen/quality/source/path.ex` | §3.7.4 | internal |
| `lib/kogen/quality/source/scope.ex` | §3.7.4 | internal |
| `lib/kogen/quality/suppressions.ex` | §3.7.4 | internal |
| `lib/kogen/quality/test_integrity.ex` | §3.7.4 | internal |
| `lib/kogen/queue.ex` | §3.11 | internal |
| `lib/kogen/queue/build_summary.ex` | §3.11 | internal |
| `lib/kogen/queue/drain.ex` | §3.11 | internal |
| `lib/kogen/queue/intent_status.ex` | §3.11 | internal |
| `lib/kogen/queue/ladder_report.ex` | §3.11 | internal |
| `lib/kogen/queue/liveness.ex` | §3.11 | internal |
| `lib/kogen/queue/lock.ex` | §3.11 | internal |
| `lib/kogen/queue/progress.ex` | §3.11 | internal |
| `lib/kogen/queue/recovery.ex` | §3.11 | internal |
| `lib/kogen/queue/report.ex` | §3.11 | internal |
| `lib/kogen/queue/scheduling.ex` | §2.11 | Loads blocks_on and priority from the approval. |
| `lib/kogen/queue/selection.ex` | §2.11 | Holds an Intent until blocks_on has landed. Sorts by priority. |
| `lib/kogen/queue/state_view.ex` | §3.11 | internal |
| `lib/kogen/queue/status.ex` | §2.11 | Derives draft, approved, blocked, building, failed, parked, interrupted, or landed. |
| `lib/kogen/resilience.ex` | §4.5 | internal |
| `lib/kogen/resilience/policy.ex` | §4.5 | internal |
| `lib/kogen/resilience/provider_call.ex` | §4.5 | internal |
| `lib/kogen/resilience/request_log.ex` | §4.5 | internal |
| `lib/kogen/resilience/retry.ex` | §4.5 | internal |
| `lib/kogen/runner.ex` | §3.1 | Drives the ladder, the wall, and landing. |
| `lib/kogen/runner/audit.ex` | §3.8.2 | Demotes inside the rung. |
| `lib/kogen/runner/auditor.ex` | §3.8.2 | Parses valid, over_strict, and contradicts. |
| `lib/kogen/runner/cross_check.ex` | §3.1 | Green parallel rungs run each other's tests. |
| `lib/kogen/runner/driver.ex` | §3.5 | internal |
| `lib/kogen/runner/edge_probe.ex` | §3.1 | Generated edge tests before landing, when enabled. |
| `lib/kogen/runner/edge_tests.ex` | §3.1 | Parses those generated tests. |
| `lib/kogen/runner/ladder.ex` | §3.5 | internal |
| `lib/kogen/runner/landing.ex` | §3.5 | internal |
| `lib/kogen/runner/rails_edge_tests.ex` | §3.1 | Parses Rails edge tests. |
| `lib/kogen/runner/scratch_tests.ex` | §3.7.4 | Runs extra tests as warnings, not as acceptance. |
| `lib/kogen/shaper.ex` | §3.2 | Shapes an Intent and its acceptance test. |
| `lib/kogen/shaper/progress.ex` | §3.2 | internal |
| `lib/kogen/shaper/runner.ex` | §3.2 | internal |
| `lib/kogen/shaper/runner_state.ex` | §3.2 | internal |
| `lib/kogen/shaper/setup.ex` | §3.2 | internal |
| `lib/kogen/shaper/shape_warnings.ex` | §3.2 | internal |
| `lib/kogen/shaper/types.ex` | §3.2 | internal |
| `lib/kogen/shaper/validation.ex` | §3.2 | internal |
| `lib/kogen/shaping.ex` | §3.2.8 | Rechecks assumptions and blocks_on before a Build. |
| `lib/kogen/state.ex` | §2.8 | Writes the run journal and the approval record. |
| `lib/kogen/state/approval.ex` | §2.8 | internal |
| `lib/kogen/state/approval_baseline_codec.ex` | §2.8 | internal |
| `lib/kogen/state/approval_store.ex` | §2.8 | internal |
| `lib/kogen/state/event.ex` | §2.8 | internal |
| `lib/kogen/state/file_store.ex` | §2.8 | internal |
| `lib/kogen/state/flakes.ex` | §3.7.2 | Records flake evidence on the run. |
| `lib/kogen/state/flakes/codec.ex` | §3.7.2 | internal |
| `lib/kogen/state/flakes/drafts.ex` | §3.7.2 | internal |
| `lib/kogen/state/json.ex` | §2.8 | internal |
| `lib/kogen/state/lifecycle.ex` | §2.8 | internal |
| `lib/kogen/state/operations.ex` | §2.8 | internal |
| `lib/kogen/state/phase_timing.ex` | §2.8 | internal |
| `lib/kogen/state/request_usage.ex` | §2.8 | internal |
| `lib/kogen/state/run.ex` | §2.8 | internal |
| `lib/kogen/state/run_store.ex` | §2.8 | internal |
| `lib/kogen/state/usage.ex` | §2.8 | internal |
| `lib/kogen/tooling.ex` | §4.7 | Executes model tools. |
| `lib/kogen/tooling/codec.ex` | §4.7 | internal |
| `lib/kogen/tooling/command.ex` | §4.7 | internal |
| `lib/kogen/tooling/context.ex` | §4.7 | internal |
| `lib/kogen/tooling/mutations.ex` | §4.7 | internal |
| `lib/kogen/tooling/paths.ex` | §4.7 | internal |
| `lib/kogen/tooling/read_search.ex` | §4.7 | internal |
| `lib/kogen/tooling/shaper_tools.ex` | §4.7 | internal |
| `lib/kogen/tooling/tools.ex` | §4.7 | internal |
| `lib/kogen/tooling/types.ex` | §4.7 | internal |
| `lib/kogen/workspace.ex` | §5.4 | Creates candidate checkouts and updates refs. |
| `lib/kogen/workspace/approval_manifest.ex` | §5.4 | internal |
| `lib/kogen/workspace/approved_file.ex` | §5.4 | internal |
| `lib/kogen/workspace/base_glob.ex` | §5.4 | internal |
| `lib/kogen/workspace/changed_ranges.ex` | §5.4 | internal |
| `lib/kogen/workspace/check_tree.ex` | §5.4 | internal |
| `lib/kogen/workspace/checked_out.ex` | §5.4 | internal |
| `lib/kogen/workspace/checkout.ex` | §5.4 | internal |
| `lib/kogen/workspace/copy.ex` | §5.4 | internal |
| `lib/kogen/workspace/diff.ex` | §5.4 | internal |
| `lib/kogen/workspace/git.ex` | §5.4 | internal |
| `lib/kogen/workspace/guard.ex` | §5.4 | internal |
| `lib/kogen/workspace/identity.ex` | §5.4 | internal |
| `lib/kogen/workspace/index.ex` | §5.4 | internal |
| `lib/kogen/workspace/intent_files.ex` | §5.4 | internal |
| `lib/kogen/workspace/landing.ex` | §5.4 | internal |
| `lib/kogen/workspace/protected_restore.ex` | §5.4 | internal |
| `lib/kogen/workspace/rebase.ex` | §5.4 | internal |
| `lib/kogen/workspace/refs.ex` | §5.4 | internal |
| `lib/kogen/workspace/status_refs.ex` | §5.4 | internal |
| `lib/mix/tasks/kogen.checks.effect.ex` | §6.2 | Mix-only repo tooling. Not the kogen CLI. |
| `lib/mix/tasks/kogen.checks.sample.ex` | §6.2 | Mix-only repo tooling. Not the kogen CLI. |
| `lib/mix/tasks/kogen.guard.ex` | §6.2 | Mix-only repo tooling. Not the kogen CLI. |
| `lib/mix/tasks/kogen.record_provider.ex` | §6.2 | Mix-only repo tooling. Not the kogen CLI. |

331 modules.
