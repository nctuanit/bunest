/**
 * A store call that didn't answer within `storeTimeout`. The call may still
 * land in the store later; a lock it took expires after `lockTtl`.
 */
export class IdempotencyStoreTimeoutError extends Error {
  readonly method: string;
  readonly timeout: number;

  constructor(method: string, timeout: number) {
    super(
      `IdempotencyStore.${method}() did not answer within ${timeout} ms (storeTimeout)`,
    );
    this.method = method;
    this.timeout = timeout;
    this.name = "IdempotencyStoreTimeoutError";
  }
}
