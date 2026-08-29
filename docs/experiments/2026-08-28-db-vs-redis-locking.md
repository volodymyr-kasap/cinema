# Database locking vs Redis locking under contention

**Date:** 2026-08-28
**Spec:** `docs/superpowers/specs/2026-08-28-cinema-platform-phase-3-design.md` §9
**Scripts:** `load/correctness.js`, `load/performance.js`

## Prediction, recorded before the run

The `db` path should degrade first. Each of the nine thousand losers takes a
connection from the pool and blocks inside `ON CONFLICT` until the winner
commits, so contention for a seat becomes a queue for a connection, and the knee
is expected near `DATABASE_POOL_MAX × replicas`. The `redis` path should turn
losers away in one round-trip without opening a transaction, and should run into
something else — the network, and Redis being single-threaded.

If the numbers say otherwise, this document says so. An experiment that can only
confirm its hypothesis is not an experiment, and "Redis is not needed here"
would be as legitimate a result of this sub-project as the opposite.

## Conditions

|                           |                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Hardware                  | Apple M2, 8 cores, 16 GiB, macOS 26.5.2                                                                        |
| Docker VM                 | **2 vCPUs, 3.84 GiB** — the whole stack _and_ the load generator share this                                    |
| Images                    | `postgres:18-alpine`, `redis:8-alpine`, `grafana/k6:latest` (k6 v2.2.0), `node:24-alpine`, `nginx:1.29-alpine` |
| API replicas              | 3, behind nginx, reached at `http://web` from inside the network                                               |
| `DATABASE_POOL_MAX`       | 10 per replica (30 connections across the cluster)                                                             |
| `RESERVATION_TTL_SECONDS` | 600                                                                                                            |
| Hall                      | Premiere, 1000 seats, one seat per request                                                                     |
| Starting state            | `TRUNCATE reservation_seats, reservations CASCADE` + `FLUSHALL` before each run                                |

The Docker VM's two vCPUs are the most important line in that table, and the
"What this does not measure" section at the end says what it costs the result.

## Run 1 — correctness

10 000 attempts, attempt _n_ taking seat _n mod 1000_, so exactly ten clients
contend for each seat (ADR 0021).

| Strategy | 201  | 409  | 5xx | Active rows | Double bookings | Wall clock | Throughput |
| -------- | ---- | ---- | --- | ----------- | --------------- | ---------- | ---------- |
| `db`     | 1000 | 9000 | 0   | 1000        | 0               | 12.9 s     | 774 req/s  |
| `redis`  | 1000 | 9000 | 0   | 1000        | 0               | 5.0 s      | 1979 req/s |

Both pass. `verify.sh` confirmed the SQL half independently in both runs:
exactly 1000 active `reservation_seats` rows and zero duplicate
`(showtime_id, seat_id)` pairs.

The result `spec.md` §25 asks for, met by both strategies:

```
10 000 attempts  ->  1 000 reservations  ->  0 double bookings
```

Same work, 2.6× less time. That difference is the entire thesis of the
sub-project in one line: nine thousand losers who never open a transaction
finish sooner than nine thousand losers who do.

## Run 2 — performance

`ramping-arrival-rate`, four plateaus of 30 s each with 10 s ramps between them.
Numbers are from the plateaus only; the ramps are tagged separately and excluded.

Throughput is measured requests ÷ 30 s. "Error rate" counts genuine failures
(connection resets, 5xx) and **not** `409`s — a `409` is the correct answer to a
taken seat, and k6's own `http_req_failed` conflates the two.

| Strategy | Arrival rate | Throughput   | p95        | p99        | Error rate  | 409 share |
| -------- | ------------ | ------------ | ---------- | ---------- | ----------- | --------- |
| `db`     | 100          | 100.0 req/s  | 6.20 ms    | 13.49 ms   | 0.00 %      | 99.8 %    |
| `db`     | 500          | 500.0 req/s  | 9.34 ms    | 25.61 ms   | 0.00 %      | 100 %     |
| `db`     | 1000         | 945.0 req/s  | **1.84 s** | **2.18 s** | 2.31 %      | 97.7 %    |
| `db`     | 2000         | 1820.5 req/s | **2.71 s** | **3.41 s** | **60.72 %** | 39.3 %    |
| `redis`  | 100          | 100.0 req/s  | 4.82 ms    | 7.58 ms    | 0.00 %      | 99.8 %    |
| `redis`  | 500          | 500.0 req/s  | 1.47 ms    | 5.75 ms    | 0.00 %      | 100 %     |
| `redis`  | 1000         | 1000.0 req/s | 2.04 ms    | 11.08 ms   | 0.00 %      | 100 %     |
| `redis`  | 2000         | 2001.5 req/s | 8.50 ms    | 40.22 ms   | 0.00 %      | 100 %     |

