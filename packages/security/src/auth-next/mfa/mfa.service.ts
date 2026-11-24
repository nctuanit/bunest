import { Inject, Injectable, Logger, Optional } from "@bunest/core";
import { AUTHENTICATION_MODULE_OPTIONS } from "../authentication.constants";
import { MfaAlreadyEnrolledError } from "../errors/mfa-already-enrolled.error";
import { SecretDecryptionError } from "../errors/secret-decryption.error";
import { AuthenticationEvents } from "../events/authentication-events.service";
import type { AuthenticationModuleOptions } from "../interfaces/authentication-module-options.interface";
import type { MfaOptions } from "../interfaces/mfa-options.interface";
import type { MfaStore } from "../interfaces/mfa-store.interface";
import { AuthenticationStorage } from "../storage/authentication.storage";
import { randomBytes, randomInt, safeEqual } from "../utils/crypto.util";
import { durationOr } from "../utils/duration.util";
import { requireIntegerOption } from "../utils/options.util";
import { scryptAsync } from "../utils/scrypt.util";
import { base32Decode, base32Encode, hotp, totpStep } from "./otp.util";
import { SecretCipher } from "./secret-cipher.service";

const PERIOD = 30;
const DIGITS = 6;
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

async function hashRecoveryCode(
  userId: string,
  normalized: string,
): Promise<string> {
  const salt = `nestjs-authentication recovery-code v1 ${userId}`;
  const key = await scryptAsync(normalized, salt, 32, {
    N: 2 ** 14,
    r: 8,
    p: 1,
  });
  return `rc1.${key.toString("base64url")}`;
}

/**
 * TOTP second factor (RFC 6238 over RFC 4226 HOTP, SHA-1, 6 digits, 30 s)
 * plus recovery codes.
 */
@Injectable()
export class MfaService {
  private static readonly logger = new Logger("MfaService");
  private readonly options?: MfaOptions;
  private readonly lockoutWindow: number;
  private readonly cipher?: SecretCipher;

  constructor(
    private readonly storage: AuthenticationStorage,
    @Optional()
    @Inject(AUTHENTICATION_MODULE_OPTIONS)
    options?: AuthenticationModuleOptions,
    private readonly events: AuthenticationEvents = new AuthenticationEvents(),
  ) {
    this.options = options?.mfa;
    this.lockoutWindow = durationOr(this.options?.lockoutWindow, "15m");
    if (!this.options) {
      return;
    }
    if (this.options.encryption === undefined) {
      throw new Error(
        "MFA: `mfa.encryption` is required. TOTP secrets cannot be hashed, so a store dump would let anyone " +
          "mint valid codes. Pass `{ keys: [key] }`, or `false` to store them in plaintext deliberately.",
      );
    }
    if (this.options.encryption) {
      this.cipher = new SecretCipher(this.options.encryption);
    }
    requireIntegerOption(this.options.maxAttempts, "mfa.maxAttempts", {
      min: 1,
    });
    requireIntegerOption(this.options.window, "mfa.window", {
      min: 0,
      max: 10,
    });
    requireIntegerOption(this.options.recoveryCodes, "mfa.recoveryCodes", {
      min: 1,
    });
  }

  /** Whether the user has a confirmed authenticator. */
  async isEnrolled(userId: string): Promise<boolean> {
    if (!this.options) {
      return false;
    }
    return !!(await this.store.getTotp(userId))?.confirmed;
  }

  /**
   * Starts an enrollment. Throws {@link MfaAlreadyEnrolledError} when the user
   * has a confirmed authenticator, unless `replace` is set.
   */
  async enroll(
    userId: string,
    accountName: string,
    { replace = false }: { replace?: boolean } = {},
  ): Promise<{ secret: string; uri: string }> {
    const current = await this.store.getTotp(userId);
    const secret = base32Encode(randomBytes(20));
    const sealed = await this.seal(userId, secret);
    if (current?.confirmed) {
      if (!replace) {
        throw new MfaAlreadyEnrolledError(userId);
      }
      await this.store.saveTotp(userId, { ...current, pendingSecret: sealed });
    } else {
      await this.store.saveTotp(userId, { secret: sealed, confirmed: false });
    }
    return { secret, uri: this.keyUri(secret, accountName) };
  }

