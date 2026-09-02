# 30. Lazy expiry stays authoritative

**Status:** accepted (2026-09-01)

## Context

ADR 0011 predicted that a queue would eventually take expiry over. ADR 0022
already narrowed that prediction once, ruling out the Redis TTL as a
replacement. Phase 4 is the phase where the queue actually arrives, so the
prediction has to be answered rather than deferred again.

## Decision

It does not take over here either. `releaseStaleHolds` is untouched and remains
the guarantee. The worker is a **second route to the same result**, and the test
suite proves the system behaves identically with the broker stopped.

## Alternatives considered

- **Making the worker authoritative and deleting the lazy path.** One mechanism
  instead of two, and the seat comes back without waiting for a caller. It also
  makes the seat's return depend on a delivery: the one thing this project exists
  to get right would rest on the least reliable component in it.
- **Keeping both, but letting the worker skip the row lock — "the worker is the
  only writer".** It is not the only writer. A caller can expire the same hold at
  the same moment, which is exactly the race `FOR UPDATE` settles. The premise is
  false, and the optimisation it justifies would be a real double-write.

## Consequences

- Two paths write the same transition. This is deliberate duplication: both are
  idempotent, both take the same lock, and whichever arrives first wins.
- This is also why no scheduler exists anywhere in the codebase. The worker never
  polls for work; it acts on a message addressed to it. A sweeper scans for work
  that may not exist — this receives work that already does.
