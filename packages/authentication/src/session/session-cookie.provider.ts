import { Inject, type ExecutionContext } from "@bunest/common";
import type {
  AuthenticatedUser,
  AuthenticationResult,
} from "../interfaces/authentication-result.interface";
import type { SessionRecord } from "../interfaces/session-store.interface";
import {
  AuthenticationProvider,
  PROVIDER_INIT,
} from "../providers/authentication.provider";
import { requestOf } from "../utils/auth-state.util";
import { SessionService } from "./session.service";

/**
 * Base class for cookie-session authentication. Extend it and load the
 * user; `SessionService` is property-injected, so the subclass constructor
 * only lists its own dependencies.
 */
export abstract class SessionCookieProvider<
  TUser = AuthenticatedUser,
> extends AuthenticationProvider<TUser, SessionRecord> {
  @Inject(SessionService)
  protected sessions!: SessionService;

  override async authenticate(
    context: ExecutionContext,
  ): Promise<AuthenticationResult<TUser, SessionRecord> | null> {
    const session = await this.sessions.validate(
      this.sessions.tokenFrom(requestOf(context)),
    );
    if (!session) {
      return null;
    }
    const user = await this.validate(session);
    if (user === null || user === undefined) {
      await this.sessions.discard(session.id);
      return null;
    }
    const { extra: _extra, ...stored } = session;
    return { user, session: stored as SessionRecord, mfa: session.mfa };
  }

  /** @internal An instance created with `new` was not property-injected. */
  [PROVIDER_INIT](
    resolve: <T>(
      token: string | symbol | (abstract new (...args: any[]) => T),
    ) => T,
  ): void {
    this.sessions ??= resolve(SessionService);
  }

  /** Load the user for a live session, or return `null` to end it (e.g. a disabled account). */
  abstract validate(
    session: SessionRecord,
  ): Promise<TUser | null | undefined> | TUser | null | undefined;
}
