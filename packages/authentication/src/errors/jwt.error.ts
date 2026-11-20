import { AuthenticationError } from "./authentication.error";

/**
 * A token failed verification: malformed, badly signed, expired, for
 * another issuer or audience.
 */
export class JwtError extends AuthenticationError {
  constructor(message: string) {
    super(message);
    this.name = "JwtError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
