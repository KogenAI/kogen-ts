# Deferred Linux validations

This is the append-only register for Linux checks deferred by the coordinator.
Later integration gates must append their own entries without replacing earlier
ones. An open entry is not a pass or waiver. Record the Linux host, source SHA,
exact commands, and results when closing an entry. Every entry must pass before
release gate I7 and before any public claim.

| Gate | Deferred Linux checks | Reason | Required closure | Status |
| --- | --- | --- | --- | --- |
| I0 | Packet 02 kill/pipe/framing spike including parent-kill process-group cleanup; I0 native-bridge and hostile-link smoke; packet 05 real chatty/TERM/grandchild/SIGKILL custody checks including Linux subreaper/parent-death cleanup; packet 08 B07 recheck including mount and missing-user-namespace tests. | No Linux runner is available on the Mac Studio. | Pass on a Linux benchmark host in the joint Go and TypeScript validation batch, before I7 and before any public claim. | OPEN |
