/** What `LockStore#acquire()` resolves: the lock and its fencing token, or nothing. */
export type LockAcquireResult =
  | {
      acquired: true;
      fencingToken: number;
    }
  | {
      acquired: false;
    };

/**
 * Where locks live: the contract a store implements. The package owns the rules;
 * the store owns data access. Write it as an ordinary provider that injects whatever it
 * needs and registers itself with `LocksStorage` in its constructor.
 */
export interface LockStore {
  /**
   * Takes `key` for `owner`, expiring `ttl` ms from now, if no live lock holds it (none, a
   * released one, or an expired one), and resolves `{ acquired: true, fencingToken }` with a
   * token greater than every token returned for `key` before. Otherwise it changes nothing
   * and resolves `{ acquired: false }`, also when `owner` itself holds the lock.
   */
  acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult>;
  /**
   * Heartbeat: sets `owner`'s live lock on `key` to expire `ttl` ms from now. Resolves
   * `true` when it did, and `false`, changing nothing, when `owner` doesn't hold a live lock
   * on `key`.
   */
  renew(key: string, owner: string, ttl: number): Promise<boolean>;
  /**
   * Frees `owner`'s live lock on `key`, so another caller can take it at once. Resolves
   * `true` when it did, `false` (changing nothing) when `owner` doesn't hold a live lock
   * on `key`. It must not reset the key's fencing counter.
   */
  release(key: string, owner: string): Promise<boolean>;
}
