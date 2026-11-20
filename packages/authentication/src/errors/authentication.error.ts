import type { AuthenticationErrorOptions } from "../interfaces/authentication-error-options.interface";

/**
 * The base class of this package's errors, and on its own the error for
 * credentials that are missing or failed verification: a 401 on every transport.
 */
export class AuthenticationError extends Error {
  readonly status: 401 | 403 | 409 = 401;
  readonly challenge?: string;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message = "Unauthorized",
    { challenge, code, details, cause }: AuthenticationErrorOptions = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    if (challenge !== undefined) {
      this.challenge = challenge;
    }
    if (code !== undefined) {
      this.code = code;
    }
    if (details !== undefined) {
      this.details = details;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
