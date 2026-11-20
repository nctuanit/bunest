import { LocksError } from "./locks.error";

/**
 * A store call didn't answer within `storeTimeout` (a saturated pool, a failover, a client
 * queueing commands offline). The call may still land in the store: a lock `acquire()` takes
 * after this is given back, and one a renewal or release left behind expires after its `ttl`.
 */
export class LockStoreTimeoutError extends LocksError {
  readonly key: string;
  readonly method: "acquire" | "renew" | "release";
  /** The `storeTimeout`, in ms. */
  readonly timeoutMs: number;
  override name = "LockStoreTimeoutError";

  constructor(
    key: string,
    method: "acquire" | "renew" | "release",
    timeoutMs: number,
    store: string,
  ) {
    super(
      `${store}.${method}() for the lock "${key}" did not answer within ${timeoutMs}ms (storeTimeout)`,
    );
    this.key = key;
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}
