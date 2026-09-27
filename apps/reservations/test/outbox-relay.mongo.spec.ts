import { defer, map, throwError, timer } from 'rxjs';
import {
  MONGO_STARTUP_TIMEOUT_MS,
  MongoTestApp,
  buildEvent,
  minutesAgo,
} from './mongo-test-app';

describe('OutboxRelay (in-memory Mongo)', () => {
  const app = new MongoTestApp();

  beforeAll(() => app.start(), MONGO_STARTUP_TIMEOUT_MS);
  afterAll(() => app.stop());
  beforeEach(() => app.reset());

  const seedConfirmed = (outbox = [buildEvent('a')]) =>
    app.seed({ status: 'confirmed', invoiceId: 'pi_1', outbox });

  it('publishes an unpublished event with its event id', async () => {
    await seedConfirmed([buildEvent('a')]);

    await app.relay.publishPending();

    expect(app.emit).toHaveBeenCalledTimes(1);
    expect(app.emit).toHaveBeenCalledWith('notify_email', {
      email: 'user@example.com',
      text: 'text a',
      eventId: 'event-a',
    });
  });

  it('marks exactly the published array element', async () => {
    const earlier = new Date('2026-09-01T00:00:00Z');
    const reservation = await seedConfirmed([
      buildEvent('old', earlier),
      buildEvent('new'),
    ]);

    await app.relay.publishPending();

    const [old, fresh] = (await app.read(reservation._id)).outbox;
    expect(app.emit).toHaveBeenCalledTimes(1);
    expect(old.publishedAt).toEqual(earlier);
    expect(fresh.publishedAt).toBeInstanceOf(Date);
  });

  it('releases its lock after publishing', async () => {
    const reservation = await seedConfirmed();

    await app.relay.publishPending();

    expect((await app.read(reservation._id)).lockedUntil).toBeNull();
  });

  describe('failed publish', () => {
    beforeEach(() =>
      app.emit.mockReturnValueOnce(throwError(() => new Error('broker down'))),
    );

    it('leaves publishedAt empty and keeps the lock as a backoff', async () => {
      const reservation = await seedConfirmed();

      await app.relay.publishPending();

      const stored = await app.read(reservation._id);
      expect(app.emit).toHaveBeenCalledTimes(1);
      expect(stored.outbox[0].publishedAt).toBeNull();
      expect(stored.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    });

    it('publishes on the next pass once the lock expires', async () => {
      const reservation = await seedConfirmed();

      await app.relay.publishPending();
      await app.expireLocks();
      await app.relay.publishPending();

      expect(app.emit).toHaveBeenCalledTimes(2);
      const [event] = (await app.read(reservation._id)).outbox;
      expect(event.publishedAt).toBeInstanceOf(Date);
    });
  });

  it('lets only one of two parallel instances publish a document', async () => {
    app.emit.mockReturnValue(timer(50).pipe(map(() => undefined)));
    await seedConfirmed();

    await Promise.all([
      app.relay.publishPending(),
      app.newRelayInstance().publishPending(),
    ]);

    expect(app.emit).toHaveBeenCalledTimes(1);
  });

  it('does not release a lock taken by another instance after its own expired', async () => {
    const reservation = await seedConfirmed();
    // Distinct from our own lock (now + 30s TTL)
    const foreignLock = new Date(Date.now() + 45_000);
    // Publishing took longer than the TTL and another instance claimed the document
    app.emit.mockReturnValue(
      defer(() =>
        app.model.updateOne(
          { _id: reservation._id },
          { $set: { lockedUntil: foreignLock } },
        ),
      ).pipe(map(() => undefined)),
    );

    await app.relay.publishPending();

    expect((await app.read(reservation._id)).lockedUntil).toEqual(foreignLock);
  });

  it('skips a document without an outbox field and keeps running', async () => {
    const legacyId = await app.seedRaw({
      status: 'confirmed',
      timestamp: minutesAgo(10),
      clientKey: 'legacy',
    });
    await seedConfirmed();

    await app.relay.publishPending();

    expect(app.emit).toHaveBeenCalledTimes(1);
    expect(app.deleteInterval).not.toHaveBeenCalled();
    const legacy = await app.read(legacyId);
    expect(legacy.outbox).toBeUndefined();
    expect(legacy.lockedUntil).toBeUndefined();
  });
});
