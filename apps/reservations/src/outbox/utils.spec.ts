import { Types } from 'mongoose';
import {
  buildClientKey,
  reservationConfirmedEvent,
  stripeIdempotencyKey,
} from './utils';

const HEX_ID = '66f1c2a9e4b0a1b2c3d4e5f6';

describe('deterministic keys', () => {
  // A retry after a crash only has the stored id, never the original object
  const sameId = () => new Types.ObjectId(HEX_ID);

  it('derives the same Stripe idempotency key for the same reservation id', () => {
    expect(stripeIdempotencyKey(sameId())).toBe(stripeIdempotencyKey(sameId()));
    expect(stripeIdempotencyKey(sameId())).toBe(`reservation-${HEX_ID}`);
  });

  it('derives different Stripe keys for different reservations', () => {
    expect(stripeIdempotencyKey(new Types.ObjectId())).not.toBe(
      stripeIdempotencyKey(sameId()),
    );
  });

  it('derives the same event id for the same reservation id', () => {
    const first = reservationConfirmedEvent(sameId(), 'a@example.com', 10);
    const second = reservationConfirmedEvent(sameId(), 'a@example.com', 10);

    expect(first.eventId).toBe(second.eventId);
    expect(first.publishedAt).toBeNull();
  });

  it('gives two users with the same Idempotency-Key header different client keys', () => {
    expect(buildClientKey('user-1', 'key-1')).not.toBe(
      buildClientKey('user-2', 'key-1'),
    );
  });

  it('gives the same user and header the same client key', () => {
    expect(buildClientKey('user-1', 'key-1')).toBe(
      buildClientKey('user-1', 'key-1'),
    );
  });
});
