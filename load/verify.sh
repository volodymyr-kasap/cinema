#!/usr/bin/env bash
# The half of the correctness assertion k6 cannot make: what is actually in the
# database. k6 counting 1000 successes and the database holding 1001 active rows
# would be the exact failure this sub-project exists to rule out.
set -euo pipefail

read -r active duplicates <<EOF2
$(docker compose exec -T postgres psql -U cinema -d cinema -At -F' ' -c "
  SELECT
    (SELECT count(*) FROM reservation_seats WHERE released_at IS NULL),
    (SELECT count(*) FROM (
       SELECT showtime_id, seat_id FROM reservation_seats WHERE released_at IS NULL
       GROUP BY showtime_id, seat_id HAVING count(*) > 1
     ) d)
")
EOF2

echo "active reservation_seats rows: ${active}"
echo "double-booked (showtime, seat) pairs: ${duplicates}"

if [ "${active}" != '1000' ] || [ "${duplicates}" != '0' ]; then
  echo 'FAIL: expected exactly 1000 active rows and 0 duplicates' >&2
  exit 1
fi
echo 'PASS: 1000 seats sold, each exactly once'
