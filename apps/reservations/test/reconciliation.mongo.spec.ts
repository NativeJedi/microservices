import { ReservationDocument } from '../src/entities/reservation.entity';
import {
  MONGO_STARTUP_TIMEOUT_MS,
  MongoTestApp,
  minutesAgo,
  sleep,
} from './mongo-test-app';

const MAX_ATTEMPTS = 5;
// What reaches reservations when payments throws something other than RpcException
const UNKNOWN_RPC_ERROR = { status: 'error', message: 'Internal server error' };

describe('ReconciliationService (in-memory Mongo)', () => {
  const app = new MongoTestApp();

  beforeAll(() => app.start(), MONGO_STARTUP_TIMEOUT_MS);
  afterAll(() => app.stop());
  beforeEach(() => app.reset());

  describe('recovery', () => {
    it('confirms a reservation that was charged but never confirmed', async () => {
      app.charge.mockResolvedValue('pi_recovered');
      const stuck = await app.seed({ status: 'pending', invoiceId: null });

      await app.reconciliation.reconcile();

      const recovered = await app.read(stuck._id);
      expect(recovered).toMatchObject({
        status: 'confirmed',
        invoiceId: 'pi_recovered',
        lockedUntil: null,
      });
      expect(recovered.outbox).toHaveLength(1);
      expect(recovered.outbox[0]).toMatchObject({
        eventId: `reservation-confirmed-${stuck._id.toHexString()}`,
        publishedAt: null,
      });
    });

    it('charges with the stored reservation so the idempotency key matches the original request', async () => {
      const stuck = await app.seed();

      await app.reconciliation.reconcile();

      const [[charged]] = app.charge.mock.calls;
      expect(charged._id.equals(stuck._id)).toBe(true);
      expect(charged).toMatchObject({ amount: 10, email: 'user@example.com' });
    });

    it('recovers a reservation written before the attempts counter existed', async () => {
      const legacyId = await app.seedRaw({
        status: 'pending',
        timestamp: minutesAgo(3),
        clientKey: 'legacy',
        email: 'user@example.com',
        amount: 10,
        paymentMethodId: 'pm_card_visa',
      });

      await app.reconciliation.reconcile();

      expect(await app.read(legacyId)).toMatchObject({ status: 'confirmed' });
    });
  });

  describe('selection', () => {
    it.each<[string, Partial<ReservationDocument>]>([
      ['failed', { status: 'failed' }],
      ['confirmed', { status: 'confirmed' }],
      ['younger than the stale threshold', { timestamp: new Date() }],
      [
        'locked by another instance',
        { lockedUntil: new Date(Date.now() + 60_000) },
      ],
    ])('ignores a reservation that is %s', async (_case, overrides) => {
      const reservation = await app.seed(overrides);

      await app.reconciliation.reconcile();

      expect(app.charge).not.toHaveBeenCalled();
      expect(await app.read(reservation._id)).toMatchObject({
        status: overrides.status ?? 'pending',
        reconcileAttempts: 0,
      });
    });
  });

  describe('locking', () => {
    it('lets only one of two parallel instances claim a reservation', async () => {
      app.charge.mockImplementation(async () => {
        await sleep(50);
        return 'pi_1';
      });
      await app.seed();

      await Promise.all([
        app.reconciliation.reconcile(),
        app.newReconciliationInstance().reconcile(),
      ]);

      expect(app.charge).toHaveBeenCalledTimes(1);
    });

    it('does not retry a failed reservation within the same pass', async () => {
      app.charge.mockRejectedValue(UNKNOWN_RPC_ERROR);
      const stuck = await app.seed();

      await app.reconciliation.reconcile();

      expect(app.charge).toHaveBeenCalledTimes(1);
      const stored = await app.read(stuck._id);
      expect(stored).toMatchObject({ status: 'pending', reconcileAttempts: 1 });
      expect(stored.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('failures', () => {
    it('keeps an unknown result pending until the attempts run out, then asks for review', async () => {
      app.charge.mockRejectedValue(UNKNOWN_RPC_ERROR);
      const stuck = await app.seed();

      for (let pass = 1; pass <= MAX_ATTEMPTS; pass++) {
        await app.reconciliation.reconcile();
        const expected = pass < MAX_ATTEMPTS ? 'pending' : 'needs_review';
        expect((await app.read(stuck._id)).status).toBe(expected);
        await app.expireLocks();
      }

      expect(app.charge).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      expect(await app.read(stuck._id)).toMatchObject({
        status: 'needs_review',
        failureReason: 'Payment service unavailable',
        lockedUntil: null,
      });
    });

    it('fails a declined reservation with the reason', async () => {
      app.charge.mockRejectedValue({
        kind: 'declined',
        message: 'Your card was declined.',
      });
      const stuck = await app.seed();

      await app.reconciliation.reconcile();

      expect(await app.read(stuck._id)).toMatchObject({
        status: 'failed',
        failureReason: 'Your card was declined.',
        lockedUntil: null,
      });
    });

    it('moves a reservation that died during its last attempt to review without charging', async () => {
      const stuck = await app.seed({
        reconcileAttempts: MAX_ATTEMPTS,
        lockedUntil: minutesAgo(1),
      });

      await app.reconciliation.reconcile();

      expect(app.charge).not.toHaveBeenCalled();
      expect(await app.read(stuck._id)).toMatchObject({
        status: 'needs_review',
        failureReason: 'reconciliation attempts exhausted',
      });
    });

    it('never retries past the Stripe idempotency window', async () => {
      const stuck = await app.seed({ timestamp: minutesAgo(24 * 60) });

      await app.reconciliation.reconcile();

      expect(app.charge).not.toHaveBeenCalled();
      expect(await app.read(stuck._id)).toMatchObject({
        status: 'needs_review',
        failureReason:
          'idempotency window expired, verify the charge in Stripe',
      });
    });
  });

  describe('errors after a successful charge', () => {
    // Only the confirmation ($push of the outbox event) fails; claims still hit Mongo
    function failConfirmation(error: Error) {
      jest
        .spyOn(app.repository, 'findOneAndUpdateOrNull')
        .mockImplementation((filter, changes) =>
          '$push' in changes
            ? Promise.reject(error)
            : app.model
                .findOneAndUpdate(filter, changes, { returnDocument: 'after' })
                .lean<ReservationDocument>()
                .exec(),
        );
    }

    afterEach(() => jest.restoreAllMocks());

    it('does not treat a database error as a payment failure', async () => {
      failConfirmation(new Error('write concern timeout'));
      const stuck = await app.seed();

      await app.reconciliation.reconcile();

      expect(app.charge).toHaveBeenCalledTimes(1);
      expect(await app.read(stuck._id)).toMatchObject({
        status: 'pending',
        failureReason: null,
        reconcileAttempts: 1,
      });
      expect(app.deleteInterval).not.toHaveBeenCalled();
    });

    it('stops the job on a bug in our code instead of charging again', async () => {
      failConfirmation(new TypeError('Cannot read properties of undefined'));
      await app.seed();
      await app.seed();

      await app.reconciliation.reconcile();

      expect(app.charge).toHaveBeenCalledTimes(1);
      expect(app.deleteInterval).toHaveBeenCalledWith(
        'reservation-reconciliation',
      );
    });
  });
});
