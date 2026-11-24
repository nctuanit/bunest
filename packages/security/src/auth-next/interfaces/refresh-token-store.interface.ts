export interface RefreshTokenRecord {
  /** SHA-256 of the token. */
  id: string;
  /** Every rotation stays in the family of the original sign-in. */
  familyId: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  /** The family cannot be extended past this, however often it rotates. */
  familyExpiresAt: Date;
  usedAt?: Date;
  /** Claims set at sign-in (`amr`, `auth_time`, ...) carried across refreshes. */
  claims?: Record<string, unknown>;
}

/** Storage for refresh tokens with family revocation and single-use rotation. */
export interface RefreshTokenStore {
  getRefreshToken(id: string): Promise<RefreshTokenRecord | undefined>;
  saveRefreshToken(record: RefreshTokenRecord): Promise<void>;
  markRefreshTokenUsed(id: string, at: Date): Promise<boolean>;
  revokeRefreshTokenFamily(familyId: string): Promise<void>;
  isRefreshTokenFamilyRevoked(familyId: string): Promise<boolean>;
  revokeUserRefreshTokens(userId: string): Promise<void>;
}
