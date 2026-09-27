import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { UserDto } from '@app/common';
import { ReservationsService } from './reservations.service';
import { ReservationsRepository } from './reservations.repository';
import { PaymentsGateway } from './payments.gateway';
import { CreateReservationDto } from './dto/create-reservation.dto';
import {
  ReservationDocument,
  ReservationStatus,
} from './entities/reservation.entity';
import { reservationConfirmedEvent } from './outbox/utils';

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

const IDEMPOTENCY_KEY = 'key-1';

function buildReservation(
  overrides: Partial<ReservationDocument> = {},
): ReservationDocument {
  return {
    _id: new Types.ObjectId(),
    email: USER.email,
    amount: RESERVATION.charge.amount,
    paymentMethodId: RESERVATION.charge.paymentMethodId,
    status: 'pending',
    invoiceId: null,
    failureReason: null,
    outbox: [],
    ...overrides,
  } as ReservationDocument;
}

describe('ReservationsService', () => {
  let service: ReservationsService;
  let charge: jest.Mock;
  let repository: Record<
    | 'findOneOrNull'
    | 'create'
    | 'findOne'
    | 'findOneAndUpdateOrNull'
    | 'findOneAndDelete',
    jest.Mock
  >;
  let pending: ReservationDocument;

  beforeEach(async () => {
    pending = buildReservation();
    charge = jest.fn().mockResolvedValue('pi_123');
    repository = {
      findOneOrNull: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(pending),
      findOne: jest.fn(),
      findOneAndUpdateOrNull: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ ...pending, status: 'confirmed' }),
        ),
      findOneAndDelete: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReservationsService,
        { provide: ReservationsRepository, useValue: repository },
        { provide: PaymentsGateway, useValue: { charge } },
      ],
    }).compile();

    service = moduleRef.get(ReservationsService);
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  const create = () => service.create(RESERVATION, USER, IDEMPOTENCY_KEY);

  describe('successful charge', () => {
    it('stores the reservation as pending before charging', async () => {
      await create();

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER._id,
          email: USER.email,
          amount: 10,
          paymentMethodId: 'pm_card_visa',
          status: 'pending',
          invoiceId: null,
        }),
      );
      expect(repository.create.mock.invocationCallOrder[0]).toBeLessThan(
        charge.mock.invocationCallOrder[0],
      );
    });

    it('confirms with the invoice id and exactly one event in a single atomic update', async () => {
      await create();

      expect(repository.findOneAndUpdateOrNull).toHaveBeenCalledTimes(1);
      expect(repository.findOneAndUpdateOrNull).toHaveBeenCalledWith(
        { _id: pending._id, status: 'pending' },
        {
          $set: { status: 'confirmed', invoiceId: 'pi_123' },
          $push: {
            outbox: reservationConfirmedEvent(pending._id, USER.email, 10),
          },
        },
      );
    });

    it('returns the confirmed reservation', async () => {
      await expect(create()).resolves.toMatchObject({
        _id: pending._id,
        status: 'confirmed',
      });
    });

    it('treats a lost conditional update as "already confirmed", not an error', async () => {
      const confirmedElsewhere = { ...pending, status: 'confirmed' };
      repository.findOneAndUpdateOrNull.mockResolvedValue(null);
      repository.findOne.mockResolvedValue(confirmedElsewhere);

      await expect(create()).resolves.toBe(confirmedElsewhere);
      expect(repository.findOne).toHaveBeenCalledWith({ _id: pending._id });
    });
  });

  describe('unknown charge result', () => {
    beforeEach(() =>
      charge.mockRejectedValue({
        status: 'error',
        message: 'Internal server error',
      }),
    );

    it('answers 503', async () => {
      await expect(create()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('leaves the reservation pending for reconciliation', async () => {
      await create().catch(() => undefined);

      expect(repository.findOneAndUpdateOrNull).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['declined', 'Your card was declined.'],
    ['rejected', 'Amount must be at least $0.50 usd'],
  ])('%s charge', (kind, message) => {
    beforeEach(() => charge.mockRejectedValue({ kind, message }));

    it('answers 400 with the payment reason', async () => {
      const creating = create();

      await expect(creating).rejects.toBeInstanceOf(BadRequestException);
      await expect(creating).rejects.toThrow(message);
    });

    it('marks the pending reservation as failed with the reason', async () => {
      await create().catch(() => undefined);

      expect(repository.findOneAndUpdateOrNull).toHaveBeenCalledWith(
        { _id: pending._id, status: 'pending' },
        { $set: { status: 'failed', failureReason: message } },
      );
    });
  });

  describe('repeated idempotency key', () => {
    it.each<[ReservationStatus, unknown]>([
      ['pending', ConflictException],
      ['needs_review', ConflictException],
      ['failed', BadRequestException],
    ])('rejects an existing %s reservation', async (status, exception) => {
      repository.findOneOrNull.mockResolvedValue(buildReservation({ status }));

      await expect(create()).rejects.toBeInstanceOf(exception);
      expect(charge).not.toHaveBeenCalled();
    });

    it('returns an existing confirmed reservation without charging', async () => {
      const confirmed = buildReservation({ status: 'confirmed' });
      repository.findOneOrNull.mockResolvedValue(confirmed);

      await expect(create()).resolves.toBe(confirmed);
      expect(charge).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('does not charge when a parallel request won the insert', async () => {
      const confirmed = buildReservation({ status: 'confirmed' });
      repository.create.mockRejectedValue({ code: 11000 });
      repository.findOne.mockResolvedValue(confirmed);

      await expect(create()).resolves.toBe(confirmed);
      expect(charge).not.toHaveBeenCalled();
    });

    it('scopes the lookup by user and header', async () => {
      await create();
      await service.create(
        RESERVATION,
        { ...USER, _id: 'user-2' },
        IDEMPOTENCY_KEY,
      );

      const [[first], [second]] = repository.findOneOrNull.mock.calls as [
        [{ clientKey: string }],
        [{ clientKey: string }],
      ];
      expect(first.clientKey).not.toBe(second.clientKey);
    });
  });

  it('rethrows insert errors other than a duplicate key', async () => {
    const dbDown = new Error('connection refused');
    repository.create.mockRejectedValue(dbDown);

    await expect(create()).rejects.toBe(dbDown);
    expect(charge).not.toHaveBeenCalled();
  });

  it('never deletes a reservation whose payment may be in flight', async () => {
    await service.remove('id-1');

    expect(repository.findOneAndDelete).toHaveBeenCalledWith({
      _id: 'id-1',
      status: { $nin: ['pending', 'needs_review'] },
    });
  });
});
