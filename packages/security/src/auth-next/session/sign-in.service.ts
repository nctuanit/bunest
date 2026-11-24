import { ForbiddenException, Injectable, Optional } from "@bunest/core";
import { HttpAdapterHost } from "@bunest/core";
import {
  AuthenticationScope,
  type HttpExchange,
} from "../context/authentication-scope.service";
import { AuthenticationEvents } from "../events/authentication-events.service";
import type { IssuedSession } from "../interfaces/session.interface";
import type { SignInOptions } from "../interfaces/sign-in-options.interface";
import { TokenService } from "../jwt/token.service";
import { MfaService } from "../mfa/mfa.service";
import { sha256 } from "../utils/crypto.util";
import { appendResponseHeader, type HeadersInput } from "../utils/headers.util";
import { SessionService } from "./session.service";

/**
 * The browser's side of signing in. Called from an HTTP handler (or a
 * GraphQL resolver whose context has `req` and `res`), each method reads
 * this browser's session cookie from the request and sets the new one on
 * the response.
 */
@Injectable()
export class SignInService {
  constructor(
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly tokens: TokenService,
    private readonly scope: AuthenticationScope = new AuthenticationScope(),
    @Optional() private readonly adapterHost?: HttpAdapterHost,
    private readonly events: AuthenticationEvents = new AuthenticationEvents(),
  ) {}

  /**
   * Signs the user in on this browser. Throws a `ForbiddenException` for a
   * cross-origin write request.
   */
  async signIn(
    userId: string,
    { method, metadata }: SignInOptions = {},
  ): Promise<IssuedSession> {
    const exchange = this.scope.exchange();
    this.refuseCrossOrigin(exchange?.request);
    const mfa = (await this.mfa.isEnrolled(userId)) ? "pending" : undefined;
    const stored = {
      ...this.sessions.metadataFor(exchange?.request),
      ...metadata,
    };
    const issued = await this.sessions.create(userId, {
      mfa,
      metadata: Object.keys(stored).length ? stored : undefined,
      replacing: this.sessions.tokenFrom(exchange?.request),
    });
    this.setCookie(exchange, issued.cookie);
    this.events.emit({
      type: "sign-in",
      userId,
      sessionId: issued.session.id,
      ...(method ? { method } : {}),
      ...(mfa ? { mfa } : {}),
      ...(issued.session.metadata ? { metadata: issued.session.metadata } : {}),
    });
    return issued;
  }

  /**
   * Completes the second factor of this browser's session with a TOTP code
   * or a recovery code, and rotates the session to `mfa: 'verified'`.
   */
  async completeMfa({
    code,
    recoveryCode,
  }: {
    code?: string;
    recoveryCode?: string;
  }): Promise<IssuedSession | null> {
    if (!code && !recoveryCode) {
      return null;
    }
    const exchange = this.scope.exchange();
    const session = await this.sessions.validate(
      this.sessions.tokenFrom(exchange?.request),
    );
    if (!session) {
      return null;
    }
    const verified = recoveryCode
      ? await this.mfa.verifyRecoveryCode(session.userId, recoveryCode)
      : await this.mfa.verifyTotp(session.userId, code!);
    if (!verified) {
      return null;
    }
    const issued = await this.sessions.rotate(session, { mfa: "verified" });
    if (issued) {
      this.setCookie(exchange, issued.cookie);
    }
    return issued;
  }

  /**
   * Confirms the user's new authenticator and, when this browser holds a
   * session of the user, rotates it to `mfa: 'verified'`.
   */
  async confirmMfa(userId: string, code: string): Promise<boolean> {
    if (!(await this.mfa.confirm(userId, code))) {
      return false;
    }
    const exchange = this.scope.exchange();
    const session = await this.sessions.validate(
      this.sessions.tokenFrom(exchange?.request),
    );
    if (session?.userId === userId) {
      const issued = await this.sessions.rotate(session, { mfa: "verified" });
      if (issued) {
        this.setCookie(exchange, issued.cookie);
      }
    }
    return true;
  }

  /** Gives this browser's session a new id and updates the cookie. */
  async rotateSession(): Promise<IssuedSession | null> {
    const exchange = this.scope.exchange();
    const session = await this.sessions.validate(
      this.sessions.tokenFrom(exchange?.request),
    );
    if (!session) {
      return null;
    }
    const issued = await this.sessions.rotate(session);
    if (issued) {
      this.setCookie(exchange, issued.cookie);
    }
    return issued;
  }

  /** Ends this browser's session, pending or not, and clears its cookie. */
  async signOut(): Promise<boolean> {
    const exchange = this.scope.exchange();
    const token = this.sessions.tokenFrom(exchange?.request);
    if (!token) {
      return false;
    }
    const session = await this.sessions.validate(token);
    this.setCookie(exchange, this.sessions.clearCookie());
    await this.sessions.discard(sha256(token));
    if (!session) {
      return false;
    }
    this.events.emit({
      type: "sign-out",
      userId: session.userId,
      sessionId: session.id,
    });
    return true;
  }

  /** Ends every session and refresh-token family of the user. */
  async signOutEverywhere(userId: string): Promise<void> {
    const exchange = this.scope.exchange();
    const own = await this.sessions.validate(
      this.sessions.tokenFrom(exchange?.request),
    );
    await this.sessions.revokeAll(userId);
    await this.tokens.revokeAll(userId);
    if (own?.userId === userId) {
      this.setCookie(exchange, this.sessions.clearCookie());
    }
    this.events.emit({ type: "sign-out", userId, everywhere: true });
  }

  /** @internal Refuses cross-origin state-changing sign-in requests with 403. */
  refuseCrossOrigin(
    request:
      { headers: HeadersInput; method?: string; url?: string } | undefined,
  ): void {
    if (request && this.sessions.isCrossOriginWrite(request)) {
      throw new ForbiddenException("Cross-origin sign-in refused");
    }
  }

  private setCookie(exchange: HttpExchange | undefined, cookie: string): void {
    if (exchange?.response) {
      appendResponseHeader(
        this.adapterHost,
        exchange.response,
        "Set-Cookie",
        cookie,
      );
    }
  }
}
