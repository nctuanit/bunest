export interface MagicLinkRecord {
  /** SHA-256 of the token (and browser binding secret when bound). */
  id: string;
  email: string;
  createdAt: Date;
  expiresAt: Date;
  redirectTo?: string;
}

/** Storage for pending magic links. */
export interface MagicLinkStore {
  saveMagicLink(record: MagicLinkRecord): Promise<void>;
  consumeMagicLink(id: string): Promise<MagicLinkRecord | undefined>;
}
