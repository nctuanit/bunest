import type { AuthenticationTypes } from "./authentication-types.interface";

/**
 * The user type the app declared by augmenting {@link AuthenticationTypes}.
 * Falls back to a string-keyed record when nothing was declared.
 */
export type AuthenticatedUser = AuthenticationTypes extends { user: infer U }
  ? U
  : Record<string, unknown>;

/** The session type declared on {@link AuthenticationTypes}, `unknown` otherwise. */
export type AuthenticatedSession = AuthenticationTypes extends {
  session: infer S;
}
  ? S
  : unknown;

/**
 * The type of `SessionRecord.extra` declared on {@link AuthenticationTypes}
 * (`sessionExtra`), `unknown` otherwise.
 */
export type SessionExtra = AuthenticationTypes extends {
  sessionExtra: infer E;
}
  ? E
  : unknown;

/**
 * `pending`: first factor done, second factor outstanding.
 * `verified`: a second factor was presented.
 */
export type MfaState = "pending" | "verified";

export interface AuthenticationResult<
  TUser = AuthenticatedUser,
  TSession = AuthenticatedSession,
> {
  user: TUser;
  /** Whatever the provider considers the session: a stored record, JWT claims, an `ApiKeySession`. */
  session?: TSession;
  mfa?: MfaState;
}
