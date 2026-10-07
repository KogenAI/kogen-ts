# Bootstrap decisions

Owner authorization to implement supersedes the historical planning-only paragraphs.
The live suite was dirty on v1.3; archive committed v1.2 at 0f93bad instead of changing
it. Spec HEAD is e19dd1c; tracked working edits and nonignored untracked Quint files
are captured and hashed. Rust HEAD is a402540, reference only. No upstream was edited.

Pinned @types/bun/bun-types 1.4.2 with @types/node 24.10.1 has declaration-only errors
(TextEncoderEncodeIntoResult, ConnectionOptions, KeyObject, TLSSocket and TZ). Set
skipLibCheck for dependency declarations; strict/noUncheckedIndexedAccess/
exactOptionalPropertyTypes and noEmit still check owned code. No package pin changed.
Bun's workspace default isolated linker prevents explicit Node types from being found;
use an explicit hoisted linker in bunfig.toml and verify a fresh offline frozen install.

No Homebrew Bash exists on this Studio. Owner explicitly admits Bash 3; dispatcher
uses /bin/bash 3.2.57 without mapfile/associative arrays. MAX defaults to 4 per owner;
3 remains the plan's resource recommendation. Record actual Studio OS/compiler/SDK
rather than misreporting the planning host's reference builds.

The kogen-bench checkout is absent here. LICENSE is the standard full Apache-2.0
text copied from the existing Kogen checkout, the requested same license.
Optional ExUnit/Rails and Linux fixture pins are not bootstrap runtime prerequisites.
The native implementation begins with package 02; check compiles all C units once added.

Frozen Quint models/scenarios/goldens preserve source provenance, not a certified
v1.3 replay set. Unresolved review findings and common prompt/role experiment freezes
remain packet 00/integration work. Never fabricate common owner decisions to dispatch.
