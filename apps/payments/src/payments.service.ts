import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { CreateChargeDto } from '@app/common';

const toChargeFailureMessage = (error: unknown): string =>
  error instanceof Stripe.errors.StripeError
    ? error.message
    : 'Payment provider is unavailable';

@Injectable()
export class PaymentsService {
  private readonly stripe: Stripe;

  constructor(private readonly configService: ConfigService) {
    this.stripe = new Stripe(
      this.configService.getOrThrow('STRIPE_SECRET_KEY'),
      {
        apiVersion: '2026-08-26.dahlia',
      },
    );
  }

  async createCharge({ paymentMethodId, amount }: CreateChargeDto) {
    try {
      return await this.stripe.paymentIntents.create({
        amount: amount * 100,
        payment_method: paymentMethodId,
        payment_method_types: ['card'],
        currency: 'usd',
        confirm: true,
      });
    } catch (error) {
      throw new RpcException(toChargeFailureMessage(error));
    }
  }
}
