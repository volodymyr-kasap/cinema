# Cinema Ticket Booking

Seat booking with Redis-backed holds, on Node.js + Fastify + TypeScript.
A port of the original Go service.

Booking a seat is a three-step session: **hold** it (2 minutes by default),
then **confirm** it or **release** it. Holds that nobody confirms expire on
their own, so an abandoned checkout frees the seat without any sweeper job.

## Running

```bash
npm install
docker compose up -d redis      # or: docker compose up --build  (api + redis + redis-commander)
npm run dev                     # http://localhost:8080
```

Open <http://localhost:8080> for the seat picker. Redis Commander, when the
full compose stack is up, is at <http://localhost:8081>.

| Env var             | Default                  | Meaning                             |
| ------------------- | ------------------------ | ----------------------------------- |
| `PORT`              | `8080`                   | HTTP port                           |
| `HOST`              | `0.0.0.0`                | Bind address                        |
| `REDIS_URL`         | `redis://localhost:6379` | Redis connection                    |
| `HOLD_TTL_SECONDS`  | `120`                    | How long a hold survives unconfirmed |
| `STORE`             | `redis`                  | `redis` or `memory` (no Redis needed) |

## API

| Method   | Path                                    | Body              | Success |
| -------- | --------------------------------------- | ----------------- | ------- |
| `GET`    | `/movies`                               | —                 | `200`   |
| `GET`    | `/movies/:movieId/seats`                | —                 | `200`   |
| `POST`   | `/movies/:movieId/seats/:seatId/hold`   | `{"user_id":"…"}` | `201`   |
| `PUT`    | `/sessions/:sessionId/confirm`          | `{"user_id":"…"}` | `200`   |
| `DELETE` | `/sessions/:sessionId`                  | `{"user_id":"…"}` | `204`   |

Failures answer with `{"error": "…"}` and a real status code: `400` malformed
body, `403` the session belongs to another user, `404` unknown or expired
session, `409` the seat is already taken.

## How the seat lock works

Two keys per booking:

```
seat:{movieId}:{seatId}  ->  booking JSON   (TTL = held, no TTL = confirmed)
session:{sessionId}      ->  seat key       (reverse lookup)
```

`SET NX PX` on the seat key *is* the lock — the first writer wins, everyone
else gets `409`. Confirming rewrites the key with a plain `SET`, which drops
the TTL, so the booking stops expiring.

Confirm and release are check-then-act (read the session, verify the owner,
mutate), so they run as Lua scripts. Redis executes those atomically, which
keeps two concurrent requests on the same session from interleaving. Scripts
are sent once and afterwards invoked by SHA.

## Tests

```bash
npm test
```

- `test/api.test.ts` drives the routes through `app.inject()` against the
  in-memory store — no Redis required.
- `test/concurrent-booking.test.ts` fires **100,000** holds at a single seat
  and asserts exactly one wins. It needs Redis on `REDIS_URL` and skips itself
  when there is none. Set `CONCURRENCY_TEST_USERS` to run a smaller wave.

## Notes on the port

- **Errors reach the client.** The Go handlers logged failures and returned
  early, so the browser got `200` with an empty body; the frontend was already
  written to read `{error: …}`. Every failure now carries a status and that
  shape.
- **Session ownership is enforced.** `user_id` was accepted but never checked
  on confirm/release — anyone holding a session id could confirm another
  user's seat. It is verified inside the Lua scripts now.
- **`movie_id`, not `movieID`.** The hold response used a key the frontend
  never read, which left `activeSession.movieID` undefined in the checkout panel.
- **One store instead of three.** Go had a memory store, a mutex-guarded store,
  and the Redis one. Node's event loop gives the in-memory store its atomicity
  for free, so the mutex variant has no counterpart here.
