import { AuthenticationError } from "./authentication.error";

/**
 * Thrown by `MfaService.enroll()` when the user already has a confirmed
 * authenticator and `replace` was not requested (HTTP 409).
 */
export class MfaAlreadyEnrolledError extends AuthenticationError {
  readonly userId: string;
  override readonly status = 409 as const;

  constructor(userId: string) {
    super("Authenticator already enrolled");
    this.userId = userId;
    this.name = "MfaAlreadyEnrolledError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