  /** Activates a pending enrollment (or a staged replacement). */
  async confirm(userId: string, code: string): Promise<boolean> {
    const record = await this.store.getTotp(userId);
    const candidate = record?.confirmed ? record.pendingSecret : record?.secret;
    if (!record || !candidate) {
      return false;
    }
    const opened = await this.open(userId, candidate);
    if (!opened || !(await this.check(userId, opened, code))) {
      return false;
    }
    const latest = await this.store.getTotp(userId);
    const stillPending =
      !!latest &&
      (record.confirmed
        ? latest.pendingSecret === candidate
        : latest.secret === candidate);
    if (!latest || !stillPending) {
      return false;
    }
    const { pendingSecret: _pending, ...rest } = latest;
    const secret = opened.needsReencrypt
      ? await this.seal(userId, opened.plaintext)
      : candidate;
    await this.store.saveTotp(userId, { ...rest, secret, confirmed: true });
    this.events.emit({
      type: "mfa-enabled",
      userId,
      replaced: record.confirmed,
    });
    return true;
  }

  async verifyTotp(userId: string, code: string): Promise<boolean> {
    const record = await this.store.getTotp(userId);
    if (!record?.confirmed) {
      return false;
    }
    const opened = await this.open(userId, record.secret);
    if (!opened || !(await this.check(userId, opened, code))) {
      return false;
    }
    if (opened.needsReencrypt) {
      const latest = await this.store.getTotp(userId);
      if (latest?.secret === record.secret) {
        await this.store.saveTotp(userId, {
          ...latest,
          secret: await this.seal(userId, opened.plaintext),
        });
      }
    }
    this.events.emit({ type: "mfa-verified", userId, method: "totp" });
    return true;
  }

  /** Re-encrypts the stored secret with the current key if sealed with an older one. */
  async reencrypt(userId: string): Promise<boolean> {
    const record = await this.store.getTotp(userId);
    if (!record || !this.cipher || !this.cipher.needsReencrypt(record.secret)) {
      return false;
    }
    const opened = await this.open(userId, record.secret);
    if (!opened) {
      return false;
    }
    const latest = await this.store.getTotp(userId);
    if (latest?.secret !== record.secret) {
      return false;
    }
    await this.store.saveTotp(userId, {
      ...latest,
      secret: await this.seal(userId, opened.plaintext),
    });
    return true;
  }

