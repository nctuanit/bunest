import { Inject, Injectable, Logger, Optional } from "@bunest/core";
import { AUTHENTICATION_MODULE_OPTIONS } from "../authentication.constants";
import { AuthenticationEvents } from "../events/authentication-events.service";
import type { AuthenticationModuleOptions } from "../interfaces/authentication-module-options.interface";
import type { MfaState } from "../interfaces/authentication-result.interface";
import type {
  IssuedSession,
  SessionOptions,
  SessionRequest,
} from "../interfaces/session.interface";
import type { SessionRecord } from "../interfaces/session-store.interface";
import { AuthenticationStorage } from "../storage/authentication.storage";
import { firstHeader } from "../utils/auth-state.util";
import {
  isCrossOriginWrite,
  normalizeOrigin,
} from "../utils/cross-origin.util";
import { randomToken, sha256, TOKEN_PATTERN } from "../utils/crypto.util";
import { durationOr, hasExpired } from "../utils/duration.util";
import type { HeadersInput } from "../utils/headers.util";
import {
  assertCookieAttributes,
  defaultCookieName,
  readCookie,
  serializeCookie,
} from "./cookies.util";

const REVOKE_ROUNDS = 5;

/**
 * Server-side sessions: opaque 256-bit tokens in an `HttpOnly` cookie,
 * stored by their SHA-256.
 */
@Injectable()
export class SessionService {
  private static readonly logger = new Logger("SessionService");
  private readonly options: SessionOptions;
  private readonly absoluteTtl: number;
  private readonly pendingTtl: number;
  private readonly idleTtl: number;
  private readonly touchInterval: number;
  private readonly cookieName: string;
  private readonly trustedOrigins: Set<string>;
  private failedTouches = 0;

  constructor(
    private readonly storage: AuthenticationStorage,
    @Optional()
    @Inject(AUTHENTICATION_MODULE_OPTIONS)
    options?: AuthenticationModuleOptions,
    private readonly events: AuthenticationEvents = new AuthenticationEvents(),
  ) {
    this.options = options?.session ?? {};
    this.absoluteTtl = durationOr(this.options.absoluteTtl, "7d");
    this.pendingTtl = Math.min(
      durationOr(options?.mfa?.pendingTtl, "10m"),
      this.absoluteTtl,
    );
    this.idleTtl = durationOr(this.options.idleTtl, "1d");
    this.touchInterval = durationOr(this.options.touchInterval, "1m");
    if (this.idleTtl > 0 && this.touchInterval >= this.idleTtl) {
      throw new TypeError(
        `session.touchInterval (${this.touchInterval} ms) must be shorter than session.idleTtl (${this.idleTtl} ms): ` +
          "activity is recorded at most once per touchInterval, so active users would be signed out as idle.",
      );
    }
    this.cookieName =
      this.options.cookieName ?? defaultCookieName("sid", this.options.cookie);
    assertCookieAttributes(this.cookieName, this.options.cookie, "session");
    this.trustedOrigins = new Set(
      (this.options.trustedOrigins ?? []).map((origin) =>
        normalizeOrigin(origin, "session.trustedOrigins"),
      ),
    );
  }

