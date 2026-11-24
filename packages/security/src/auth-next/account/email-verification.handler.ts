import type { EmailVerificationLink } from "../interfaces/email-verification.interface";
import { hasVerifiedEmail } from "./email.util";

/**
 * Implemented by the app: delivers verification links and records verified addresses.
 */
export abstract class EmailVerificationHandler {
  abstract send(link: EmailVerificationLink): void | Promise<void>;
  abstract markVerified(
    userId: string,
    email: string,
  ): boolean | Promise<boolean>;

  /** Default: `user.emailVerified === true`. */
  isVerified(user: unknown): boolean | Promise<boolean> {
    return hasVerifiedEmail(user);
  }
}
