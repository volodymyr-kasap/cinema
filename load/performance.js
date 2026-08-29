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
const failed = new Counter('reservations_failed');

/**
 * The plateaus of the ladder below, in milliseconds from the start of the run.
 * Requests are tagged with the plateau they land in so the summary can report a
 * row per arrival rate; the ramps between them are tagged `ramp` and left out,
 * because a climb measures the climb.
 */
const PLATEAUS = [
  { rate: '100', from: 10_000, to: 40_000 },
  { rate: '500', from: 50_000, to: 80_000 },
  { rate: '1000', from: 90_000, to: 120_000 },
  { rate: '2000', from: 130_000, to: 160_000 },
];

function plateau() {
  const elapsed = exec.instance.currentTestRunDuration;
  for (const stage of PLATEAUS) {
    if (elapsed >= stage.from && elapsed < stage.to) return stage.rate;
  }
  return 'ramp';
}

/**
 * k6's end-of-test summary only breaks a metric down by tag when a threshold
 * names that tag, so these exist purely to materialise the per-plateau
 * sub-metrics. Every one of them is trivially true (`>= 0`) and therefore cannot
 * turn a run red for being slow -- which would defeat the point of the run.
 */
const perPlateau = {};
for (const { rate } of PLATEAUS) {
  perPlateau[`http_req_duration{rate:${rate}}`] = ['p(95)>=0'];
  perPlateau[`http_reqs{rate:${rate}}`] = ['count>=0'];
  perPlateau[`http_req_failed{rate:${rate}}`] = ['rate>=0'];
  perPlateau[`reservations_created{rate:${rate}}`] = ['count>=0'];
  perPlateau[`reservations_conflicted{rate:${rate}}`] = ['count>=0'];
  perPlateau[`reservations_failed{rate:${rate}}`] = ['count>=0'];
}

export const options = {
  scenarios: {
    ramp: {
      /**
       * Arrival rate, not a fixed number of VUs (spec §9). With fixed VUs a
       * system that slows down lowers its own offered load and keeps looking
       * healthy; at a fixed arrival rate the overload shows up honestly, as a
       * growing queue.
       */
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 3_000,
      // Ramp to each step, then hold it: the numbers of interest are from the
      // plateaus, not from the climbs. Section 24's ladder is 100/500/1000/2000.
      stages: [
        { target: 100, duration: '10s' },
        { target: 100, duration: '30s' },
        { target: 500, duration: '10s' },
        { target: 500, duration: '30s' },
        { target: 1_000, duration: '10s' },
        { target: 1_000, duration: '30s' },
        { target: 2_000, duration: '10s' },
        { target: 2_000, duration: '30s' },
      ],
    },
  },
  /**
   * Only the replica-balance probe is a check, and only it is a threshold. A
   * red run therefore means "the topology is wrong", never "the system was
   * slow" -- 5xx and latency at 2000 RPS are the finding this run exists to
   * produce, and a threshold that aborted on them would hide the knee.
   */
  thresholds: { checks: ['rate==1.00'], ...perPlateau },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  return findPremiereShowtime(BASE_URL);
}

export default function performance(target) {
  const seatId = target.seatIds[exec.scenario.iterationInTest % target.seatIds.length];
  const rate = plateau();

  const response = http.post(
    `${BASE_URL}/api/v1/reservations`,
    JSON.stringify({ showtimeId: target.showtimeId, seatIds: [seatId] }),
    {
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': uuid() },
      tags: { name: 'POST /reservations', rate },
    },
  );

  if (response.status === 201) created.add(1, { rate });
  else if (response.status === 409) conflicted.add(1, { rate });
  else failed.add(1, { rate });
}

export function teardown() {
  checkReplicaBalance(BASE_URL, REPLICAS);
}
