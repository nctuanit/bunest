export interface TotpRecord {
  /** Sealed secret (`v1.<keyId>....`, see `SecretCipher`); base32 plaintext only with `encryption: false`. */
  secret: string;
  /** `false` until the user proved the authenticator works. */
  confirmed: boolean;
  /** A replacement secret staged by `enroll(..., { replace: true })`. */
  pendingSecret?: string;
  /** Last accepted time step, for replay protection. */
  lastUsedStep?: number;
}

/** Second-factor storage: each user's authenticator, recovery code hashes, and failed attempts. */
export interface MfaStore {
  getTotp(userId: string): Promise<TotpRecord | undefined>;
  saveTotp(userId: string, record: TotpRecord | null): Promise<void>;
  claimTotpStep(userId: string, step: number): Promise<boolean>;
  saveRecoveryCodes(userId: string, hashes: string[]): Promise<void>;
  consumeRecoveryCode(userId: string, hash: string): Promise<boolean>;
  countRecoveryCodes(userId: string): Promise<number>;
  recordMfaFailure(
    userId: string,
    windowMs: number,
    now: number,
  ): Promise<number>;
  countMfaFailures(
    userId: string,
    windowMs: number,
    now: number,
  ): Promise<number>;
  clearMfaFailures(userId: string): Promise<void>;
}
