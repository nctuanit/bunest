/**
 * What gets persisted for a completed request and replayed for every retry
 * carrying the same key. Everything in it is JSON-safe, so a network store
 * (Redis, Postgres) can serialize it with `JSON.stringify` as-is.
 */
export interface IdempotencyStoredResponse {
  /**
   * HTTP status (after `@HttpCode`, `@Redirect`, `res.status()`). For
   * GraphQL and RPC results it is the HTTP-equivalent status (200 on success).
   */
  status: number;
  /** Allowlisted response headers, lower-cased names. HTTP only. */
  headers: Record<string, string | string[]>;
  /**
   * The handler's result, or the error payload. JSON-safe: Dates, BigInts,
   * Buffers, Maps and Sets are tagged (`{ "__idempotencyType": "Date", ... }`)
   * so a replay restores them, and everything else is kept the way
   * `JSON.stringify` would keep it.
   */
  body: unknown;
  /**
   * Set when the stored outcome is an error to re-throw on replay, naming
   * which exception type to rebuild: `HttpException`, `RpcException` or
   * `GraphQLError`.
   */
  error?: "http" | "rpc" | "graphql";
}

/**
 * An `IdempotencyStoredResponse` encrypted with `encryption.keys`
 * (AES-256-GCM). The format is `v1.<keyId>.<iv>.<ciphertext>.<tag>`
 * (base64url segments).
 */
export interface IdempotencySealedResponse {
  sealed: string;
}

/**
 * What a store persists: plaintext, or sealed when encryption is enabled.
 * Stores never look inside it.
 */
export type IdempotencyStoredPayload =
  IdempotencyStoredResponse | IdempotencySealedResponse;

/** What `IdempotencyStore#acquire()` found: nothing (the lock is now the caller's), a lock, or a record. */
export type IdempotencyAcquireResult =
  | {
      state: "acquired";
    }
  | {
      state: "in-flight";
      fingerprint: string;
    }
  | {
      state: "completed";
      fingerprint: string;
      response: IdempotencyStoredPayload;
    };

/**
 * Where idempotency records live: the contract a store implements.
 * Write it as a singleton provider that injects `IdempotencyStorage`
 * and calls `storage.registerSource(this)` in its constructor.
 */
export interface IdempotencyStore {
  /**
   * Atomically takes the lock on `key` for `owner`, expiring `lockTtl` ms from
   * now, if no live lock or record exists. Otherwise returns `{ state: 'in-flight', fingerprint }`
   * or `{ state: 'completed', fingerprint, response }`.
   */
  acquire(
    key: string,
    owner: string,
    fingerprint: string,
    lockTtl: number,
  ): Promise<IdempotencyAcquireResult>;

  /**
   * Compare-and-set: turns `owner`'s live lock into a completed record expiring
   * `ttl` ms from now. Resolves `true` on success, `false` otherwise.
   */
  complete(
    key: string,
    owner: string,
    response: IdempotencyStoredPayload,
    ttl: number,
  ): Promise<boolean>;

  /**
   * Compare-and-set: deletes `owner`'s live lock. Resolves `true` on success,
   * `false` if `owner` no longer holds a live lock.
   */
  release(key: string, owner: string): Promise<boolean>;

  /**
   * Compare-and-set heartbeat: extends `owner`'s live lock to expire `lockTtl` ms
   * from now. Resolves `true` on success, `false` otherwise.
   */
  extend(key: string, owner: string, lockTtl: number): Promise<boolean>;
}
