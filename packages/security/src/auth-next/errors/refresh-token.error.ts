import type { RefreshTokenFailure } from "../interfaces/refresh-token-options.interface";
import { AuthenticationError } from "./authentication.error";

/** A refresh token was refused (HTTP 401). */
export class RefreshTokenError extends AuthenticationError {
  readonly reason: RefreshTokenFailure;

  constructor(reason: RefreshTokenFailure) {
    super(`Refresh token ${reason}`);
    this.reason = reason;
    this.name = "RefreshTokenError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
