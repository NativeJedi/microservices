import { Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { OutboxEventDocument } from '../entities/reservation.entity';

export function reservationConfirmedEvent(
  reservationId: Types.ObjectId,
  email: string,
  amount: number,
): OutboxEventDocument {
  return {
    eventId: `reservation-confirmed-${reservationId.toHexString()}`, // deterministic
    pattern: 'notify_email',
    payload: {
      email,
      text: `Reservation confirmed. Payment of $${amount} received`,
    },
    publishedAt: null,
  };
}

export function stripeIdempotencyKey(reservationId: Types.ObjectId): string {
  return `reservation-${reservationId.toHexString()}`;
}

export function buildClientKey(userId: string, idempotencyKey: string): string {
  return createHash('sha256')
    .update(`${userId}:${idempotencyKey}`)
    .digest('hex');
}
