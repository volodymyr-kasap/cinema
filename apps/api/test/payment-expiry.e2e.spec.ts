import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { ReservationService } from '../src/reservations/reservation.service';
import { getTestDatabaseUrl, getTestProviderUrl, getTestRabbitUrl } from './harness';
import { activeSeatCount, agePayment, paymentFor, reservationStatus } from './payment-harness';
import { deleteTopology, openInspection } from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('expiry while a payment is in flight', () => {
  let api: ReservationHarness;
  let service: ReservationService;
  let inspection: Awaited<ReturnType<typeof openInspection>>;

  /**
   * Blocks until another backend is waiting on a lock this connection holds, so
   * the sweep is proven to be parked on the row rather than merely given a head
   * start by a sleep.
   *
   * `pg_blocking_pids`, not `state = 'active' AND wait_event_type = 'Lock'`:
   * node-postgres sends the UPDATE over the extended protocol, and a backend
   * parked on a row lock inside a portal reports `idle in transaction`. That
   * predicate never matches, and the test then fails whether the code is right
   * or wrong.
   */
  const waitForBlockedWriter = async (client: Client): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND cardinality(pg_blocking_pids(pid)) > 0`,
      );
      if (Number(rows[0]!.n) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('no backend ever blocked on the reservation row');
  };

  const confirmWith = async (seat: string): Promise<string> => {
    const session = randomUUID();
    const reservation = await api.holdOne(seat, session);
    await api.act('POST', `/${reservation.id}/confirm`, session);
    return reservation.id;
  };

  beforeAll(async () => {
    inspection = await openInspection(getTestRabbitUrl());
    await deleteTopology(inspection.connection, 3);

    api = await startReservationHarness({
      lockStrategy: 'redis',
      expiryMode: 'queue',
      paymentMode: 'queue',
      rabbitmqUrl: getTestRabbitUrl(),
      paymentProviderUrl: getTestProviderUrl(),
      // One second, so the hold is genuinely past its deadline while the
      // payment is still running. No worker consumes here.
      ttlSeconds: 1,
    });
    service = api.app.get(ReservationService);
  });

  afterAll(async () => {
    await api.close();
    await inspection.channel.close().catch(() => {});
    await inspection.connection.close().catch(() => {});
  });

  beforeEach(async () => {
    await truncateReservations(api.db, api.redis);
  });

  it('will not expire a hold whose payment is running', async () => {
    const reservationId = await confirmWith(api.seatIds[0]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // The expire message was published when the hold was taken and arrives on
    // schedule. It must find a row that no longer belongs to it.
    await expect(service.settleExpired(reservationId)).resolves.toBe('awaiting-payment');

    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');
    // The seats are the point: un-selling them here would hand away a seat
    // whose charge may already have gone through.
    expect(await activeSeatCount(api.db, reservationId)).toBe(1);
  });

  it('still treats a settled payment as terminal', async () => {
    const reservationId = await confirmWith(api.seatIds[1]!);
    const payment = await paymentFor(api.db, reservationId);
    await api.app.get(ReservationService).settlePayment(payment!.id, {
      status: 'SUCCEEDED',
      providerRef: 'ch_test',
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // CONFIRMED reaches the existing terminal branch unchanged; only
    // PAYMENT_PENDING gets the new answer.
    await expect(service.settleExpired(reservationId)).resolves.toBe('terminal');
    expect(await activeSeatCount(api.db, reservationId)).toBe(1);
  });

  it('leaves a payment that has not yet reached its deadline alone', async () => {
    const reservationId = await confirmWith(api.seatIds[2]!);
    // Past the hold's own one-second TTL. Without this wait the Redis key
    // answers 409 before create() ever opens the transaction, and the test
    // would pass just as happily with the second arm's negative case wrong --
    // or missing altogether.
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // Someone else asks for the same seat. The sweep runs, and must not take a
    // seat from a payment that is only seconds old.
    const response = await api.hold([api.seatIds[2]!], randomUUID());
    expect(response.statusCode).toBe(409);
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');
  });

  it('reaps a payment that never came back and frees its seats', async () => {
    const reservationId = await confirmWith(api.seatIds[3]!);
    const payment = await paymentFor(api.db, reservationId);
    // The message reached the DLQ, or the worker died holding it. Nothing will
    // ever settle this row, and PAYMENT_DEADLINE_SECONDS is how long we wait
    // before saying so.
    await agePayment(api.db, payment!.id, 400);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const response = await api.hold([api.seatIds[3]!], randomUUID());

    expect(response.statusCode).toBe(201);
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);
    // The payment is marked too: a PENDING payment row against a PAYMENT_FAILED
    // reservation would be a lie in the ledger.
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'FAILED' });
  });

  it('leaves the seats of a payment that succeeded mid-sweep alone', async () => {
    const reservationId = await confirmWith(api.seatIds[6]!);
    const payment = await paymentFor(api.db, reservationId);
    await agePayment(api.db, payment!.id, 400);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // The ladder's last attempt landing late. settlePayment has no deadline
    // check -- it asks only for a PENDING payment against a PAYMENT_PENDING
    // reservation -- so a genuine provider success can confirm a booking the
    // sweep has already read as abandoned.
    //
    // The row lock is what makes the interleaving deterministic rather than
    // lucky: the sweep's SELECT takes no locks, so it passes and reads the row
    // as stale; its UPDATE then blocks here until this transaction commits, and
    // re-evaluates against a row that is now CONFIRMED.
    const late = new Client({ connectionString: getTestDatabaseUrl() });
    await late.connect();
    let contender: ReturnType<typeof api.hold>;
    try {
      await late.query('BEGIN');
      await late.query('SELECT id FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);

      // `inject` returns a lazy chain: it dispatches when something calls
      // `.then`, not when it is constructed. Without this the request would sit
      // unsent until the assertion at the bottom awaited it -- long after the
      // window it is supposed to land in.
      contender = Promise.resolve(api.hold([api.seatIds[6]!], randomUUID()));
      await waitForBlockedWriter(late);

      await late.query(
        `UPDATE reservations SET status = 'CONFIRMED', confirmed_at = now(), updated_at = now()
         WHERE id = $1`,
        [reservationId],
      );
      await late.query(
        `UPDATE payments SET status = 'SUCCEEDED', provider_ref = 'ch_late', settled_at = now()
         WHERE id = $1`,
        [payment!.id],
      );
      await late.query('COMMIT');
    } finally {
      await late.query('ROLLBACK').catch(() => {});
      await late.end();
    }

    // The seats were never free, so the contender loses on the index.
    expect((await contender!).statusCode).toBe(409);
    expect(await reservationStatus(api.db, reservationId)).toBe('CONFIRMED');
    // The whole point. Gating the release on the pre-select snapshot instead of
    // on what the status update returned releases these seats while the
    // reservation stays CONFIRMED -- a paid booking silently losing its seats,
    // and the same seats immediately re-sellable.
    expect(await activeSeatCount(api.db, reservationId)).toBe(1);
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('reaps stale holds and abandoned payments in the same sweep', async () => {
    const abandoned = await confirmWith(api.seatIds[4]!);
    const payment = await paymentFor(api.db, abandoned);
    await agePayment(api.db, payment!.id, 400);

    const stale = await api.holdOne(api.seatIds[5]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const response = await api.hold([api.seatIds[4]!, api.seatIds[5]!], randomUUID());

    expect(response.statusCode).toBe(201);
    expect(await reservationStatus(api.db, abandoned)).toBe('PAYMENT_FAILED');
    expect(await reservationStatus(api.db, stale.id)).toBe('EXPIRED');
  });
});
