import { Inject, Injectable, Logger, Optional } from "@bunest/core";
import { AUTHENTICATION_MODULE_OPTIONS } from "../authentication.constants";
import { AuthenticationError } from "../errors/authentication.error";
import { RefreshTokenError } from "../errors/refresh-token.error";
import { AuthenticationEvents } from "../events/authentication-events.service";
import type { AuthenticationModuleOptions } from "../interfaces/authentication-module-options.interface";
import type { RefreshTokenRecord } from "../interfaces/refresh-token-store.interface";
import type {
  AccessTokenResult,
  IssuedTokens,
  IssueTokensOptions,
  RefreshClaimsMapper,
  RefreshTokenMapOptions,
  TokenPair,
} from "../interfaces/token.interface";
import { MfaService } from "../mfa/mfa.service";
import { AuthenticationStorage } from "../storage/authentication.storage";
import { randomToken, sha256, TOKEN_PATTERN } from "../utils/crypto.util";
import { durationOr, hasExpired } from "../utils/duration.util";
import { requireOption } from "../utils/options.util";
import { MFA_AMR_VALUES } from "./amr.util";
import { JwtSigner } from "./jwt-signer.service";

const LOCKED_CLAIMS = new Set([
  "iss",
  "sub",
  "aud",
  "exp",
  "nbf",
  "iat",
  "jti",
  "amr",
  "auth_time",
]);

/**
 * Tokens for clients that do not keep cookies (mobile apps, CLIs): a
 * short-lived JWT access token, and an opaque refresh token that renews it.
 */
@Injectable()
export class TokenService {
  private static readonly logger = new Logger("TokenService");
  private static warnedAmr = false;

  private readonly signer?: JwtSigner;
  private readonly expiresIn: number;
  private readonly refreshTokensOff: boolean;
  private readonly ttl: number;
  private readonly absoluteTtl: number;
  private readonly clock?: () => number;

  constructor(
    private readonly storage: AuthenticationStorage,
    @Optional()
    @Inject(AUTHENTICATION_MODULE_OPTIONS)
    options?: AuthenticationModuleOptions,
    private readonly events: AuthenticationEvents = new AuthenticationEvents(),
    private readonly mfa: MfaService = new MfaService(storage),
  ) {
    this.refreshTokensOff = options?.refreshToken === false;
    const refresh = options?.refreshToken || {};
    this.ttl = durationOr(refresh.ttl, "30d");
    this.absoluteTtl = durationOr(refresh.absoluteTtl, "90d");
    this.clock = refresh.now;
    if (options?.accessToken) {
      requireOption(
        options.accessToken.key,
        "accessToken.key",
        "a secret of at least 32 bytes or a KeyObject",
      );
      try {
        this.signer = new JwtSigner(options.accessToken);
      } catch (error) {
        throw new TypeError(
          `AuthenticationModule: \`accessToken\`: ${(error as Error).message.replace(/^JwtSigner: /, "")}`,
        );
      }
    }
    this.expiresIn = Math.floor(
      durationOr(options?.accessToken?.ttl, "15m") / 1000,
    );
  }

  /**
   * At sign-in: signs an access token and starts a refresh-token family.
   */
  async issue(
    userId: string,
    { claims, method, secondFactor }: IssueTokensOptions = {},
  ): Promise<IssuedTokens> {
    const signer = this.requireSigner();
    const verified = await this.checkSecondFactor(userId, secondFactor);
    const own = this.ownClaims(claims);
    const existingAmr = Array.isArray(own?.amr) ? (own.amr as string[]) : [];
    const familyClaims = verified
      ? { ...own, amr: [...existingAmr, "mfa"] }
      : own;
    if (this.refreshTokensOff) {
      this.events.emit({
        type: "sign-in",
        userId,
        ...(method ? { method } : {}),
        ...(verified ? { mfa: "verified" as const } : {}),
      });
      const issued: AccessTokenResult = {
        accessToken: await signer.sign({ ...familyClaims, sub: userId }),
        expiresIn: this.expiresIn,
      };
      return issued as IssuedTokens;
    }
    const familyExpiresAt = new Date(this.now() + this.absoluteTtl);
    const { token, record } = await this.create(
      userId,
      randomToken(16),
      familyExpiresAt,
      familyClaims,
    );
    this.events.emit({
      type: "sign-in",
      userId,
      tokenFamilyId: record.familyId,
      ...(method ? { method } : {}),
      ...(verified ? { mfa: "verified" as const } : {}),
    });
    return (await this.pair(signer, token, record)) as IssuedTokens;
  }

  /**
   * Spends a refresh token: returns its successor, and an access token with
   * the family's claims.
   */
  async refresh(
    refreshToken: string,
    options?: RefreshTokenMapOptions,
  ): Promise<TokenPair> {
    const signer = this.requireSigner();
    this.requireRefreshTokens("refresh");
    if (typeof refreshToken !== "string" || !TOKEN_PATTERN.test(refreshToken)) {
      throw new RefreshTokenError("invalid");
    }
    const store = this.storage.refreshTokens;
    const record = await store.getRefreshToken(sha256(refreshToken));
    if (!record || (await store.isRefreshTokenFamilyRevoked(record.familyId))) {
      throw new RefreshTokenError("invalid");
    }
    const now = new Date(this.now());
    const expired =
      hasExpired(record.expiresAt, now.getTime()) ||
      hasExpired(record.familyExpiresAt, now.getTime());
    if (expired && !record.usedAt) {
      throw new RefreshTokenError("expired");
    }
    if (record.usedAt) {
      throw await this.reused(record);
    }
    const claims = options?.claims
      ? await this.mapClaims(record, options.claims)
      : record.claims;
    const next = await this.create(
      record.userId,
      record.familyId,
      record.familyExpiresAt,
      claims,
    );
    if (!(await store.markRefreshTokenUsed(record.id, now))) {
      throw await this.reused(record);
    }
    return this.pair(signer, next.token, next.record);
  }

