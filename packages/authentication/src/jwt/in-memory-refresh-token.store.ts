import { Injectable } from "@bunest/common";
import type {
  RefreshTokenRecord,
  RefreshTokenStore,
} from "../interfaces/refresh-token-store.interface";

/**
 * Process-local refresh token store: default when no source is registered, and test double.
 */
@Injectable()
export class InMemoryRefreshTokenStore implements RefreshTokenStore {
  private readonly tokens = new Map<string, RefreshTokenRecord>();
  private readonly revoked = new Set<string>();
  private sweepAt = 1_024;

  async getRefreshToken(id: string): Promise<RefreshTokenRecord | undefined> {
    const record = this.tokens.get(id);
    return record ? { ...record } : undefined;
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    this.tokens.set(record.id, { ...record });
    if (this.tokens.size >= this.sweepAt) {
      this.sweep(record.createdAt.getTime());
    }
  }

  async markRefreshTokenUsed(id: string, at: Date): Promise<boolean> {
    const record = this.tokens.get(id);
    if (!record || record.usedAt) {
      return false;
    }
    record.usedAt = at;
    return true;
  }

  async revokeRefreshTokenFamily(familyId: string): Promise<void> {
    this.revoked.add(familyId);
  }

  async isRefreshTokenFamilyRevoked(familyId: string): Promise<boolean> {
    return this.revoked.has(familyId);
  }

  async revokeUserRefreshTokens(userId: string): Promise<void> {
    for (const record of this.tokens.values()) {
      if (record.userId === userId) {
        this.revoked.add(record.familyId);
      }
    }
  }

  private sweep(now: number): void {
    for (const [id, record] of this.tokens) {
      if (record.familyExpiresAt.getTime() > now) {
        continue;
      }
      this.tokens.delete(id);
      this.revoked.delete(record.familyId);
    }
    this.sweepAt = Math.max(1_024, this.tokens.size * 2);
  }
}
