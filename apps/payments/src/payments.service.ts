import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { ChargeFailure } from '@app/common/dto/charge-result.dto';
import { PaymentsCreateChargeDto } from './dto/payments-create-charge.dto';

// Only errors that prove Stripe did NOT charge may fail the reservation.
// Connection, api (5xx), idempotency conflict (a concurrent request with the
// same key), rate limit, auth — the charge may exist, so the result is unknown.
const toChargeFailure = (error: unknown): ChargeFailure => {
  if (error instanceof Stripe.errors.StripeCardError) {
    return { kind: 'declined', message: error.message };
  }

  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return { kind: 'rejected', message: error.message };
  }

  return { kind: 'unknown', message: 'Payment status unknown' };
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly stripe: Stripe;

  constructor(private readonly configService: ConfigService) {
    this.stripe = new Stripe(
      this.configService.getOrThrow('STRIPE_SECRET_KEY'),
      {
        apiVersion: '2026-08-26.dahlia',
      },
    );
  }

  async createCharge(charge: PaymentsCreateChargeDto) {
    const intent = await this.createPaymentIntent(charge);
    this.assertSucceeded(intent, charge.idempotencyKey);
    return intent;
  }

  private async createPaymentIntent({
    paymentMethodId,
    amount,
    email,
    idempotencyKey,
  }: PaymentsCreateChargeDto) {
    try {
      return await this.stripe.paymentIntents.create(
        {
          amount: Math.round(amount * 100),
          payment_method: paymentMethodId,
          payment_method_types: ['card'],
          currency: 'usd',
          confirm: true,
          // 3DS is not supported by this flow: fail as a card error instead
          // of returning an unpaid intent in `requires_action`
          error_on_requires_action: true,
          receipt_email: email, // stripe will send receipt to this email
        },
        { idempotencyKey },
      );
    } catch (error) {
      this.logger.error({ err: error, idempotencyKey }, 'charge failed');
      throw new RpcException(toChargeFailure(error));
    }
  }

  // `processing` and other non-final statuses mean the money is not settled yet
  private assertSucceeded(
    intent: Stripe.PaymentIntent,
    idempotencyKey: string,
  ) {
    if (intent.status === 'succeeded') return;

    this.logger.warn(
      { paymentIntentId: intent.id, status: intent.status, idempotencyKey },
      'charge not settled',
    );
    const failure: ChargeFailure = {
      kind: 'unknown',
      message: `Payment is ${intent.status}`,
    };
    throw new RpcException(failure);
  }
}
