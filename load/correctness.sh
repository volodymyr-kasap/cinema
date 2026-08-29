#!/usr/bin/env bash
# Usage: LOCK_STRATEGY=redis bash load/correctness.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
strategy="${LOCK_STRATEGY:-db}"
export LOCK_STRATEGY="$strategy"
mkdir -p "$here/results"

docker compose up -d --build
# The API reads LOCK_STRATEGY once, at startup, so switching strategies means
# replacing the containers -- not just exporting a variable.
docker compose up -d --force-recreate --no-deps api

# Through nginx, because that is the path the run takes: this waits for the
# replicas AND for the balancer to resolve them.
for _ in $(seq 1 60); do
  curl -sf 'http://localhost:8080/api/v1/movies?limit=1' >/dev/null && break
  sleep 2
done

bash "$here/reset.sh"
docker compose run --rm k6 run /scripts/correctness.js 2>&1 |
  tee "$here/results/${strategy}-correctness.txt"
bash "$here/verify.sh" 2>&1 | tee -a "$here/results/${strategy}-correctness.txt"
