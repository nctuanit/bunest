import type { Duration } from "./duration.interface";
import type { IssuedSession } from "./session.interface";

/** The account behind an address, as `PasswordResetHandler.findUser()` returns it. */
export interface PasswordResetAccount {
  id: string;
  /** The address the account has stored. */
  email: string;
  /** The stored password hash, or `null` for an account without a password. */
  passwordHash: string | null;
}

/** What `PasswordResetHandler.send()` delivers. */
export interface PasswordResetLink {
  userId: string;
  email: string;
  /** `passwordReset.url` with `?token=...`. */
  url: string;
  expiresAt: Date;
}

export interface PasswordResetOptions {
  /** Page that receives `?token=...`, asks for a new password and POSTs both. */
  url: string;
  /** Lifetime of a link. Default `'1h'`. */
  ttl?: Duration;
  /** Clock in epoch milliseconds, for tests. */
  now?: () => number;
}

export interface ResetPasswordOptions {
  /** Signs the user in on this browser afterwards. Default `false`. */
  signIn?: boolean;
}

export interface PasswordResetResult {
  userId: string;
  /** With `signIn: true`: the new session, as `SignInService.signIn()` returns it. */
  signedIn?: IssuedSession;
}
