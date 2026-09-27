import { ConflictException, NotFoundException } from '@nestjs/common';
import { UserDto } from '@app/common';
import { CreateReservationDto } from '../src/dto/create-reservation.dto';
import {
  MONGO_STARTUP_TIMEOUT_MS,
  MongoTestApp,
  sleep,
} from './mongo-test-app';

const USER: UserDto = {
  _id: 'user-1',
  email: 'user@example.com',
  password: 'hash',
};

const RESERVATION: CreateReservationDto = {
  startDate: new Date('2026-10-01'),
  endDate: new Date('2026-10-05'),
  charge: { paymentMethodId: 'pm_card_visa', amount: 10 },
};

describe('ReservationsService.create (in-memory Mongo)', () => {
  const app = new MongoTestApp();

  beforeAll(() => app.start(), MONGO_STARTUP_TIMEOUT_MS);
  afterAll(() => app.stop());
  beforeEach(() => app.reset());

  const create = (idempotencyKey = 'key-1') =>
    app.service.create(RESERVATION, USER, idempotencyKey);

  it('creates one reservation and one charge for two parallel requests with the same key', async () => {
    app.charge.mockImplementation(async () => {
      await sleep(50);
      return 'pi_1';
    });

    const results = await Promise.allSettled([create(), create()]);

    expect(app.charge).toHaveBeenCalledTimes(1);
    expect(await app.model.countDocuments()).toBe(1);
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ConflictException);
  });

  it('returns the same reservation for a retry after success without charging again', async () => {
    const first = await create();
    const retry = await create();

    expect(retry._id.equals(first._id)).toBe(true);
    expect(retry.status).toBe('confirmed');
    expect(app.charge).toHaveBeenCalledTimes(1);
  });

  it('charges again for a different key', async () => {
    await create('key-1');
    await create('key-2');

    expect(app.charge).toHaveBeenCalledTimes(2);
    expect(await app.model.countDocuments()).toBe(2);
  });

  it('keeps a pending reservation when the charge result is unknown', async () => {
    app.charge.mockRejectedValue(new Error('Connection closed'));

    await expect(create()).rejects.toThrow();

    const [stored] = await app.model.find().lean();
    expect(stored).toMatchObject({ status: 'pending', invoiceId: null });
  });

  describe('remove', () => {
    it('refuses to delete a reservation whose payment may be in flight', async () => {
      const pending = await app.seed({ status: 'pending' });

      await expect(
        app.service.remove(pending._id.toHexString()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await app.model.countDocuments()).toBe(1);
    });

    it('deletes a failed reservation', async () => {
      const failed = await app.seed({ status: 'failed' });

      await app.service.remove(failed._id.toHexString());

      expect(await app.model.countDocuments()).toBe(0);
    });
  });
});
