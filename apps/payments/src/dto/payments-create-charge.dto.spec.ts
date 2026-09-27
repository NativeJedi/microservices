import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaymentsCreateChargeDto } from './payments-create-charge.dto';

const VALID_CHARGE = {
  paymentMethodId: 'pm_card_visa',
  amount: 10,
  email: 'user@example.com',
  idempotencyKey: 'reservation-66f1c2a9e4b0a1b2c3d4e5f6',
};

async function getFailedConstraints(payload: object) {
  const errors = await validate(
    plainToInstance(PaymentsCreateChargeDto, payload),
  );
  return errors.flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe('PaymentsCreateChargeDto', () => {
  it('accepts a charge with an idempotency key', async () => {
    expect(await getFailedConstraints(VALID_CHARGE)).toEqual([]);
  });

  it.each([
    ['missing', undefined, 'isNotEmpty'],
    ['empty', '', 'isNotEmpty'],
    ['not a string', 123, 'isString'],
  ])(
    'rejects an idempotency key that is %s',
    async (_case, idempotencyKey, constraint) => {
      const failed = await getFailedConstraints({
        ...VALID_CHARGE,
        idempotencyKey,
      });

      expect(failed).toContain(constraint);
    },
  );
});
