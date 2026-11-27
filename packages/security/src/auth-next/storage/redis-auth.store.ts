import { Injectable } from "@bunest/core";
import type {
  AuthenticationStorageRegisterOptions,
  AuthenticationStorageSources,
} from "../interfaces/authentication-storage.interface";
import type {
  EmailTokenPurpose,
  EmailTokenRecord,
  EmailTokenStore,
} from "../interfaces/email-token-store.interface";
import type {
  MagicLinkRecord,
  MagicLinkStore,
} from "../interfaces/magic-link-store.interface";
import type { MfaStore, TotpRecord } from "../interfaces/mfa-store.interface";
import type { OidcTransaction } from "../interfaces/oidc.interface";
import type { OidcStateStore } from "../interfaces/oidc-state-store.interface";
import type {
  RefreshTokenRecord,
  RefreshTokenStore,
} from "../interfaces/refresh-token-store.interface";
import type {
  SessionRecord,
  SessionStore,
} from "../interfaces/session-store.interface";
import type {
  PasskeyChallengeRecord,
  PasskeyChallengeType,
  PasskeyCredential,
  PasskeyStore,
} from "../webauthn/webauthn.interface";
import type { AuthenticationStorage } from "./authentication.storage";

/**
 * Structural Redis client contract compatible with Bun's native `Bun.RedisClient`
 * as well as custom wrappers and test doubles.
 */
export interface RedisAuthClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number | boolean>;
  exists(key: string): Promise<number | boolean>;
  /** Optional atomic get-and-delete (`GETDEL`). */
  getdel?(key: string): Promise<string | null>;
  /** Optional raw command executor (provided by `Bun.RedisClient`). */
  send?(command: string, args: string[]): Promise<unknown>;
}

export interface RedisAuthenticationStoreOptions {
  /**
   * Key prefix applied to every Redis key created by this store.
   * @default "bunest:auth:"
   */
  keyPrefix?: string;
  /**
   * TTL in seconds for revoked refresh-token family tombstones.
   * @default 7776000 (90 days)
   */
  revokedFamilyTtlSeconds?: number;
  /**
   * Optional clock source returning epoch milliseconds (defaults to `Date.now`).
   */
  now?: () => number;
  /**
   * Optional maximum number of pending magic links, OIDC logins, and email tokens
   * retained per kind (drops earliest-expiring records once exceeded).
   */
  maxPending?: number;
}

const DEFAULT_KEY_PREFIX = "bunest:auth:";
const DEFAULT_REVOKED_FAMILY_TTL_SECONDS = 90 * 24 * 60 * 60;

interface SerializedSession {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastActiveAt: number;
  mfa?: SessionRecord["mfa"];
  metadata?: Record<string, unknown>;
}

interface SerializedRefreshToken {
  id: string;
  familyId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  familyExpiresAt: number;
  usedAt?: number;
  claims?: Record<string, unknown>;
}

interface SerializedMagicLink {
  id: string;
  email: string;
  createdAt: number;
  expiresAt: number;
  redirectTo?: string;
}

interface SerializedOidcTransaction {
  state: string;
  provider: string;
  nonce?: string;
  codeVerifier: string;
  redirectTo?: string;
  createdAt: number;
  expiresAt: number;
  link?: {
    userId: string;
    sessionId: string;
  };
}

interface SerializedEmailToken {
  id: string;
  purpose: EmailTokenPurpose;
  userId: string;
  email: string;
  fingerprint?: string;
  createdAt: number;
  expiresAt: number;
}

interface SerializedPasskeyCredential {
  id: string;
  userId: string;
  publicKey: string;
  algorithm: number;
  counter: number;
  transports?: PasskeyCredential["transports"];
  deviceType?: PasskeyCredential["deviceType"];
  backedUp?: boolean;
  aaguid?: string;
  name?: string;
  createdAt: number;
  lastUsedAt?: number;
}

interface SerializedPasskeyChallenge {
  challenge: string;
  type: PasskeyChallengeType;
  userId?: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Lightweight in-process per-key async mutex ensuring read-modify-write sequences
 * remain serialized under concurrency even against minimal 8-method Redis clients.
 */
class PerKeyMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.tails.set(key, chained);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === chained) {
        this.tails.delete(key);
      }
    }
  }
}

// Atomic Lua scripts executed when the client supports `send("EVAL", ...)` (e.g. `Bun.RedisClient`).
const LUA_TOUCH_SESSION = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local rec = cjson.decode(raw)
local nextAt = tonumber(ARGV[1])
if rec.lastActiveAt and tonumber(rec.lastActiveAt) >= nextAt then
  return 0
end
rec.lastActiveAt = nextAt
local ttl = redis.call('PTTL', KEYS[1])
local encoded = cjson.encode(rec)
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], encoded, 'PX', ttl)
else
  redis.call('SET', KEYS[1], encoded)
end
return 1
`;

const LUA_MARK_REFRESH_USED = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local rec = cjson.decode(raw)
if rec.usedAt ~= nil then return 0 end
rec.usedAt = tonumber(ARGV[1])
local ttl = redis.call('PTTL', KEYS[1])
local encoded = cjson.encode(rec)
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], encoded, 'PX', ttl)
else
  redis.call('SET', KEYS[1], encoded)
end
return 1
`;

