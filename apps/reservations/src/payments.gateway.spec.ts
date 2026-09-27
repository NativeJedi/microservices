import { Types } from 'mongoose';
import { NEVER, of } from 'rxjs';
import { PaymentsGateway, CHARGE_TIMEOUT_MS } from './payments.gateway';
import { ReservationDocument } from './entities/reservation.entity';

const RESERVATION = {
  _id: new Types.ObjectId('66f1c2a9e4b0a1b2c3d4e5f6'),
  amount: 10,
  paymentMethodId: 'pm_card_visa',
  email: 'user@example.com',
} as ReservationDocument;

describe('PaymentsGateway', () => {
  let send: jest.Mock;
  let gateway: PaymentsGateway;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(of({ id: 'pi_123' }));
    gateway = new PaymentsGateway({ send } as never);
  });

  afterEach(() => jest.useRealTimers());

  it('sends the stored charge data with an idempotency key derived from the reservation id', async () => {
    await gateway.charge(RESERVATION);

    expect(send).toHaveBeenCalledWith('create_charge', {
      amount: 10,
      paymentMethodId: 'pm_card_visa',
      email: 'user@example.com',
      idempotencyKey: 'reservation-66f1c2a9e4b0a1b2c3d4e5f6',
    });
  });

  it('returns the payment intent id as the invoice id', async () => {
    await expect(gateway.charge(RESERVATION)).resolves.toBe('pi_123');
  });

  it('fails instead of hanging when payments never answers', async () => {
    jest.useFakeTimers();
    send.mockReturnValue(NEVER);

    const charging = gateway.charge(RESERVATION);
    jest.advanceTimersByTime(CHARGE_TIMEOUT_MS);

    await expect(charging).rejects.toThrow('Timeout has occurred');
  });
});
