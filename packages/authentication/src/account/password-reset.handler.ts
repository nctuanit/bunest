import type {
  PasswordResetAccount,
  PasswordResetLink,
} from "../interfaces/password-reset.interface";

/**
 * Implemented by the app: finds accounts by address, delivers reset links,
 * and stores new password hashes.
 */
export abstract class PasswordResetHandler {
  abstract findUser(
    email: string,
  ): PasswordResetAccount | null | Promise<PasswordResetAccount | null>;
  abstract send(link: PasswordResetLink): void | Promise<void>;
  abstract updatePassword(
    userId: string,
    passwordHash: string,
  ): void | Promise<void>;
  hashPassword?(password: string): string | Promise<string>;
}