const LUA_CLAIM_TOTP_STEP = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local rec = cjson.decode(raw)
local step = tonumber(ARGV[1])
if rec.lastUsedStep ~= nil and tonumber(rec.lastUsedStep) >= step then
  return 0
end
rec.lastUsedStep = step
redis.call('SET', KEYS[1], cjson.encode(rec))
return 1
`;

const LUA_SAVE_TOTP = `
local raw = redis.call('GET', KEYS[1])
local incoming = cjson.decode(ARGV[1])
if raw then
  local existing = cjson.decode(raw)
  local prev = existing.lastUsedStep
  local nextStep = incoming.lastUsedStep
  if prev ~= nil and (nextStep == nil or tonumber(prev) > tonumber(nextStep)) then
    incoming.lastUsedStep = tonumber(prev)
  end
end
redis.call('SET', KEYS[1], cjson.encode(incoming))
return 1
`;

const LUA_CONSUME_EMAIL_TOKEN = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local rec = cjson.decode(raw)
if rec.purpose ~= ARGV[1] then return nil end
redis.call('DEL', KEYS[1])
return raw
`;

const LUA_UPDATE_PASSKEY_COUNTER = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local rec = cjson.decode(raw)
local nextCounter = tonumber(ARGV[1])
local prevCounter = tonumber(rec.counter) or 0
if nextCounter == 0 then
  if prevCounter ~= 0 then return 0 end
else
  if nextCounter <= prevCounter then return 0 end
end
rec.counter = nextCounter
if ARGV[2] ~= '' then
  rec.lastUsedAt = tonumber(ARGV[2])
end
redis.call('SET', KEYS[1], cjson.encode(rec))
return 1
`;

const LUA_CONSUME_PASSKEY_CHALLENGE = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local rec = cjson.decode(raw)
if rec.type ~= ARGV[1] then return nil end
redis.call('DEL', KEYS[1])
return raw
`;

function parseJson<T>(raw: string | null): T | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function toBooleanExists(value: number | boolean): boolean {
  return value === true || Number(value) > 0;
}

/**
 * Production Redis adapter implementing all six `@bunest/security/auth` storage contracts
 * (`sessions`, `refreshTokens`, `mfa`, `magicLinks`, `oidcStates`, `emailTokens`).
 *
 * Accepts a native `Bun.RedisClient` or any structural `RedisAuthClientLike` with
 * `get/set/del/sadd/srem/smembers/expire/exists`. Uses secondary user/family sets
 * for revoke-all and refresh-token reuse detection, TTL expiration, and atomic
 * Lua/GETDEL operations when supported by the client.
 */
