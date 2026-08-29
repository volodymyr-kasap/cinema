#!/usr/bin/env bash
# Usage: LOCK_STRATEGY=redis DATABASE_POOL_MAX=20 bash load/performance.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
strategy="${LOCK_STRATEGY:-db}"
export LOCK_STRATEGY="$strategy"
mkdir -p "$here/results"

docker compose up -d --build
docker compose up -d --force-recreate --no-deps api

for _ in $(seq 1 60); do
  curl -sf 'http://localhost:8080/api/v1/movies?limit=1' >/dev/null && break
  sleep 2
done

bash "$here/reset.sh"
docker compose run --rm k6 run /scripts/performance.js 2>&1 |
  tee "$here/results/${strategy}-performance.txt"
