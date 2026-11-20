import type { CookieAttributes } from "../session/cookies.util";
import type { Duration } from "./duration.interface";

export interface MagicLink {
  email: string;
  url: string;
  expiresAt: Date;
}

/** The account behind an address, as `MagicLinkHandler.resolveUser()` returns it. */
export interface MagicLinkAccount {
  id: string;
  /** The address the account has stored. */
  email: string;
}

export interface MagicLinkOptions {
  /** Page that receives `?token=...`. */
  url: string;
  /** Lifetime of a link. Default `'15m'`. */
  ttl?: Duration;
  /** Whether a link works only in the browser that requested it. Default `true`. */
  bindToBrowser?: boolean;
  /** Attributes of the transaction cookie. */
  cookie?: CookieAttributes;
  /** Clock in epoch milliseconds, for tests. */
  now?: () => number;
}

/** The HTTP request that presents a link. */
export type MagicLinkRequest = {
  headers: Record<string, string | string[] | undefined> | Headers;
};

export interface CreatedMagicLink {
  expiresAt: Date;
  /** The `Set-Cookie` value of the transaction cookie. Absent with `bindToBrowser: false`. */
  cookie?: string;
}
