import type { ExecutionContext } from "@bunest/common";
import type {
  AuthenticatedSession,
  AuthenticatedUser,
  AuthenticationResult,
} from "../interfaces/authentication-result.interface";
import { firstHeader, getRequestHeaders } from "../utils/auth-state.util";

/**
 * A credential source: the contract every provider meets, and the base
 * class of `SessionCookieProvider`, `JwtBearerProvider`, and `ApiKeyProvider`.
 */
export abstract class AuthenticationProvider<
  TUser = AuthenticatedUser,
  TSession = AuthenticatedSession,
> {
  abstract authenticate(
    context: ExecutionContext,
  ):
    | Promise<AuthenticationResult<TUser, TSession> | null>
    | AuthenticationResult<TUser, TSession>
    | null;

  /** A request header, whatever the transport. */
  protected header(context: ExecutionContext, name: string): string | undefined {
    return firstHeader(getRequestHeaders(context), name.toLowerCase());
  }
}

export interface AuthenticationProvider<
  TUser = AuthenticatedUser,
  TSession = AuthenticatedSession,
> {
  /** `WWW-Authenticate` challenge sent with a 401 when no provider found credentials. */
  challenge?(context: ExecutionContext): string | undefined;
}

/** A provider class, possibly abstract, for `@Authenticate({ providers })`. */
export type ProviderClass = abstract new (
  ...args: any[]
) => AuthenticationProvider<any, any>;

/** @internal Called by the module once the provider is resolved, before the first request. */
export const PROVIDER_INIT: unique symbol = Symbol(
  "nestjs.authentication.provider-init",
);

/** @internal */
export type ProviderInit = (
  resolve: <T>(
    token: string | symbol | (abstract new (...args: any[]) => T),
  ) => T,
) => void;
