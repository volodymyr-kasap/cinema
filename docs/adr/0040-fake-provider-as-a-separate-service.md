# 40. The fake provider is a separate workspace, image and service

**Status:** accepted (2026-09-04)

## Context

There is no real card processor here, and there should not be. But the point of
this sub-project is the failure behaviour — timeouts, 5xx, a breaker opening, an
idempotency key honoured across a lost response — and a fake that cannot produce
those failures proves none of it.

## Decision

`apps/payment-provider` is its own npm workspace, its own Fastify process, its
own Docker image and its own compose service. No database; charges live in a
`Map` keyed by `Idempotency-Key`. Four scenarios — `success`, `decline`,
`error`, `timeout` — selected by the `X-Payment-Scenario` header, or rolled from
the `PROVIDER_*_RATE` weights when the header is absent.

No published port: the worker is its only client, and nothing outside the
network has any business charging cards.

The scenario header is an ordinary input to a service that is a fake in its
entirety — not a backdoor bolted onto production code. What would be a backdoor
is the API branching on it, and the API never does: it copies the value onto the
payment row and forwards it unread.

## Alternatives considered

- **An in-process fake, injected behind the client interface.** The cheap
  option, and it cannot demonstrate the thing under test. A `setTimeout` in your
  own process is not a timeout: there is no socket, no connect, no
  `AbortController` firing against a real read. A breaker that has never seen a
  hung connection is not a demonstrated breaker, and an idempotency key honoured
  by a mock proves that the mock honours it.
- **A route on the API — `POST /__test/charge`.** Real HTTP, so the timeout is
  real. But proving the breaker opens means stopping the provider, and stopping
  this provider would stop the API. The demonstration and the thing being
  demonstrated cannot share a process.
- **A public mock service (httpbin, a hosted stub).** Puts the test suite on the
  internet and gives no control over the failure being simulated.
- **A container with a real provider's sandbox.** Credentials, rate limits, and
  network access in CI, to exercise failures the sandbox will not reliably
  produce on demand.

## Consequences

- `docker compose stop payment-provider` is a first-class experiment: the API
  keeps answering `202`, the worker logs `ProviderUnavailableError` and then
  `circuit is open`, and the seats come back through `PAYMENT_FAILED`.
- The worker `depends_on` the provider's health; the API deliberately does not.
  It never calls it, and a provider outage has no business delaying API startup.
- The weights are configurable, so the smoke test pins `PROVIDER_SUCCESS_RATE=1`
  and cannot fail by rolling a decline — a test that fails for a correct reason
  is still a test nobody trusts.
- The e2e suite starts it on a loopback port in Jest's global setup, so every
  test still charges over a real socket — the same reason the fake is not an
  injected stub. The container is what the compose stack and the Playwright
  smoke test use.
- Replacing it with a real processor is a URL and a client, because everything
  above the `PaymentProviderClient` interface is already ignorant of which one
  is behind it.
