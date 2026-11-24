import type { DenialReason } from "../errors/authorization.error";

/**
 * `@Can()` or `authorize()` refused a caller. `can()` answering `false`
 * is not a denial: it shapes a response and refuses no one.
 */
export interface AuthorizationDeniedEvent {
  type: "denied";
  /**
   * The policy class name, e.g. `OrderPolicy`. `null` when the guard denied
   * a handler that declares no check: no `@Can()`, `@Can.Anyone()` or `@Public()`.
   */
  policy: string | null;
  /** The ability that denied, e.g. `refund`; `null` with `policy`. */
  ability: string | null;
  /** `unauthenticated` (no user, 401) or `forbidden` (403). */
  reason: DenialReason;
  /** The user the policy saw; `null` for a guest. */
  user: unknown;
  /** The ability's arguments after the user, such as the record; for `@Can()`, what its resolver read. */
  args: readonly unknown[];
  /** The handler `@Can()` guarded, as `ClassName.methodName`. Absent for `authorize()`. */
  handler?: string;
}

/** Every event `AuthorizationEvents` emits. There is one kind so far: a denial. */
export type AuthorizationEvent = AuthorizationDeniedEvent;
