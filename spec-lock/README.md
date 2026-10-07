Immutable bootstrap inputs. `manifest.json` hashes the captured spec and suite bytes,
including Quint working edits and the untracked hand scenarios. Conformance is a clean
archive of v1.2 at 0f93bad988fb8d7a8eff4e94954d1db0a046c89d, regardless of the live
checkout. `CHANGES-v1.3.md` is included and its exact bytes are covered by the manifest.

Two ignored `attempts.log` harness outputs were present in the upstream dirty-worktree
inventory but are not normative inputs and were not copied into this bundle. Their
observed SHA-256 values are retained under `excluded_ignored_artifacts`; the frozen
source verifier checks every included file and reports these exclusions explicitly.
Do not regenerate this bundle from live checkout data or edit it to make tests pass.
Regeneration of model outputs runs on disposable copies. Affected draft goldens are
not yet certified; coordinated migrations and unresolved CHANGES-v1.3 findings remain
explicit work for packet 00 and integration rounds.
