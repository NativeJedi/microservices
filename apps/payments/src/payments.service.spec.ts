import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import Stripe from 'stripe';
import { PaymentsService } from './payments.service';
import { PaymentsCreateChargeDto } from './dto/payments-create-charge.dto';

const CHARGE: PaymentsCreateChargeDto = {
  paymentMethodId: 'pm_card_visa',
  amount: 10,
  email: 'user@example.com',
  idempotencyKey: 'reservation-66f1c2a9e4b0a1b2c3d4e5f6',
};

const SUCCEEDED_INTENT = { id: 'pi_123', status: 'succeeded' };

async function getRpcError(charging: Promise<unknown>): Promise<unknown> {
  const error: unknown = await charging.catch((err: unknown) => err);
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError();
}

describe('PaymentsService', () => {
  let service: PaymentsService;
  let createPaymentIntent: jest.SpyInstance;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: ConfigService, useValue: { getOrThrow: () => 'sk_test' } },
      ],
    }).compile();

    service = moduleRef.get(PaymentsService);
    createPaymentIntent = jest
      .spyOn(service['stripe'].paymentIntents, 'create')
      .mockResolvedValue(SUCCEEDED_INTENT as never);
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
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
      await expect(service.createCharge(CHARGE)).resolves.toEqual(
        SUCCEEDED_INTENT,
      );
    });

    it('asks Stripe to fail instead of waiting for 3DS', async () => {
      await service.createCharge(CHARGE);

      expect(createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          confirm: true,
          error_on_requires_action: true,
        }),
        expect.any(Object),
      );
    });
  });

  describe('unsettled payment intent', () => {
    it.each(['processing', 'requires_action', 'requires_payment_method'])(
      'reports status %s as unknown instead of success',
      async (status) => {
        createPaymentIntent.mockResolvedValue({ id: 'pi_123', status });

        await expect(
          getRpcError(service.createCharge(CHARGE)),
        ).resolves.toEqual({
          kind: 'unknown',
          message: `Payment is ${status}`,
        });
      },
    );
  });

  describe('failed charge', () => {
    it('exposes a card error as declined with the Stripe message', async () => {
      createPaymentIntent.mockRejectedValue(
        new Stripe.errors.StripeCardError({
          message: 'Your card was declined.',
          type: 'card_error',
        }),
      );

      await expect(getRpcError(service.createCharge(CHARGE))).resolves.toEqual({
        kind: 'declined',
        message: 'Your card was declined.',
      });
    });

    it('exposes an invalid request as rejected', async () => {
      createPaymentIntent.mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message: 'Amount must be at least $0.50 usd',
          type: 'invalid_request_error',
        }),
      );

      await expect(getRpcError(service.createCharge(CHARGE))).resolves.toEqual({
        kind: 'rejected',
        message: 'Amount must be at least $0.50 usd',
      });
    });

    // Stripe may have charged the card for any of these
    it.each([
      [
        'connection error',
        new Stripe.errors.StripeConnectionError({
          message: 'socket hang up',
          type: 'api_error',
        }),
      ],
      [
        'Stripe 5xx',
        new Stripe.errors.StripeAPIError({
          message: 'Internal error',
          type: 'api_error',
        }),
      ],
      [
        'concurrent request with the same key',
        new Stripe.errors.StripeIdempotencyError({
          message: 'Request in progress',
          type: 'idempotency_error',
        }),
      ],
      ['non-Stripe error', new Error('ECONNRESET')],
    ])('reports a %s as unknown', async (_case, error) => {
      createPaymentIntent.mockRejectedValue(error);

      await expect(getRpcError(service.createCharge(CHARGE))).resolves.toEqual({
        kind: 'unknown',
        message: 'Payment status unknown',
      });
    });
  });
});
