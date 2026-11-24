/** `unauthenticated`: denied with no user (401). `forbidden`: denied this user (403). */
export type DenialReason = "unauthenticated" | "forbidden";

/**
 * Thrown by `AuthorizationService.authorize()` when the ability denies.
 *
 * It is transport-agnostic, so a queue worker or a cron job catches it like
 * any other error. When it leaves a handler, `AuthorizationModule` turns it into
 * the transport's own error, the same one `@Can()` throws: 401/403 over HTTP
 * and GraphQL, a `WsException` in gateways, an `RpcException` in message
 * handlers.
 */
export class AuthorizationError extends Error {
  readonly reason: DenialReason;
  /** The policy class name, e.g. `OrderPolicy`; `null` for a handler that declares no check. */
  readonly policy: string | null;
  /** The ability that denied, e.g. `refund`; `null` for a handler that declares no check. */
  readonly ability: string | null;
  /**
   * 401 (`unauthenticated`) or 403 (`forbidden`): the caller's fault, not an
   * outage, so other packages classify it without importing this class.
   */
  readonly status: 401 | 403;

  constructor(
    reason: DenialReason,
    policy: string | null,
    ability: string | null,
  ) {
    super(reason === "unauthenticated" ? "Unauthorized" : "Forbidden");
    this.reason = reason;
    this.policy = policy;
    this.ability = ability;
    this.name = "AuthorizationError";
    this.status = reason === "unauthenticated" ? 401 : 403;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