  /** Returns fresh plaintext recovery codes (show once); replaces any previous batch. */
  async generateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from(
      { length: this.options?.recoveryCodes ?? 10 },
      () => {
        const chars = Array.from(
          { length: 10 },
          () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!,
        ).join("");
        return `${chars.slice(0, 5)}-${chars.slice(5)}`;
      },
    );
    const hashes = await Promise.all(
      codes.map((c) => hashRecoveryCode(userId, normalizeCode(c))),
    );
    await this.store.saveRecoveryCodes(userId, hashes);
    this.events.emit({
      type: "recovery-codes-generated",
      userId,
      count: codes.length,
    });
    return codes;
  }

  async verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
    const attempt = await this.begin(userId, "recovery-code");
    if (attempt === undefined) {
      return false;
    }
    const normalized = typeof code === "string" ? normalizeCode(code) : "";
    if (
      normalized.length === 10 &&
      (await this.store.consumeRecoveryCode(
        userId,
        await hashRecoveryCode(userId, normalized),
      ))
    ) {
      await this.store.clearMfaFailures(userId);
      this.events.emit({
        type: "mfa-verified",
        userId,
        method: "recovery-code",
      });
      return true;
    }
    this.failed(userId, "recovery-code", attempt);
    return false;
  }

  async remainingRecoveryCodes(userId: string): Promise<number> {
    return this.store.countRecoveryCodes(userId);
  }

  /** Removes the authenticator and the recovery codes. */
  async disable(userId: string): Promise<void> {
    await this.store.saveTotp(userId, null);
    await this.store.saveRecoveryCodes(userId, []);
    this.events.emit({ type: "mfa-disabled", userId });
  }

  keyUri(secret: string, accountName: string): string {
    const issuer = this.options?.issuer ?? "NestJS";
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
    const params = new URLSearchParams({
      secret,
      issuer,
      algorithm: "SHA1",
      digits: String(DIGITS),
      period: String(PERIOD),
    });
    return `otpauth://totp/${label}?${params.toString().replaceAll("+", "%20")}`;
  }

  private async check(
    userId: string,
    opened: { plaintext: string; needsReencrypt: boolean },
    code: string,
  ): Promise<boolean> {
    const attempt = await this.begin(userId, "totp");
    if (attempt === undefined) {
      return false;
    }
    const step = this.matchingStep(opened.plaintext, code);
    if (step !== undefined && (await this.store.claimTotpStep(userId, step))) {
      await this.store.clearMfaFailures(userId);
      return true;
    }
    this.failed(userId, "totp", attempt);
    return false;
  }

  private async begin(
    userId: string,
    method: "totp" | "recovery-code",
  ): Promise<number | undefined> {
    const failures = await this.store.countMfaFailures(
      userId,
      this.lockoutWindow,
      this.now(),
    );
    if (failures >= this.maxAttempts) {
      this.events.emit({
        type: "mfa-failed",
        userId,
        method,
        failures,
        locked: true,
      });
      return undefined;
    }
    const attempt = await this.store.recordMfaFailure(
      userId,
      this.lockoutWindow,
      this.now(),
    );
    if (attempt > this.maxAttempts) {
      this.events.emit({
        type: "mfa-failed",
        userId,
        method,
        failures: attempt,
        locked: true,
      });
      return undefined;
    }
    return attempt;
  }

  private failed(
    userId: string,
    method: "totp" | "recovery-code",
    attempt: number,
  ): void {
    this.events.emit({
      type: "mfa-failed",
      userId,
      method,
      failures: attempt,
      locked: attempt >= this.maxAttempts,
    });
  }

  private async seal(userId: string, secret: string): Promise<string> {
    return this.cipher
      ? await this.cipher.encrypt(secret, `totp.${userId}`)
      : secret;
  }

  private async open(
    userId: string,
    stored: string,
  ): Promise<{ plaintext: string; needsReencrypt: boolean } | undefined> {
    if (!this.cipher) {
      return { plaintext: stored, needsReencrypt: false };
    }
    try {
      return await this.cipher.decrypt(stored, `totp.${userId}`);
    } catch (error) {
      if (!(error instanceof SecretDecryptionError)) {
        throw error;
      }
      MfaService.logger.error(
        `TOTP secret of user ${userId} could not be decrypted: ${error.message}`,
      );
      return undefined;
    }
  }

  private matchingStep(secret: string, code: string): number | undefined {
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return undefined;
    }
    let key: Buffer;
    try {
      key = base32Decode(secret);
    } catch {
      return undefined;
    }
    if (key.length < 16) {
      return undefined;
    }
    const current = totpStep(Math.floor(this.now() / 1000), PERIOD);
    const window = this.options?.window ?? 1;
    let found: number | undefined;
    for (let step = current - window; step <= current + window; step++) {
      if (safeEqual(hotp(key, step, DIGITS), code) && found === undefined) {
        found = step;
      }
    }
    return found;
  }

  private get store(): MfaStore {
    if (!this.options) {
      throw new Error(
        "MFA is not configured: add `mfa: { encryption: ... }` to the AuthenticationModule options",
      );
    }
    return this.storage.mfa;
  }

  private get maxAttempts(): number {
    return this.options?.maxAttempts ?? 5;
  }

  private now(): number {
    return this.options?.now?.() ?? Date.now();
  }
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}
