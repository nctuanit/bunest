/** What a mailed token proves when it comes back. */
export type EmailTokenPurpose = "password-reset" | "email-verification";

/**
 * A token sent by email to prove control of an address: a password reset
 * link, or an email verification link. Stored by the SHA-256 of the token.
 */
export interface EmailTokenRecord {
  /** SHA-256 of the token. */
  id: string;
  purpose: EmailTokenPurpose;
  userId: string;
  /** The address the token was sent to, and the only one it works for. */
  email: string;
  /**
   * Password resets: SHA-256 of the user's password hash when the link was
   * sent, so a password change invalidates the link.
   */
  fingerprint?: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Storage for password reset and email verification tokens.
 */
export interface EmailTokenStore {
  saveEmailToken(record: EmailTokenRecord): Promise<void>;
  consumeEmailToken(
    id: string,
    purpose: EmailTokenPurpose,
  ): Promise<EmailTokenRecord | undefined>;
  deleteUserEmailTokens(
    userId: string,
    purpose: EmailTokenPurpose,
  ): Promise<void>;
}
