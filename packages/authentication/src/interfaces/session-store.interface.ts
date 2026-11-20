import type {
  MfaState,
  SessionExtra,
} from "./authentication-result.interface";

export interface SessionRecord {
  /** SHA-256 of the cookie token. The token itself is never stored. */
  id: string;
  userId: string;
  createdAt: Date;
  /** Absolute expiry: activity never extends a session past this. */
  expiresAt: Date;
  /** Last activity, for the idle (sliding) timeout. */
  lastActiveAt: Date;
  mfa?: MfaState;
  /** App data: user agent, IP, device name. */
  metadata?: Record<string, unknown>;
  /** Extra joined data read with the session for `SessionCookieProvider.validate()`. */
  extra?: SessionExtra;
}

/** Where sessions live. */
export interface SessionStore {
  getSession(id: string): Promise<SessionRecord | undefined>;
  createSession(record: SessionRecord): Promise<void>;
  touchSession(id: string, lastActiveAt: Date): Promise<void>;
  deleteSession(id: string): Promise<boolean>;
  listUserSessions(userId: string): Promise<SessionRecord[]>;
  deleteUserSessions(userId: string): Promise<void>;
}
