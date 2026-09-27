import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { NOTIFICATIONS_SERVICE } from '@app/common';
import { PaymentsCreateChargeDto } from './dto/payments-create-charge.dto';

const toChargeFailure = (error: unknown) => {
  if (error instanceof Stripe.errors.StripeCardError) {
    return { kind: 'declined' as const, message: error.message };
  }

  if (error instanceof Stripe.errors.StripeError) {
    // invalid_request, api_error, etc
    return { kind: 'rejected' as const, message: error.message };
  }

  // network, timeout, etc
  return { kind: 'unknown' as const, message: 'Payment status unknown' };
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

  async createCharge({
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
          receipt_email: email, // stripe will send receipt to this email
        },
        { idempotencyKey },
      );
    } catch (error) {
      this.logger.error({ err: error, idempotencyKey }, 'charge failed');
      throw new RpcException(toChargeFailure(error));
    }
  }
}
