#!/usr/bin/env bash
# The shared starting state. Both strategies must begin from the same empty
# hall, or the comparison is between two different experiments.
set -euo pipefail

docker compose exec -T postgres psql -U cinema -d cinema \
  -c 'TRUNCATE reservation_seats, reservations CASCADE'
docker compose exec -T redis redis-cli FLUSHALL
echo 'reset: reservations truncated, redis flushed'
