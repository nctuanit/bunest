import { Injectable } from "@bunest/core";
import { AuthenticationError } from "../errors/authentication.error";
import type {
  AuthenticatedSession,
  AuthenticatedUser,
  AuthenticationResult,
} from "../interfaces/authentication-result.interface";
import { AuthenticationScope } from "./authentication-scope.service";

/**
 * The current user and session, readable from any singleton provider
 * without passing the request down.
 */
@Injectable()
export class AuthenticationContext<
  TUser = AuthenticatedUser,
  TSession = AuthenticatedSession,
> {
  constructor(
    private readonly scope: AuthenticationScope = new AuthenticationScope(),
  ) {}

  /** The user, or `null` when anonymous or outside a request. */
  get user(): TUser | null {
    return (this.scope.current?.result?.user ?? null) as TUser | null;
  }

  get session(): TSession | null {
    return (this.scope.current?.result?.session ?? null) as TSession | null;
  }

  get isAuthenticated(): boolean {
    return !!this.scope.current?.result?.user;
  }

  /**
   * The user, or an {@link AuthenticationError}: a 401 on any transport when
   * thrown under a handler, a plain error in a queue worker.
   */
  requireUser(): TUser {
    const user = this.user;
    if (!user) {
      throw new AuthenticationError();
    }
    return user;
  }

  /** Runs `fn` as `result.user`, for queue workers, cron jobs and tests. */
  run<R>(result: AuthenticationResult<TUser, TSession> | null, fn: () => R): R {
    return this.scope.run({ result }, fn);
  }
}
