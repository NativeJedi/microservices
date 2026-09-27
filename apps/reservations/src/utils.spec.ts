import { toChargeFailure } from './utils';

describe('toChargeFailure', () => {
  it.each([
    ['a string', 'boom'],
    ['undefined', undefined],
    ['null', null],
    [
      'an unknown RPC error',
      { status: 'error', message: 'Internal server error' },
    ],
    ['an object with an unknown kind', { kind: 'bogus', message: 'x' }],
  ])('treats %s as unknown', (_case, error) => {
    expect(toChargeFailure(error)).toEqual({
      kind: 'unknown',
      message: 'Payment service unavailable',
    });
  });

  it('treats a plain Error (timeout, connection closed) as unknown and keeps its message', () => {
    expect(toChargeFailure(new Error('Connection closed'))).toEqual({
      kind: 'unknown',
      message: 'Connection closed',
    });
  });

  // Errors cross the TCP transport as plain objects, so instanceof cannot work
  it.each(['declined', 'rejected', 'unknown'] as const)(
    'passes through a serialized %s failure',
    (kind) => {
      const serialized = JSON.parse(
        JSON.stringify({ kind, message: 'reason' }),
      ) as unknown;

      expect(toChargeFailure(serialized)).toEqual({ kind, message: 'reason' });
    },
  );
});
