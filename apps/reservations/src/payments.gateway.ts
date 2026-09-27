import { Inject, Injectable } from '@nestjs/common';
import { PAYMENTS_SERVICE } from '@app/common';
import { ClientProxy } from '@nestjs/microservices';
import { ReservationDocument } from './entities/reservation.entity';
import { lastValueFrom, timeout } from 'rxjs';
import { ChargeResult } from '@app/common/dto/charge-result.dto';
import { stripeIdempotencyKey } from './outbox/utils';

// Must stay below the reconciliation lock TTL and stale threshold, otherwise
// reconciliation can start a second, concurrent charge for the same reservation.
export const CHARGE_TIMEOUT_MS = 30_000;

@Injectable()
export class PaymentsGateway {
  constructor(@Inject(PAYMENTS_SERVICE) private readonly client: ClientProxy) {}

  async charge(reservation: ReservationDocument): Promise<string> {
    const result = await lastValueFrom(
      this.client
        .send<ChargeResult>('create_charge', {
          amount: reservation.amount,
          paymentMethodId: reservation.paymentMethodId,
          email: reservation.email,
          idempotencyKey: stripeIdempotencyKey(reservation._id),
        })
        .pipe(timeout(CHARGE_TIMEOUT_MS)),
    );
    return result.id;
  }
}
