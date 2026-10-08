# Approval and Intent xspec fixtures

The hand and generated Quint events use small symbolic values so traces remain
readable. Those values are fixture identities, not Git object IDs or SHA-256
digests. The adapters bind them to source bytes in a private real Git origin
and checkout, calculate the production approval hash from those bytes, and
pass that digest to the production approval transition.

## Approve slice

`sha` and `sha8` are model labels. The adapter puts the label in fixture Intent
and acceptance source bytes and calculates the SHA-256 digest over the exact
bytes. A `given` value is treated as a matching symbolic prefix only when it is
at least six lowercase hexadecimal characters and is a prefix of `sha`. The
adapter then passes the same number of leading characters from the calculated
digest to production. Any other `given` is translated to a digest prefix with
its first nibble changed, which makes the real hash check fail.

`prefixOk` stays in the event schema because it belongs to the frozen model,
but the adapter does not use it to decide whether the hash matches. A generated
event whose symbolic `given`/`sha` relation disagrees with `prefixOk` therefore
exposes a model-to-byte-fixture divergence instead of manufacturing a hash
result. `newSha8` labels the changed Intent bytes used by the late-read
mutation case; the changed bytes are rehashed by the production transition.

## Intent slice

`abcd1234`, `bbbb2222`, and `cccc3333` are successful symbolic approval
identities. For each commit event, the chosen identity is written into a
distinct fixture Intent, then the adapter calculates the actual approval hash
and passes its leading bytes to production. Other values, such as `ffff0000`,
are translated to a deliberately nonmatching prefix. `prefixOk` remains in the
frozen event schema and is ignored for the same reason as in the Approve
slice.

The card mode displays its symbolic `hash` label and does not create an
approval ref. In commit mode, `race: "once"` and `race: "twice"` inject one or
two real competing `update-ref` operations so the production Git compare-and-
swap path handles the retry or loss. Shape events write and commit exact
fixture Intent and acceptance bytes so removal exercises real tracked paths.

The byte builders, hash binding, isolated repositories, and real Git effects
are in [approval-fixture.ts](../../packages/test-support/src/approval-fixture.ts);
the protocol-facing adapters are in [approve.ts](../../packages/xspec/src/slices/approve.ts)
and [intent.ts](../../packages/xspec/src/slices/intent.ts).
