const DUPLICATE_KEY_ERROR_CODE = 11000;

export function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE
  );
}
