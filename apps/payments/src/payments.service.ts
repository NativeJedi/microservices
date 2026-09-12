import { Inject, Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { NOTIFICATIONS_SERVICE } from '@app/common';
import { PaymentsCreateChargeDto } from './dto/payments-create-charge.dto';

const toChargeFailureMessage = (error: unknown): string =>
  error instanceof Stripe.errors.StripeError
    ? error.message
    : 'Payment provider is unavailable';

@Injectable()
export class PaymentsService {
  private readonly stripe: Stripe;

  constructor(
    private readonly configService: ConfigService,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsService: ClientProxy,
  ) {
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
  }: PaymentsCreateChargeDto) {
    try {
      const response = await this.stripe.paymentIntents.create({
        amount: amount * 100,
        payment_method: paymentMethodId,
        payment_method_types: ['card'],
        currency: 'usd',
        confirm: true,
      });

      this.notificationsService.emit('notify_email', {
        email,
        text: `Payment of $${amount * 100} received`,
      });

      return response;
    } catch (error) {
      throw new RpcException(toChargeFailureMessage(error));
    }
  }
}
