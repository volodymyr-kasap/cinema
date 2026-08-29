import http from 'k6/http';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

import { uuid } from './lib/uuid.js';
import { findPremiereShowtime } from './lib/target.js';
import { checkReplicaBalance } from './lib/replicas.js';

const BASE_URL = __ENV.BASE_URL || 'http://web';
const REPLICAS = Number(__ENV.API_REPLICAS || '3');

const created = new Counter('reservations_created');
const conflicted = new Counter('reservations_conflicted');
const unexpected = new Counter('reservations_unexpected');

export const options = {
  scenarios: {
    correctness: {
      executor: 'shared-iterations',
      vus: 100,
      iterations: 10_000,
      maxDuration: '10m',
    },
  },
  /**
   * The result of the sub-project, as a pass/fail that does not depend on how
   * fast the machine is (spec §9):
   *
   *   10 000 attempts -> 1 000 reservations -> 0 double bookings
   *
   * These hold for BOTH strategies. If the Redis run produces 999, a lock is
   * being leaked somewhere; if it produces 1001, the advisory lock has been
   * allowed to overrule the index, which is the one thing it must never do.
   */
  thresholds: {
    reservations_created: ['count==1000'],
    reservations_conflicted: ['count==9000'],
    reservations_unexpected: ['count==0'],
    checks: ['rate==1.00'],
  },
};

export function setup() {
  return findPremiereShowtime(BASE_URL);
}

export default function correctness(target) {
  // Deterministic, not random: attempt n takes seat n mod 1000, so exactly ten
  // clients fight over each seat. Random choice would leave 0.05 seats untaken
  // on average -- the coupon collector with 10 000 draws into 1000 bins -- and
  // the run would fail once in twenty for a reason that has nothing to do with
  // locking (ADR 0021).
  const seatId = target.seatIds[exec.scenario.iterationInTest % target.seatIds.length];

  const response = http.post(
    `${BASE_URL}/api/v1/reservations`,
    JSON.stringify({ showtimeId: target.showtimeId, seatIds: [seatId] }),
    {
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': uuid() },
      tags: { name: 'POST /reservations' },
    },
  );

  if (response.status === 201) created.add(1);
  else if (response.status === 409) conflicted.add(1);
  else {
    unexpected.add(1);
    console.error(`unexpected ${response.status}: ${response.body}`);
  }
}

export function teardown() {
  checkReplicaBalance(BASE_URL, REPLICAS);
}
