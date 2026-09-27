import { Inject, Injectable } from '@nestjs/common';
import { PAYMENTS_SERVICE } from '@app/common';
import { ClientProxy } from '@nestjs/microservices';
import { ReservationDocument } from './entities/reservation.entity';
import { lastValueFrom } from 'rxjs';
import { ChargeResult } from '@app/common/dto/charge-result.dto';
import { stripeIdempotencyKey } from './outbox/utils';

@Injectable()
export class PaymentsGateway {
  constructor(@Inject(PAYMENTS_SERVICE) private readonly client: ClientProxy) {}

  async charge(reservation: ReservationDocument): Promise<string> {
    const result = await lastValueFrom(
      this.client.send<ChargeResult>('create_charge', {
        amount: reservation.amount,
        paymentMethodId: reservation.paymentMethodId,
        email: reservation.email,
        idempotencyKey: stripeIdempotencyKey(reservation._id),
      }),
    );
    return result.id;
  }
}
