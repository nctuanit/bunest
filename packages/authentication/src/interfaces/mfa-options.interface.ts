import type { Duration } from "./duration.interface";

export interface SecretEncryptionOptions {
  /** AES-256-GCM keys: 32-byte `Buffer`s, or strings of at least 32 characters. Newest key first. */
  keys: (string | Buffer)[];
  /** Accept stored plaintext values and re-encrypt them on next successful verification. */
  migratePlaintext?: boolean;
}

export interface MfaOptions {
  /** Encryption of TOTP secrets at rest (AES-256-GCM): `{ keys: [key] }`, or `false` for deliberate plaintext. */
  encryption: SecretEncryptionOptions | false;
  /** Shown in authenticator apps. */
  issuer?: string;
  /** Accepted 30-second steps either side of now (0..10). Default 1. */
  window?: number;
  /** Failed codes allowed per `lockoutWindow` (>= 1). Default 5. */
  maxAttempts?: number;
  /** Default `'15m'`. */
  lockoutWindow?: Duration;
  /** Recovery codes per batch (>= 1). Default 10. */
  recoveryCodes?: number;
  /** How long a `mfa: 'pending'` session may wait before expiring. Default `'10m'`. */
  pendingTtl?: Duration;
  /** Clock in epoch milliseconds, for tests. */
  now?: () => number;
}
