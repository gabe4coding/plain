export function checkSpecTimeoutFlag(value?: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('--spec-timeout must be a positive safe integer');
}
