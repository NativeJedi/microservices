import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import Stripe from 'stripe';
import { NOTIFICATIONS_SERVICE } from '@app/common';
import { PaymentsService } from './payments.service';
import { PaymentsCreateChargeDto } from './dto/payments-create-charge.dto';

const CHARGE: PaymentsCreateChargeDto = {
  paymentMethodId: 'pm_card_visa',
  amount: 10,
  email: 'user@example.com',
  idempotencyKey: 'reservation-66f1c2a9e4b0a1b2c3d4e5f6',
};

describe('PaymentsService', () => {
  let service: PaymentsService;
  let createPaymentIntent: jest.SpyInstance;
  let emit: jest.Mock;

  beforeEach(async () => {
    emit = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: ConfigService, useValue: { getOrThrow: () => 'sk_test' } },
        { provide: NOTIFICATIONS_SERVICE, useValue: { emit } },
      ],
    }).compile();

    service = moduleRef.get(PaymentsService);
    createPaymentIntent = jest
      .spyOn(service['stripe'].paymentIntents, 'create')
      .mockResolvedValue({ id: 'pi_123' } as never);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('idempotency', () => {
    it('forwards the idempotency key to Stripe as a request option', async () => {
      await service.createCharge(CHARGE);

      expect(createPaymentIntent).toHaveBeenCalledWith(expect.any(Object), {
        idempotencyKey: CHARGE.idempotencyKey,
      });
    });
  });

  describe('amount', () => {
    it.each([
      [10, 1000],
      [19.99, 1999],
      [0.29, 29],
    ])('charges %p dollars as %p integer cents', async (amount, cents) => {
      await service.createCharge({ ...CHARGE, amount });

      expect(createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ amount: cents, currency: 'usd' }),
        expect.any(Object),
      );
    });
  });

  describe('successful charge', () => {
    it('returns the payment intent', async () => {
      await expect(service.createCharge(CHARGE)).resolves.toEqual({
        id: 'pi_123',
      });
    });

    it('emits an email notification', async () => {
      await service.createCharge(CHARGE);

      expect(emit).toHaveBeenCalledWith('notify_email', {
        email: CHARGE.email,
        text: 'Payment of $10 received',
      });
    });
  });

  describe('failed charge', () => {
    it('exposes the Stripe error message as an RPC error', async () => {
      const declined = new Stripe.errors.StripeCardError({
        message: 'Your card was declined.',
        type: 'card_error',
      });
      createPaymentIntent.mockRejectedValue(declined);

      const charging = service.createCharge(CHARGE);

      await expect(charging).rejects.toBeInstanceOf(RpcException);
      await expect(charging).rejects.toThrow('Your card was declined.');
    });

    it('hides non-Stripe errors behind a generic message', async () => {
      createPaymentIntent.mockRejectedValue(new Error('ECONNRESET'));

      await expect(service.createCharge(CHARGE)).rejects.toThrow(
        'Payment provider is unavailable',
      );
    });

    it('does not send a notification', async () => {
      createPaymentIntent.mockRejectedValue(new Error('ECONNRESET'));

      await service.createCharge(CHARGE).catch(() => undefined);

      expect(emit).not.toHaveBeenCalled();
    });
  });
});