Two execution numbers say the same thing from the other side:

|                                            | `db`   | `redis` |
| ------------------------------------------ | ------ | ------- |
| Peak VUs k6 needed to sustain the rate     | 1256   | **51**  |
| Iterations k6 had to drop, unable to start | 6879   | **0**   |
| Requests that failed outright              | 40 136 | **0**   |

k6 allocates a virtual user per in-flight request. Needing 1256 of them to hold
2000 req/s means requests were sitting in the system for most of a second;
needing 51 means they were not sitting at all.

Replica distribution over 60 probes, every run — the balance check that decides
whether any of this measured a cluster:

| Run                 | Tally        |
| ------------------- | ------------ |
| `db` correctness    | 14 / 23 / 23 |
| `redis` correctness | 19 / 14 / 27 |
| `db` performance    | 20 / 20 / 20 |
| `redis` performance | 23 / 20 / 17 |

All three replicas answered in all four runs, and none served less than half its
equal share. The runtime DNS resolution of ADR 0020 is doing its job.

## The knee

**`db` breaks between 500 and 1000 req/s.** It is not a bend, it is a cliff:
p95 goes from 9.34 ms to 1.84 s — a factor of 197 — for a doubling of offered
load. At 2000 req/s three in five requests fail outright.

**`redis` has no knee inside the tested range.** It served the full 2000 req/s
with a p95 of 8.5 ms and not one failure, so the ladder from `spec.md` §24 ran
out before the strategy did.

The resource `db` hit is the connection pool, as predicted, though the arithmetic
is coarser than the prediction implied. Thirty connections across three replicas,
each held for the length of a contended `INSERT ... ON CONFLICT` that waits on
the winner's commit, is what puts the ceiling somewhere just under 1000 req/s.
Past that, requests queue for a connection, the queue outlives the client's
patience, and the failures are connection resets rather than 5xx — the API never
got to answer at all.

`redis` did not reach its own limit here, so this run does **not** locate it. On
this hardware the honest statement is a lower bound: past 2000 req/s of pure
contention, unmeasured.

## What the numbers show

The prediction held, and held harder than expected. The `db` path degrades first,
it degrades at roughly the connection-pool ceiling, and it degrades
catastrophically rather than gracefully — 197× on p95 across one doubling of
load. The `redis` path absorbed the same offered load with millisecond latencies
and zero errors, because a loser costs one `SET NX` round-trip and never touches
Postgres.

The mechanism is visible in the 409 share. Under `redis` at every rate, ~100 % of
plateau traffic was a `409` answered without a transaction. Under `db` at
2000 req/s the 409 share _falls_ to 39 % — not because fewer requests conflicted,
but because 61 % never got an answer at all.

Worth stating plainly, because it bounds the claim: during the plateaus the hall
is already sold out. The 1000 seats go in the first ramp stage, so essentially
every plateau request is a loser. That is exactly the population this sub-project
set out to make cheap — nine thousand losers per thousand winners — and it is
therefore the right measurement for the question asked. It is not a measurement
of a mixed read/write workload, and nobody should quote these numbers as one.

So: Redis paid for itself here, decisively, for this shape of load. ADR 0008's
deferral was worth honouring — the baseline it preserved is what makes the claim
above a measurement rather than an opinion.

## What this does not measure

- **Two vCPUs for everything.** The stack and the load generator share the
  Docker VM's two cores, so the absolute numbers are small and the load generator
  competes with the system under test. The _comparison_ survives this — both
  strategies ran on the same machine, minutes apart, from the same starting state
  — but the absolute ceilings would move on real hardware, and `db`'s cliff would
  move with `DATABASE_POOL_MAX × replicas`.
- **`redis` was never pushed to its knee.** The ladder ends at 2000 req/s and
  Redis was still idling. Where it breaks, and on what, is unmeasured.
- **One seat per request.** A multi-seat hold pays for a pipeline of N `SET`
  commands and an N-row insert; neither is measured here.
- **No payment step**, so a `PENDING` hold is never held for its full ten
  minutes, and the lazy-expiry path is barely exercised under load.
- **Redis never fails during a measured run.** The cost of fail-open — a command
  timeout per request while Redis is down — is covered by tests, not by a number
  here.
- **A sold-out hall**, as described above: this is the contended-loser path, not
  a realistic mixed workload.
