import { ChargeFailure } from '@app/common/dto/charge-result.dto';

const KINDS: ChargeFailure['kind'][] = ['declined', 'rejected', 'unknown'];

export function isChargeFailure(value: unknown): value is ChargeFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    KINDS.includes((value as ChargeFailure).kind)
  );
}

export function toChargeFailure(error: unknown): ChargeFailure {
  if (isChargeFailure(error)) return error;

  return {
    kind: 'unknown',
    message:
      error instanceof Error ? error.message : 'Payment service unavailable',
  };
}
