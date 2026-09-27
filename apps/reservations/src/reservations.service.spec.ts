import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import { PAYMENTS_SERVICE, UserDto } from '@app/common';
import { ReservationsService } from './reservations.service';
import { ReservationsRepository } from './reservations.repository';
import { CreateReservationDto } from './dto/create-reservation.dto';

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

describe('ReservationsService', () => {
  let service: ReservationsService;
  let send: jest.Mock;
  let createReservation: jest.Mock;

  beforeEach(async () => {
    send = jest.fn().mockReturnValue(of({ id: 'pi_123' }));
    createReservation = jest.fn().mockImplementation((doc: object) => doc);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReservationsService,
        {
          provide: ReservationsRepository,
          useValue: { create: createReservation },
        },
        { provide: PAYMENTS_SERVICE, useValue: { send } },
      ],
    }).compile();

    service = moduleRef.get(ReservationsService);
  });

  function getSentCharge(): Record<string, unknown> {
    const [, charge] = send.mock.calls[0] as [string, Record<string, unknown>];
    return charge;
  }

  describe('create', () => {
    it('sends the charge with the user email and an idempotency key', async () => {
      await service.create(RESERVATION, USER);

      expect(send).toHaveBeenCalledWith('create_charge', {
        ...RESERVATION.charge,
        email: USER.email,
        idempotencyKey: expect.any(String) as string,
      });
    });

    it('derives the idempotency key from a new ObjectId', async () => {
      await service.create(RESERVATION, USER);

      expect(getSentCharge().idempotencyKey).toMatch(
        /^reservation-[0-9a-f]{24}$/,
      );
    });

    it('stores the payment intent id as the invoice id', async () => {
      await service.create(RESERVATION, USER);

      expect(createReservation).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER._id, invoiceId: 'pi_123' }),
      );
    });

    it('maps a payment failure to BadRequest and does not save the reservation', async () => {
      send.mockReturnValue(
        throwError(() => ({ message: 'Your card was declined.' })),
      );

      const creating = service.create(RESERVATION, USER);

      await expect(creating).rejects.toBeInstanceOf(BadRequestException);
      await expect(creating).rejects.toThrow('Your card was declined.');
      expect(createReservation).not.toHaveBeenCalled();
    });
  });
});