  /**
   * Signs out the client holding `refreshToken` (one device): revokes its family.
   */
  async revoke(refreshToken: string): Promise<boolean> {
    this.requireSigner();
    this.requireRefreshTokens("revoke");
    if (typeof refreshToken !== "string" || !TOKEN_PATTERN.test(refreshToken)) {
      return false;
    }
    const store = this.storage.refreshTokens;
    const record = await store.getRefreshToken(sha256(refreshToken));
    if (!record) {
      return false;
    }
    await store.revokeRefreshTokenFamily(record.familyId);
    this.events.emit({
      type: "sign-out",
      userId: record.userId,
      tokenFamilyId: record.familyId,
    });
    return true;
  }

  /** Signs the user out of every token client. */
  async revokeAll(userId: string): Promise<void> {
    if (!this.signer || this.refreshTokensOff) {
      return;
    }
    await this.storage.refreshTokens.revokeUserRefreshTokens(userId);
  }

  private async reused(record: RefreshTokenRecord): Promise<RefreshTokenError> {
    await this.storage.refreshTokens.revokeRefreshTokenFamily(record.familyId);
    this.events.emit({
      type: "refresh-token-reused",
      userId: record.userId,
      tokenFamilyId: record.familyId,
    });
    return new RefreshTokenError("reused");
  }

  private async checkSecondFactor(
    userId: string,
    secondFactor?: IssueTokensOptions["secondFactor"],
  ): Promise<boolean> {
    if (!(await this.mfa.isEnrolled(userId))) {
      return false;
    }
    const { code, recoveryCode } = secondFactor ?? {};
    if (!code && !recoveryCode) {
      throw new AuthenticationError("Second factor required", {
        code: "mfa_required",
      });
    }
    const verified = recoveryCode
      ? await this.mfa.verifyRecoveryCode(userId, recoveryCode)
      : await this.mfa.verifyTotp(userId, code!);
    if (!verified) {
      throw new AuthenticationError("Invalid code", { code: "mfa_required" });
    }
    return true;
  }

  private async pair(
    signer: JwtSigner,
    refreshToken: string,
    record: RefreshTokenRecord,
  ): Promise<TokenPair> {
    const accessToken = await signer.sign({
      ...record.claims,
      sub: record.userId,
    });
    return { accessToken, refreshToken, expiresIn: this.expiresIn };
  }

  private requireRefreshTokens(method: string): void {
    if (this.refreshTokensOff) {
      throw new Error(
        `TokenService.${method}(): refresh tokens are disabled (\`refreshToken: false\` in the AuthenticationModule options)`,
      );
    }
  }

  private requireSigner(): JwtSigner {
    if (!this.signer) {
      throw new Error(
        "TokenService: configure `accessToken` (the signing key) in the AuthenticationModule options",
      );
    }
    return this.signer;
  }

  private async create(
    userId: string,
    familyId: string,
    familyExpiresAt: Date,
    claims?: Record<string, unknown>,
  ): Promise<{ token: string; record: RefreshTokenRecord }> {
    const token = randomToken();
    const now = this.now();
    const record: RefreshTokenRecord = {
      id: sha256(token),
      familyId,
      userId,
      createdAt: new Date(now),
      expiresAt: new Date(Math.min(now + this.ttl, familyExpiresAt.getTime())),
      familyExpiresAt,
      ...(claims ? { claims } : {}),
    };
    await this.storage.refreshTokens.saveRefreshToken(record);
    return { token, record };
  }

  private ownClaims(
    claims?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!claims || !Array.isArray(claims.amr)) {
      return claims;
    }
    const { amr, ...rest } = claims;
    const unique = [...new Set(amr)];
    const stripped = unique.filter(
      (method): method is string =>
        typeof method === "string" &&
        (MFA_AMR_VALUES as readonly string[]).includes(method),
    );
    if (stripped.length && !TokenService.warnedAmr) {
      TokenService.warnedAmr = true;
      TokenService.logger.warn(
        `issue() dropped ${stripped.map((m) => `'${m}'`).join(", ")} from \`claims.amr\`: those values mean a verified second ` +
          "factor, which only the service records (`mfa`, once a code was verified). Remove them from the claims passed to issue().",
      );
    }
    const kept = unique.filter(
      (method) => !(typeof method === "string" && stripped.includes(method)),
    );
    return kept.length ? { ...rest, amr: kept } : rest;
  }

  private async mapClaims(
    record: RefreshTokenRecord,
    mapper: RefreshClaimsMapper,
  ): Promise<Record<string, unknown> | undefined> {
    const mapped = await mapper(
      structuredClone(record.claims ?? {}),
      record.userId,
    );
    if (
      typeof mapped !== "object" ||
      mapped === null ||
      Array.isArray(mapped)
    ) {
      throw new TypeError(
        "TokenService.refresh(): the `claims` mapper must return an object",
      );
    }
    const own = Object.fromEntries(
      Object.entries(mapped).filter(([claim]) => !LOCKED_CLAIMS.has(claim)),
    );
    const locked = Object.fromEntries(
      Object.entries(record.claims ?? {}).filter(([claim]) =>
        LOCKED_CLAIMS.has(claim),
      ),
    );
    const result = { ...own, ...locked };
    return Object.keys(result).length ? result : undefined;
  }

  private now(): number {
    return this.clock?.() ?? Date.now();
  }
}
