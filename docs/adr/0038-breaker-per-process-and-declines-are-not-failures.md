# 38. One breaker per worker process, and a declined card is not a failure

**Status:** accepted (2026-09-04)

## Context

A provider that is down does not get better because more requests arrive. With
a prefetch of 20 across two workers, a dead provider means forty sockets waiting
on `PAYMENT_TIMEOUT_MS`, then forty retries, then eighty — a queue that drains
into a wall.

ADR 0029 named this: the cost of a dead subsystem is one timeout per operation,
and said the circuit breaker belongs here.

Two questions had to be answered: where the breaker's state lives, and what
counts as a failure.

## Decision

**One `CircuitBreaker` per worker process, state in memory.** Five consecutive
failures open it for `PAYMENT_BREAKER_OPEN_MS` (30 s), after which one trial
call is admitted; success closes it, failure re-opens it.

**Only a _thrown_ error counts.** A call that resolves has succeeded, whatever
it resolved to. A `DECLINED` response is a `200` with an opinion in it: the
provider is healthy and answered correctly, and a run of declined cards must not
stop the system from charging good ones. `ProviderUnavailableError` — a 5xx, a
socket error, a timeout — is what counts.

This keeps the breaker ignorant of what a card is. It knows only that its
callback threw.

`CircuitOpenError` is thrown instead of calling the provider, and it is an
ordinary failure to its caller: the message climbs to the next retry tier. The
breaker decides _whether_ to call; the ladder (ADR 0025) decides _when_ to try
again. Neither reimplements the other.

## Alternatives considered

- **Shared breaker state in Redis.** One process learns the provider is down and
  all of them stop calling — genuinely attractive. It puts Redis on the payment
  path, and "what if the breaker state is unreadable?" has only one honest
  answer: fail open, and call the provider anyway. That disables the breaker at
  exactly the moment infrastructure is unhealthy, which is the moment it exists
  for. ADR 0018 fails open on Redis for locking because the database is behind
  it; there is nothing behind the breaker.
- **One general breaker over Redis, the broker and the provider.** Redis and the
  broker both have fallback paths — the database path and lazy expiry. Tripping
  a breaker in front of a subsystem that already degrades gracefully adds a
  failure mode without removing one. The provider is the only downstream with no
  fallback, and it is the only one with a breaker.
- **Counting declines as failures.** Simpler code, and it means a bad afternoon
  for one bank's cards stops payments for everyone.
- **A rolling error rate rather than consecutive failures.** More sensitive, and
  needs a window, a minimum sample size and a second threshold to reason about.
  Consecutive failures against a single downstream is the smallest rule that
  does the job.

## Consequences

- Three workers can be in three different states. With the current replica count
  that is acceptable; a fourth failing independently is the signal to revisit
  shared state.
- Each worker pays its own five failures to learn the provider is down. Bounded,
  and the cost of not putting Redis on this path.
- `breakerRejections` is a counter on the client, and `payment.requested.dlq`
  depth is its companion. Both are ready for sub-project 10 to scrape.
- Stopping the provider container is a first-class test, which is exactly why
  the provider is a separate service (ADR 0040).