  /**
   * Starts a session. `replacing` is the token of the session this client
   * had before; it is deleted (session fixation defence).
   */
  async create(
    userId: string,
    {
      mfa,
      metadata,
      replacing,
    }: {
      mfa?: MfaState;
      metadata?: Record<string, unknown>;
      replacing?: string;
    } = {},
  ): Promise<IssuedSession> {
    if (replacing && TOKEN_PATTERN.test(replacing)) {
      await this.storage.sessions.deleteSession(sha256(replacing));
    }
    const now = this.now();
    return this.issue({
      userId,
      createdAt: new Date(now),
      expiresAt: new Date(
        now + (mfa === "pending" ? this.pendingTtl : this.absoluteTtl),
      ),
      lastActiveAt: new Date(now),
      ...(mfa ? { mfa } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }

  /**
   * The live session for a token, sliding its idle timeout.
   */
  async validate(token: string | undefined): Promise<SessionRecord | null> {
    if (!token || !TOKEN_PATTERN.test(token)) {
      return null;
    }
    const record = await this.storage.sessions.getSession(sha256(token));
    if (!record) {
      return null;
    }
    const now = this.now();
    if (!this.isLive(record, now)) {
      if (hasExpired(record.expiresAt, now)) {
        await this.storage.sessions.deleteSession(record.id);
      }
      return null;
    }
    if (now - record.lastActiveAt.getTime() >= this.touchInterval) {
      await this.touch(record, new Date(now));
    }
    return record;
  }

  /**
   * Replaces the session id, keeping its user and absolute expiry.
   */
  async rotate(
    session: SessionRecord,
    changes: Partial<Pick<SessionRecord, "mfa" | "metadata">> = {},
  ): Promise<IssuedSession | null> {
    const { id: _id, extra: _extra, ...rest } = session;
    const verifying = session.mfa === "pending" && changes.mfa === "verified";
    const issued = await this.issue({
      ...rest,
      ...changes,
      lastActiveAt: new Date(this.now()),
      ...(verifying
        ? {
            expiresAt: new Date(session.createdAt.getTime() + this.absoluteTtl),
          }
        : {}),
    });
    if (!(await this.storage.sessions.deleteSession(session.id))) {
      await this.storage.sessions.deleteSession(issued.session.id);
      return null;
    }
    return issued;
  }

  /**
   * Ends one of `userId`'s sessions. Resolves `false` when the id is unknown
   * or belongs to another user.
   */
  async revoke(
    sessionId: string,
    { userId }: { userId: string },
  ): Promise<boolean> {
    const record =
      typeof sessionId === "string"
        ? await this.storage.sessions.getSession(sessionId)
        : undefined;
    if (!record || record.userId !== userId) {
      return false;
    }
    await this.storage.sessions.deleteSession(record.id);
    this.events.emit({ type: "sign-out", userId, sessionId: record.id });
    return true;
  }

  /**
   * Ends every session of a user, optionally keeping one (`except`: its id).
   */
  async revokeAll(
    userId: string,
    { except }: { except?: string } = {},
  ): Promise<void> {
    const store = this.storage.sessions;
    const others = async () =>
      (await store.listUserSessions(userId)).filter(
        (session) => session.id !== except,
      );
    let left = except ? await others() : [];
    if (except && left.length === 0) {
      return;
    }
    for (let round = 1; ; round++) {
      if (except) {
        for (const session of left) {
          await store.deleteSession(session.id);
        }
      } else {
        await store.deleteUserSessions(userId);
      }
      left = await others();
      if (left.length === 0) {
        return;
      }
      if (round === REVOKE_ROUNDS) {
        throw new Error(
          `SessionService.revokeAll(): ${left.length} ${left.length === 1 ? "session" : "sessions"} of user ${userId} ` +
            `still listed after ${REVOKE_ROUNDS} rounds of deletes. listUserSessions() must read what was just deleted ` +
            "(the primary, not a replica that lags), and deleteUserSessions() must delete every session of the user.",
        );
      }
    }
  }

  /** Live sessions of a user: not past their absolute expiry or their idle timeout. */
  async list(userId: string): Promise<SessionRecord[]> {
    const now = this.now();
    return (await this.storage.sessions.listUserSessions(userId)).filter((s) =>
      this.isLive(s, now),
    );
  }

  /** @internal The session token a request carries. */
  tokenFrom(
    request:
      { headers: HeadersInput; method?: string; url?: string } | undefined,
  ): string | undefined {
    if (!request || this.isCrossOriginWrite(request)) {
      return undefined;
    }
    const token = readCookie(
      firstHeader(request.headers, "cookie"),
      this.cookieName,
    );
    return token && TOKEN_PATTERN.test(token) ? token : undefined;
  }

  /** @internal Whether `request` changes state from another origin than the app's own and `trustedOrigins`. */
  isCrossOriginWrite(request: {
    headers: HeadersInput;
    method?: string;
    url?: string;
  }): boolean {
    return isCrossOriginWrite(request, this.trustedOrigins);
  }

  /** @internal */
  metadataFor(
    request: SessionRequest | undefined,
  ): Record<string, unknown> | undefined {
    return request && this.options.metadata
      ? this.options.metadata(request)
      : undefined;
  }

  /** @internal */
  clearCookie(): string {
    return serializeCookie(this.cookieName, "", {
      ...this.options.cookie,
      maxAge: 0,
    });
  }

  /** @internal Deletes a session by id, for sessions whose user is gone. */
  async discard(sessionId: string): Promise<void> {
    await this.storage.sessions.deleteSession(sessionId);
  }

  private async touch(
    record: SessionRecord,
    lastActiveAt: Date,
  ): Promise<void> {
    try {
      await this.storage.sessions.touchSession(record.id, lastActiveAt);
    } catch (error) {
      if (this.failedTouches++ === 0) {
        SessionService.logger.warn(
          `Recording activity on a session of user ${record.userId} failed, so its idle timeout did not move: ` +
            (error instanceof Error ? error.message : String(error)) +
            ". Further failures are not logged until a touch succeeds again.",
        );
      }
      this.events.emit({
        type: "session-touch-failed",
        userId: record.userId,
        sessionId: record.id,
        error,
      });
      return;
    }
    record.lastActiveAt = lastActiveAt;
    if (this.failedTouches > 0) {
      SessionService.logger.log(
        `Recording session activity works again; ${this.failedTouches} ${this.failedTouches === 1 ? "touch" : "touches"} failed meanwhile.`,
      );
      this.failedTouches = 0;
    }
  }

  private isLive(record: SessionRecord, now: number): boolean {
    if (hasExpired(record.expiresAt, now)) {
      return false;
    }
    return (
      this.idleTtl === 0 || now < record.lastActiveAt.getTime() + this.idleTtl
    );
  }

  private async issue(
    fields: Omit<SessionRecord, "id">,
  ): Promise<IssuedSession> {
    const token = randomToken();
    const session: SessionRecord = { id: sha256(token), ...fields };
    await this.storage.sessions.createSession(session);
    const maxAge = Math.round(
      (session.expiresAt.getTime() - this.now()) / 1000,
    );
    return {
      session,
      token,
      cookie: serializeCookie(this.cookieName, token, {
        ...this.options.cookie,
        maxAge,
      }),
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
