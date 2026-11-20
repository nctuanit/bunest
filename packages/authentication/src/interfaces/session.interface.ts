import type { IncomingHttpHeaders } from "node:http";
import type { CookieAttributes } from "../session/cookies.util";
import type { Duration } from "./duration.interface";
import type { SessionRecord } from "./session-store.interface";

/** The request a session is created from. */
export interface SessionRequest {
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined> | Headers;
  ip?: string;
}

export interface SessionOptions {
  /** Default `__Host-sid`, or `sid` when `cookie` rules the `__Host-` prefix out. */
  cookieName?: string;
  /** Absolute lifetime: activity never extends a session past it. Default `'7d'`. */
  absoluteTtl?: Duration;
  /** Idle timeout, slid by activity. Default `'1d'`. `0` disables it. */
  idleTtl?: Duration;
  /** Write `lastActiveAt` at most this often. Default `'1m'`. */
  touchInterval?: Duration;
  /** `HttpOnly` is always set. `secure` defaults to `true`. */
  cookie?: CookieAttributes;
  /** Origins besides the application's own whose pages may use the session cookie for unsafe requests. */
  trustedOrigins?: string[];
  /** What each new session stores next to the user, read from the request that signs in. */
  metadata?: (request: SessionRequest) => Record<string, unknown>;
  /** Clock in epoch milliseconds, for tests. */
  now?: () => number;
}

export interface IssuedSession {
  session: SessionRecord;
  /** The raw token. Only the `Set-Cookie` value should leave the server. */
  token: string;
  /** `Set-Cookie` header value. `SignInService` sets it on the HTTP response itself. */
  cookie: string;
}
