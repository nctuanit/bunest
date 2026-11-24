import { Injectable } from "@bunest/core";
import type { MfaStore, TotpRecord } from "../interfaces/mfa-store.interface";

/**
 * Process-local MFA store: default when no source is registered, and test double.
 */
@Injectable()
export class InMemoryMfaStore implements MfaStore {
  private readonly totp = new Map<string, TotpRecord>();
  private readonly codes = new Map<string, Set<string>>();
  private readonly failuresAt = new Map<string, number[]>();

  async getTotp(userId: string): Promise<TotpRecord | undefined> {
    const record = this.totp.get(userId);
    return record ? { ...record } : undefined;
  }

  async saveTotp(userId: string, record: TotpRecord | null): Promise<void> {
    if (!record) {
      this.totp.delete(userId);
      return;
    }
    const claimed = this.totp.get(userId)?.lastUsedStep;
    const lastUsedStep = Math.max(
      claimed ?? -Infinity,
      record.lastUsedStep ?? -Infinity,
    );
    const { lastUsedStep: _, ...rest } = record;
    this.totp.set(userId, {
      ...rest,
      ...(Number.isFinite(lastUsedStep) ? { lastUsedStep } : {}),
    });
  }

  async claimTotpStep(userId: string, step: number): Promise<boolean> {
    const record = this.totp.get(userId);
    if (
      !record ||
      (record.lastUsedStep !== undefined && step <= record.lastUsedStep)
    ) {
      return false;
    }
    record.lastUsedStep = step;
    return true;
  }

  async saveRecoveryCodes(userId: string, hashes: string[]): Promise<void> {
    if (hashes.length === 0) {
      this.codes.delete(userId);
    } else {
      this.codes.set(userId, new Set(hashes));
    }
  }

  async consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
    return this.codes.get(userId)?.delete(hash) ?? false;
  }

  async countRecoveryCodes(userId: string): Promise<number> {
    return this.codes.get(userId)?.size ?? 0;
  }

  async recordMfaFailure(
    userId: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    const recent = this.recent(userId, windowMs, now);
    recent.push(now);
    this.failuresAt.set(userId, recent);
    return recent.length;
  }

  async countMfaFailures(
    userId: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    return this.recent(userId, windowMs, now).length;
  }

  async clearMfaFailures(userId: string): Promise<void> {
    this.failuresAt.delete(userId);
  }

  private recent(userId: string, windowMs: number, now: number): number[] {
    return (this.failuresAt.get(userId) ?? []).filter(
      (t) => t > now - windowMs,
    );
  }
}