@Injectable()
export class RedisAuthenticationStore
  implements
    SessionStore,
    RefreshTokenStore,
    MfaStore,
    MagicLinkStore,
    OidcStateStore,
    EmailTokenStore,
    PasskeyStore
{
  private readonly client: RedisAuthClientLike;
  private readonly prefix: string;
  private readonly revokedFamilyTtlSeconds: number;
  private readonly now: () => number;
  private readonly maxPending?: number;
  private readonly mutex = new PerKeyMutex();

  constructor(
    client: RedisAuthClientLike | Bun.RedisClient,
    options: RedisAuthenticationStoreOptions = {},
  ) {
    this.client = client as RedisAuthClientLike;
    this.prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.revokedFamilyTtlSeconds =
      options.revokedFamilyTtlSeconds ?? DEFAULT_REVOKED_FAMILY_TTL_SECONDS;
    this.now = options.now ?? (() => Date.now());
    if (
      options.maxPending !== undefined &&
      !(Number.isSafeInteger(options.maxPending) && options.maxPending > 0)
    ) {
      throw new TypeError(
        `RedisAuthenticationStore: maxPending must be a positive integer (got ${String(options.maxPending)})`,
      );
    }
    this.maxPending = options.maxPending;
  }

  /**
   * Returns an `AuthenticationStorageSources` mapping all seven contracts to this store,
   * ready to pass to `storage.registerSource(store.asSources())`.
   */
  asSources(): Required<AuthenticationStorageSources> {
    return {
      sessions: this,
      refreshTokens: this,
      mfa: this,
      magicLinks: this,
      oidcStates: this,
      emailTokens: this,
      passkeys: this,
    };
  }

  /**
   * Convenience helper registering all six authentication storage contracts into `AuthenticationStorage`.
   */
  registerInto(
    storage: AuthenticationStorage,
    options?: AuthenticationStorageRegisterOptions,
  ): void {
    storage.registerSource(this.asSources(), options);
  }

  // ------------------------------------------------------------------ Key builders

  private sessionKey(id: string): string {
    return `${this.prefix}session:${id}`;
  }

  private userSessionsKey(userId: string): string {
    return `${this.prefix}user_sessions:${userId}`;
  }

  private refreshTokenKey(id: string): string {
    return `${this.prefix}rt:${id}`;
  }

  private refreshFamilyTokensKey(familyId: string): string {
    return `${this.prefix}rt_family:${familyId}`;
  }

  private userRefreshFamiliesKey(userId: string): string {
    return `${this.prefix}rt_user_families:${userId}`;
  }

  private revokedFamilyKey(familyId: string): string {
    return `${this.prefix}rt_revoked_family:${familyId}`;
  }

  private totpKey(userId: string): string {
    return `${this.prefix}mfa_totp:${userId}`;
  }

  private recoveryCodesKey(userId: string): string {
    return `${this.prefix}mfa_recovery:${userId}`;
  }

  private mfaFailuresKey(userId: string): string {
    return `${this.prefix}mfa_failures:${userId}`;
  }

  private magicLinkKey(id: string): string {
    return `${this.prefix}magic_link:${id}`;
  }

  private magicLinksIndexKey(): string {
    return `${this.prefix}magic_links:index`;
  }

  private oidcStateKey(state: string): string {
    return `${this.prefix}oidc_state:${state}`;
  }

  private oidcStatesIndexKey(): string {
    return `${this.prefix}oidc_states:index`;
  }

  private emailTokenKey(id: string): string {
    return `${this.prefix}email_token:${id}`;
  }

  private emailTokensIndexKey(): string {
    return `${this.prefix}email_tokens:index`;
  }

  private userEmailTokensKey(
    userId: string,
    purpose: EmailTokenPurpose,
  ): string {
    return `${this.prefix}email_tokens_user:${purpose}:${userId}`;
  }

  private passkeyKey(credentialId: string): string {
    return `${this.prefix}passkey:${credentialId}`;
  }

  private userPasskeysKey(userId: string): string {
    return `${this.prefix}user_passkeys:${userId}`;
  }

  private passkeyChallengeKey(challenge: string): string {
    return `${this.prefix}passkey_challenge:${challenge}`;
  }

  // ------------------------------------------------------------------ Helpers

  private computeTtlSeconds(
    expiresAt: Date,
    createdAt?: Date,
  ): number | undefined {
    const remainingMs = expiresAt.getTime() - this.now();
    if (remainingMs > 0) {
      return Math.max(1, Math.ceil(remainingMs / 1000));
    }
    // Preserve positive TTL when callers use a deterministic/historical test clock.
    if (createdAt) {
      const lifetimeMs = expiresAt.getTime() - createdAt.getTime();
      if (lifetimeMs > 0) {
        return Math.max(1, Math.ceil(lifetimeMs / 1000));
      }
    }
    return undefined;
  }

  private async setWithTtl(
    key: string,
    value: string,
    ttlSeconds: number | undefined,
  ): Promise<void> {
    await this.client.set(key, value);
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.client.expire(key, ttlSeconds);
    }
  }

  private async tryEval(
    script: string,
    keys: string[],
    args: string[],
  ): Promise<{ supported: true; value: unknown } | { supported: false }> {
    if (typeof this.client.send !== "function") {
      return { supported: false };
    }
    try {
      const value = await this.client.send("EVAL", [
        script,
        String(keys.length),
        ...keys,
        ...args,
      ]);
      return { supported: true, value };
    } catch {
      return { supported: false };
    }
  }

  private async atomicGetDel(key: string): Promise<string | null> {
    if (typeof this.client.getdel === "function") {
      return this.client.getdel(key);
    }
    return this.mutex.run(key, async () => {
      const raw = await this.client.get(key);
      if (raw === null) {
        return null;
      }
      const deleted = await this.client.del(key);
      return deleted > 0 ? raw : null;
    });
  }

  private deserializeSession(raw: string | null): SessionRecord | undefined {
    const data = parseJson<SerializedSession>(raw);
    if (!data) {
      return undefined;
    }
    const record: SessionRecord = {
      id: data.id,
      userId: data.userId,
      createdAt: new Date(data.createdAt),
      expiresAt: new Date(data.expiresAt),
      lastActiveAt: new Date(data.lastActiveAt),
    };
    if (data.mfa !== undefined) {
      record.mfa = data.mfa;
    }
    if (data.metadata !== undefined) {
      record.metadata = structuredClone(data.metadata);
    }
    return record;
  }

  private deserializeRefreshToken(
    raw: string | null,
  ): RefreshTokenRecord | undefined {
    const data = parseJson<SerializedRefreshToken>(raw);
    if (!data) {
      return undefined;
    }
    const record: RefreshTokenRecord = {
      id: data.id,
      familyId: data.familyId,
      userId: data.userId,
      createdAt: new Date(data.createdAt),
      expiresAt: new Date(data.expiresAt),
      familyExpiresAt: new Date(data.familyExpiresAt),
    };
    if (data.usedAt !== undefined) {
      record.usedAt = new Date(data.usedAt);
    }
    if (data.claims !== undefined) {
      record.claims = structuredClone(data.claims);
    }
    return record;
  }

  private deserializeMagicLink(
    raw: string | null,
  ): MagicLinkRecord | undefined {
    const data = parseJson<SerializedMagicLink>(raw);
    if (!data) {
      return undefined;
    }
    const record: MagicLinkRecord = {
      id: data.id,
      email: data.email,
      createdAt: new Date(data.createdAt),
      expiresAt: new Date(data.expiresAt),
    };
    if (data.redirectTo !== undefined) {
      record.redirectTo = data.redirectTo;
    }
    return record;
  }

  private deserializeOidcTransaction(
    raw: string | null,
  ): OidcTransaction | undefined {
    const data = parseJson<SerializedOidcTransaction>(raw);
    if (!data) {
      return undefined;
    }
    const record: OidcTransaction = {
      state: data.state,
      provider: data.provider,
      codeVerifier: data.codeVerifier,
      createdAt: new Date(data.createdAt),
      expiresAt: new Date(data.expiresAt),
    };
    if (data.nonce !== undefined) {
      record.nonce = data.nonce;
    }
    if (data.redirectTo !== undefined) {
      record.redirectTo = data.redirectTo;
    }
    if (data.link !== undefined) {
      record.link = { ...data.link };
    }
    return record;
  }

  private deserializeEmailToken(
    raw: string | null,
  ): EmailTokenRecord | undefined {
    const data = parseJson<SerializedEmailToken>(raw);
    if (!data) {
      return undefined;
    }
    const record: EmailTokenRecord = {
      id: data.id,
      purpose: data.purpose,
      userId: data.userId,
      email: data.email,
      createdAt: new Date(data.createdAt),
      expiresAt: new Date(data.expiresAt),
    };
    if (data.fingerprint !== undefined) {
      record.fingerprint = data.fingerprint;
    }
    return record;
  }

  private async prunePendingIndex(
    indexKey: string,
    itemKey: (id: string) => string,
    cutoffMs: number,
    onEvict?: (id: string, parsed: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const ids = await this.client.smembers(indexKey);
    if (ids.length === 0) {
      return;
    }
    const live: Array<{
      id: string;
      expiresAt: number;
      parsed: Record<string, unknown>;
    }> = [];
    const expiredIds: string[] = [];

    for (const id of ids) {
      const raw = await this.client.get(itemKey(id));
      const parsed = parseJson<Record<string, unknown>>(raw);
      if (!parsed || typeof parsed.expiresAt !== "number") {
        expiredIds.push(id);
        continue;
      }
      if (parsed.expiresAt <= cutoffMs) {
        expiredIds.push(id);
        await this.client.del(itemKey(id));
        if (onEvict) {
          await onEvict(id, parsed);
        }
      } else {
        live.push({ id, expiresAt: parsed.expiresAt, parsed });
      }
    }

    if (expiredIds.length > 0) {
      await this.client.srem(indexKey, ...expiredIds);
    }

    if (this.maxPending !== undefined && live.length > this.maxPending) {
      live.sort((a, b) => a.expiresAt - b.expiresAt);
      const excess = live.slice(0, live.length - this.maxPending);
      const excessIds = excess.map((e) => e.id);
      for (const entry of excess) {
        await this.client.del(itemKey(entry.id));
        if (onEvict) {
          await onEvict(entry.id, entry.parsed);
        }
      }
      if (excessIds.length > 0) {
        await this.client.srem(indexKey, ...excessIds);
      }
    }
  }

  // ------------------------------------------------------------------ SessionStore

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const raw = await this.client.get(this.sessionKey(id));
    return this.deserializeSession(raw);
  }

  async createSession(record: SessionRecord): Promise<void> {
    const key = this.sessionKey(record.id);
    const userKey = this.userSessionsKey(record.userId);
    const serialized: SerializedSession = {
      id: record.id,
      userId: record.userId,
      createdAt: record.createdAt.getTime(),
      expiresAt: record.expiresAt.getTime(),
      lastActiveAt: record.lastActiveAt.getTime(),
      ...(record.mfa !== undefined ? { mfa: record.mfa } : {}),
      ...(record.metadata !== undefined
        ? { metadata: structuredClone(record.metadata) }
        : {}),
    };
    const ttl = this.computeTtlSeconds(record.expiresAt, record.createdAt);

    await this.mutex.run(key, async () => {
      await this.setWithTtl(key, JSON.stringify(serialized), ttl);
      await this.client.sadd(userKey, record.id);
      if (ttl !== undefined && ttl > 0) {
        await this.client.expire(userKey, ttl);
      }
    });
  }

  async touchSession(id: string, lastActiveAt: Date): Promise<void> {
    const key = this.sessionKey(id);
    const nextMs = lastActiveAt.getTime();

    const evalRes = await this.tryEval(LUA_TOUCH_SESSION, [key], [String(nextMs)]);
    if (evalRes.supported) {
      return;
    }

    await this.mutex.run(key, async () => {
      const raw = await this.client.get(key);
      const data = parseJson<SerializedSession>(raw);
      if (!data || data.lastActiveAt >= nextMs) {
        return;
      }
      data.lastActiveAt = nextMs;
      const ttl = this.computeTtlSeconds(
        new Date(data.expiresAt),
        new Date(data.createdAt),
      );
      await this.setWithTtl(key, JSON.stringify(data), ttl);
    });
  }

  async deleteSession(id: string): Promise<boolean> {
    const key = this.sessionKey(id);
    return this.mutex.run(key, async () => {
      const existing = parseJson<SerializedSession>(await this.client.get(key));
      const deleted = await this.client.del(key);
      if (existing) {
        await this.client.srem(this.userSessionsKey(existing.userId), id);
      }
      return deleted > 0;
    });
  }

  async listUserSessions(userId: string): Promise<SessionRecord[]> {
    const userKey = this.userSessionsKey(userId);
    const ids = await this.client.smembers(userKey);
    if (ids.length === 0) {
      return [];
    }
    const sessions: SessionRecord[] = [];
    const stale: string[] = [];

    for (const id of ids) {
      const record = await this.getSession(id);
      if (record) {
        sessions.push(record);
      } else {
        stale.push(id);
      }
    }

    if (stale.length > 0) {
      await this.client.srem(userKey, ...stale);
    }

    return sessions;
  }

  async deleteUserSessions(userId: string): Promise<void> {
    const userKey = this.userSessionsKey(userId);
    const ids = await this.client.smembers(userKey);
    for (const id of ids) {
      const key = this.sessionKey(id);
      await this.mutex.run(key, async () => {
        await this.client.del(key);
        await this.client.srem(userKey, id);
      });
    }
  }

  // ------------------------------------------------------------------ RefreshTokenStore

  async getRefreshToken(id: string): Promise<RefreshTokenRecord | undefined> {
    const raw = await this.client.get(this.refreshTokenKey(id));
    return this.deserializeRefreshToken(raw);
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    const key = this.refreshTokenKey(record.id);
    const familyKey = this.refreshFamilyTokensKey(record.familyId);
    const userFamiliesKey = this.userRefreshFamiliesKey(record.userId);
    const serialized: SerializedRefreshToken = {
      id: record.id,
      familyId: record.familyId,
      userId: record.userId,
      createdAt: record.createdAt.getTime(),
      expiresAt: record.expiresAt.getTime(),
      familyExpiresAt: record.familyExpiresAt.getTime(),
      ...(record.usedAt !== undefined ? { usedAt: record.usedAt.getTime() } : {}),
      ...(record.claims !== undefined
        ? { claims: structuredClone(record.claims) }
        : {}),
    };
    const ttl = this.computeTtlSeconds(record.familyExpiresAt, record.createdAt);

    await this.mutex.run(key, async () => {
      await this.setWithTtl(key, JSON.stringify(serialized), ttl);
      await this.client.sadd(familyKey, record.id);
      await this.client.sadd(userFamiliesKey, record.familyId);
      if (ttl !== undefined && ttl > 0) {
        await this.client.expire(familyKey, ttl);
        await this.client.expire(userFamiliesKey, ttl);
      }
    });
  }

  async markRefreshTokenUsed(id: string, at: Date): Promise<boolean> {
    const key = this.refreshTokenKey(id);
    const atMs = at.getTime();

    const evalRes = await this.tryEval(
      LUA_MARK_REFRESH_USED,
      [key],
      [String(atMs)],
    );
    if (evalRes.supported) {
      return Number(evalRes.value) === 1;
    }

    return this.mutex.run(key, async () => {
      const raw = await this.client.get(key);
      const data = parseJson<SerializedRefreshToken>(raw);
      if (!data || data.usedAt !== undefined) {
        return false;
      }
      data.usedAt = atMs;
      const ttl = this.computeTtlSeconds(
        new Date(data.familyExpiresAt),
        new Date(data.createdAt),
      );
      await this.setWithTtl(key, JSON.stringify(data), ttl);
      return true;
    });
  }

  async revokeRefreshTokenFamily(familyId: string): Promise<void> {
    const key = this.revokedFamilyKey(familyId);
    await this.setWithTtl(key, "1", this.revokedFamilyTtlSeconds);
  }

  async isRefreshTokenFamilyRevoked(familyId: string): Promise<boolean> {
    const exists = await this.client.exists(this.revokedFamilyKey(familyId));
    return toBooleanExists(exists);
  }

  async revokeUserRefreshTokens(userId: string): Promise<void> {
    const userFamiliesKey = this.userRefreshFamiliesKey(userId);
    const families = await this.client.smembers(userFamiliesKey);
    for (const familyId of families) {
      await this.revokeRefreshTokenFamily(familyId);
    }
    if (families.length > 0) {
      await this.client.srem(userFamiliesKey, ...families);
    }
  }

  // ------------------------------------------------------------------ MfaStore

  async getTotp(userId: string): Promise<TotpRecord | undefined> {
    const data = parseJson<TotpRecord>(await this.client.get(this.totpKey(userId)));
    if (!data) {
      return undefined;
    }
    const record: TotpRecord = {
      secret: data.secret,
      confirmed: Boolean(data.confirmed),
    };
    if (data.pendingSecret !== undefined) {
      record.pendingSecret = data.pendingSecret;
    }
    if (data.lastUsedStep !== undefined) {
      record.lastUsedStep = data.lastUsedStep;
    }
    return record;
  }

  async saveTotp(userId: string, record: TotpRecord | null): Promise<void> {
    const key = this.totpKey(userId);
    if (!record) {
      await this.mutex.run(key, async () => {
        await this.client.del(key);
      });
      return;
    }

    const incoming: TotpRecord = {
      secret: record.secret,
      confirmed: record.confirmed,
      ...(record.pendingSecret !== undefined
        ? { pendingSecret: record.pendingSecret }
        : {}),
      ...(record.lastUsedStep !== undefined
        ? { lastUsedStep: record.lastUsedStep }
        : {}),
    };

    const evalRes = await this.tryEval(
      LUA_SAVE_TOTP,
      [key],
      [JSON.stringify(incoming)],
    );
    if (evalRes.supported) {
      return;
    }

    await this.mutex.run(key, async () => {
      const existing = parseJson<TotpRecord>(await this.client.get(key));
      const claimed = existing?.lastUsedStep;
      const maxStep = Math.max(
        claimed ?? -Infinity,
        incoming.lastUsedStep ?? -Infinity,
      );
      const { lastUsedStep: _ignored, ...rest } = incoming;
      const merged: TotpRecord = {
        ...rest,
        ...(Number.isFinite(maxStep) ? { lastUsedStep: maxStep } : {}),
      };
      await this.client.set(key, JSON.stringify(merged));
    });
  }

  async claimTotpStep(userId: string, step: number): Promise<boolean> {
    const key = this.totpKey(userId);

    const evalRes = await this.tryEval(
      LUA_CLAIM_TOTP_STEP,
      [key],
      [String(step)],
    );
    if (evalRes.supported) {
      return Number(evalRes.value) === 1;
    }

    return this.mutex.run(key, async () => {
      const existing = parseJson<TotpRecord>(await this.client.get(key));
      if (
        !existing ||
        (existing.lastUsedStep !== undefined && step <= existing.lastUsedStep)
      ) {
        return false;
      }
      const next: TotpRecord = { ...existing, lastUsedStep: step };
      await this.client.set(key, JSON.stringify(next));
      return true;
    });
  }

  async saveRecoveryCodes(userId: string, hashes: string[]): Promise<void> {
    const key = this.recoveryCodesKey(userId);
    await this.mutex.run(key, async () => {
      await this.client.del(key);
      if (hashes.length > 0) {
        await this.client.sadd(key, ...hashes);
      }
    });
  }

  async consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
    const removed = await this.client.srem(this.recoveryCodesKey(userId), hash);
    return removed > 0;
  }

  async countRecoveryCodes(userId: string): Promise<number> {
    const members = await this.client.smembers(this.recoveryCodesKey(userId));
    return members.length;
  }

  async recordMfaFailure(
    userId: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    const key = this.mfaFailuresKey(userId);
    const entry = `${now}:${crypto.randomUUID()}`;
    // Record attempt BEFORE counting so parallel guesses never share a low count.
    await this.client.sadd(key, entry);
    const ttlSeconds = Math.max(1, Math.ceil(windowMs / 1000) + 60);
    await this.client.expire(key, ttlSeconds);

    const members = await this.client.smembers(key);
    const cutoff = now - windowMs;
    const expired: string[] = [];
    let count = 0;

    for (const member of members) {
      const colonIdx = member.indexOf(":");
      const ts = Number(colonIdx === -1 ? member : member.slice(0, colonIdx));
      if (!Number.isFinite(ts) || ts <= cutoff) {
        expired.push(member);
      } else {
        count++;
      }
    }

    if (expired.length > 0) {
      await this.client.srem(key, ...expired);
    }

    return count;
  }

  async countMfaFailures(
    userId: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    const members = await this.client.smembers(this.mfaFailuresKey(userId));
    const cutoff = now - windowMs;
    let count = 0;
    for (const member of members) {
      const colonIdx = member.indexOf(":");
      const ts = Number(colonIdx === -1 ? member : member.slice(0, colonIdx));
      if (Number.isFinite(ts) && ts > cutoff) {
        count++;
      }
    }
    return count;
  }

  async clearMfaFailures(userId: string): Promise<void> {
    await this.client.del(this.mfaFailuresKey(userId));
  }

  // ------------------------------------------------------------------ MagicLinkStore

  async saveMagicLink(record: MagicLinkRecord): Promise<void> {
    const indexKey = this.magicLinksIndexKey();
    const key = this.magicLinkKey(record.id);
    const serialized: SerializedMagicLink = {
      id: record.id,
      email: record.email,
      createdAt: record.createdAt.getTime(),
      expiresAt: record.expiresAt.getTime(),
      ...(record.redirectTo !== undefined
        ? { redirectTo: record.redirectTo }
        : {}),
    };
    const ttl = this.computeTtlSeconds(record.expiresAt, record.createdAt);

    await this.mutex.run(indexKey, async () => {
      await this.setWithTtl(key, JSON.stringify(serialized), ttl);
      await this.client.sadd(indexKey, record.id);
      await this.prunePendingIndex(
        indexKey,
        (id) => this.magicLinkKey(id),
        record.createdAt.getTime(),
      );
    });
  }

  async consumeMagicLink(id: string): Promise<MagicLinkRecord | undefined> {
    const raw = await this.atomicGetDel(this.magicLinkKey(id));
    await this.client.srem(this.magicLinksIndexKey(), id);
    return this.deserializeMagicLink(raw);
  }

  // ------------------------------------------------------------------ OidcStateStore

  async saveOidcState(transaction: OidcTransaction): Promise<void> {
    const indexKey = this.oidcStatesIndexKey();
    const key = this.oidcStateKey(transaction.state);
    const serialized: SerializedOidcTransaction = {
      state: transaction.state,
      provider: transaction.provider,
      codeVerifier: transaction.codeVerifier,
      createdAt: transaction.createdAt.getTime(),
      expiresAt: transaction.expiresAt.getTime(),
      ...(transaction.nonce !== undefined ? { nonce: transaction.nonce } : {}),
      ...(transaction.redirectTo !== undefined
        ? { redirectTo: transaction.redirectTo }
        : {}),
      ...(transaction.link !== undefined
        ? { link: { ...transaction.link } }
        : {}),
    };
    const ttl = this.computeTtlSeconds(
      transaction.expiresAt,
      transaction.createdAt,
    );

    await this.mutex.run(indexKey, async () => {
      await this.setWithTtl(key, JSON.stringify(serialized), ttl);
      await this.client.sadd(indexKey, transaction.state);
      await this.prunePendingIndex(
        indexKey,
        (state) => this.oidcStateKey(state),
        transaction.createdAt.getTime(),
      );
    });
  }

  async consumeOidcState(state: string): Promise<OidcTransaction | undefined> {
    const raw = await this.atomicGetDel(this.oidcStateKey(state));
    await this.client.srem(this.oidcStatesIndexKey(), state);
    return this.deserializeOidcTransaction(raw);
  }

  // ------------------------------------------------------------------ EmailTokenStore

  async saveEmailToken(record: EmailTokenRecord): Promise<void> {
    const indexKey = this.emailTokensIndexKey();
    const key = this.emailTokenKey(record.id);
    const userKey = this.userEmailTokensKey(record.userId, record.purpose);
    const serialized: SerializedEmailToken = {
      id: record.id,
      purpose: record.purpose,
      userId: record.userId,
      email: record.email,
      createdAt: record.createdAt.getTime(),
      expiresAt: record.expiresAt.getTime(),
      ...(record.fingerprint !== undefined
        ? { fingerprint: record.fingerprint }
        : {}),
    };
    const ttl = this.computeTtlSeconds(record.expiresAt, record.createdAt);

    await this.mutex.run(indexKey, async () => {
      await this.setWithTtl(key, JSON.stringify(serialized), ttl);
      await this.client.sadd(indexKey, record.id);
      await this.client.sadd(userKey, record.id);
      if (ttl !== undefined && ttl > 0) {
        await this.client.expire(userKey, ttl);
      }
      await this.prunePendingIndex(
        indexKey,
        (id) => this.emailTokenKey(id),
        record.createdAt.getTime(),
        async (id, parsed) => {
          if (
            typeof parsed.userId === "string" &&
            (parsed.purpose === "password-reset" ||
              parsed.purpose === "email-verification")
          ) {
            await this.client.srem(
              this.userEmailTokensKey(parsed.userId, parsed.purpose),
              id,
            );
          }
        },
      );
    });
  }

  async consumeEmailToken(
    id: string,
    purpose: EmailTokenPurpose,
  ): Promise<EmailTokenRecord | undefined> {
    const key = this.emailTokenKey(id);

    const evalRes = await this.tryEval(LUA_CONSUME_EMAIL_TOKEN, [key], [purpose]);
    if (evalRes.supported) {
      const raw = typeof evalRes.value === "string" ? evalRes.value : null;
      const record = this.deserializeEmailToken(raw);
      if (record) {
        await this.client.srem(this.emailTokensIndexKey(), id);
        await this.client.srem(
          this.userEmailTokensKey(record.userId, record.purpose),
          id,
        );
      }
      return record;
    }

    return this.mutex.run(key, async () => {
      const raw = await this.client.get(key);
      const record = this.deserializeEmailToken(raw);
      if (!record || record.purpose !== purpose) {
        return undefined;
      }
      const deleted = await this.client.del(key);
      if (deleted === 0) {
        return undefined;
      }
      await this.client.srem(this.emailTokensIndexKey(), id);
      await this.client.srem(
        this.userEmailTokensKey(record.userId, record.purpose),
        id,
      );
      return record;
    });
  }

  async deleteUserEmailTokens(
    userId: string,
    purpose: EmailTokenPurpose,
  ): Promise<void> {
    const userKey = this.userEmailTokensKey(userId, purpose);
    const ids = await this.client.smembers(userKey);
    for (const id of ids) {
      const key = this.emailTokenKey(id);
      await this.mutex.run(key, async () => {
        await this.client.del(key);
        await this.client.srem(this.emailTokensIndexKey(), id);
        await this.client.srem(userKey, id);
      });
    }
  }

  // ------------------------------------------------------------------ PasskeyStore

  private deserializePasskey(
    raw: string | null,
  ): PasskeyCredential | undefined {
    const data = parseJson<SerializedPasskeyCredential>(raw);
    if (!data) {
      return undefined;
    }
    const record: PasskeyCredential = {
      id: data.id,
      userId: data.userId,
      publicKey: data.publicKey,
      algorithm: data.algorithm,
      counter: data.counter,
      createdAt: new Date(data.createdAt),
    };
    if (Array.isArray(data.transports)) {
      record.transports = [...data.transports];
    } else if (
      data.transports !== undefined &&
      typeof data.transports === "object" &&
      data.transports !== null &&
      Object.keys(data.transports as Record<string, unknown>).length === 0
    ) {
      // Redis Lua cjson encodes empty arrays `[]` as `{}` on decode/re-encode round-trips.
      record.transports = [];
    }
    if (data.deviceType !== undefined) {
      record.deviceType = data.deviceType;
    }
    if (data.backedUp !== undefined) {
      record.backedUp = data.backedUp;
    }
    if (data.aaguid !== undefined) {
      record.aaguid = data.aaguid;
    }
    if (data.name !== undefined) {
      record.name = data.name;
    }
    if (data.lastUsedAt !== undefined) {
      record.lastUsedAt = new Date(data.lastUsedAt);
    }
    return record;
  }

  private deserializePasskeyChallenge(
    raw: string | null,
  ): PasskeyChallengeRecord | undefined {
    const data = parseJson<SerializedPasskeyChallenge>(raw);
    if (!data) {
      return undefined;
    }
    const record: PasskeyChallengeRecord = {
      challenge: data.challenge,
      type: data.type,
      createdAt: new Date(data.createdAt),
      expiresAt: new Date(data.expiresAt),
    };
    if (data.userId !== undefined) {
      record.userId = data.userId;
    }
    return record;
  }

  async getPasskey(
    credentialId: string,
  ): Promise<PasskeyCredential | undefined> {
    const raw = await this.client.get(this.passkeyKey(credentialId));
    return this.deserializePasskey(raw);
  }

  async savePasskey(credential: PasskeyCredential): Promise<void> {
    const key = this.passkeyKey(credential.id);
    const serialized: SerializedPasskeyCredential = {
      id: credential.id,
      userId: credential.userId,
      publicKey: credential.publicKey,
      algorithm: credential.algorithm,
      counter: credential.counter,
      createdAt: credential.createdAt.getTime(),
      ...(credential.transports !== undefined
        ? { transports: [...credential.transports] }
        : {}),
      ...(credential.deviceType !== undefined
        ? { deviceType: credential.deviceType }
        : {}),
      ...(credential.backedUp !== undefined
        ? { backedUp: credential.backedUp }
        : {}),
      ...(credential.aaguid !== undefined ? { aaguid: credential.aaguid } : {}),
      ...(credential.name !== undefined ? { name: credential.name } : {}),
      ...(credential.lastUsedAt !== undefined
        ? { lastUsedAt: credential.lastUsedAt.getTime() }
        : {}),
    };

    await this.mutex.run(key, async () => {
      const existing = parseJson<SerializedPasskeyCredential>(
        await this.client.get(key),
      );
      if (existing && existing.userId !== credential.userId) {
        await this.client.srem(
          this.userPasskeysKey(existing.userId),
          credential.id,
        );
      }
      await this.client.set(key, JSON.stringify(serialized));
      await this.client.sadd(
        this.userPasskeysKey(credential.userId),
        credential.id,
      );
    });
  }

  async listUserPasskeys(userId: string): Promise<PasskeyCredential[]> {
    const userKey = this.userPasskeysKey(userId);
    const ids = await this.client.smembers(userKey);
    if (ids.length === 0) {
      return [];
    }
    const results: PasskeyCredential[] = [];
    const stale: string[] = [];
    for (const id of ids) {
      const cred = await this.getPasskey(id);
      if (cred) {
        results.push(cred);
      } else {
        stale.push(id);
      }
    }
    if (stale.length > 0) {
      await this.client.srem(userKey, ...stale);
    }
    return results;
  }

  async updatePasskeyCounter(
    credentialId: string,
    counter: number,
    lastUsedAt?: Date,
  ): Promise<boolean> {
    const key = this.passkeyKey(credentialId);
    const lastUsedStr = lastUsedAt ? String(lastUsedAt.getTime()) : "";

    const evalRes = await this.tryEval(
      LUA_UPDATE_PASSKEY_COUNTER,
      [key],
      [String(counter), lastUsedStr],
    );
    if (evalRes.supported) {
      return Number(evalRes.value) === 1;
    }

    return this.mutex.run(key, async () => {
      const existing = parseJson<SerializedPasskeyCredential>(
        await this.client.get(key),
      );
      if (!existing) {
        return false;
      }
      if (counter === 0) {
        if (existing.counter !== 0) {
          return false;
        }
      } else if (counter <= existing.counter) {
        return false;
      }
      existing.counter = counter;
      if (lastUsedAt !== undefined) {
        existing.lastUsedAt = lastUsedAt.getTime();
      }
      await this.client.set(key, JSON.stringify(existing));
      return true;
    });
  }

  async deletePasskey(credentialId: string): Promise<boolean> {
    const key = this.passkeyKey(credentialId);
    return this.mutex.run(key, async () => {
      const existing = parseJson<SerializedPasskeyCredential>(
        await this.client.get(key),
      );
      const deleted = await this.client.del(key);
      if (existing) {
        await this.client.srem(
          this.userPasskeysKey(existing.userId),
          credentialId,
        );
      }
      return deleted > 0;
    });
  }

  async deleteUserPasskeys(userId: string): Promise<void> {
    const userKey = this.userPasskeysKey(userId);
    const ids = await this.client.smembers(userKey);
    for (const id of ids) {
      const key = this.passkeyKey(id);
      await this.mutex.run(key, async () => {
        await this.client.del(key);
        await this.client.srem(userKey, id);
      });
    }
  }

  async savePasskeyChallenge(record: PasskeyChallengeRecord): Promise<void> {
    const key = this.passkeyChallengeKey(record.challenge);
    const serialized: SerializedPasskeyChallenge = {
      challenge: record.challenge,
      type: record.type,
      createdAt: record.createdAt.getTime(),
      expiresAt: record.expiresAt.getTime(),
      ...(record.userId !== undefined ? { userId: record.userId } : {}),
    };
    const ttl = this.computeTtlSeconds(record.expiresAt, record.createdAt);
    await this.setWithTtl(key, JSON.stringify(serialized), ttl);
  }

  async consumePasskeyChallenge(
    challenge: string,
    type: PasskeyChallengeType,
  ): Promise<PasskeyChallengeRecord | undefined> {
    const key = this.passkeyChallengeKey(challenge);

    const evalRes = await this.tryEval(
      LUA_CONSUME_PASSKEY_CHALLENGE,
      [key],
      [type],
    );
    if (evalRes.supported) {
      const raw = typeof evalRes.value === "string" ? evalRes.value : null;
      return this.deserializePasskeyChallenge(raw);
    }

    return this.mutex.run(key, async () => {
      const raw = await this.client.get(key);
      const record = this.deserializePasskeyChallenge(raw);
      if (!record || record.type !== type) {
        return undefined;
      }
      const deleted = await this.client.del(key);
      return deleted > 0 ? record : undefined;
    });
  }
}
