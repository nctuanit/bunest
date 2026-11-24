import type { ProviderClass } from "../providers/authentication.provider";

export interface AuthenticateOptions {
  /** Let anonymous callers through; `@CurrentUser()` is then `null`. */
  optional?: boolean;
  /** Require a verified second factor (step-up). */
  mfa?: boolean;
  /** Require a user whose email address is verified (403 `email_unverified` otherwise). */
  verifiedEmail?: boolean;
  /** Only these providers may authenticate the route. */
  providers?: ProviderClass[];
}

/** @internal What the guard reads: the class options, with the method's merged over them. */
export interface RouteAuthentication extends AuthenticateOptions {
  public?: boolean;
}
