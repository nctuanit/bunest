import { randomBytes } from "node:crypto";
import type { ExecutionContext } from "@bunest/common";
import { AuthenticationError } from "../errors/authentication.error";
import type {
  ApiKeyProviderOptions,
  ApiKeyRecord,
  ApiKeySession,
  GeneratedApiKey,
} from "../interfaces/api-key.interface";
import type { AuthenticationResult } from "../interfaces/authentication-result.interface";
import {
  API_KEY_PATTERN,
  API_KEY_PREFIX_PATTERN,
} from "../utils/api-key.util";
import { bearerToken } from "../utils/bearer.util";
import { randomToken, safeEqual, sha256 } from "../utils/crypto.util";
import { hasExpired } from "../utils/duration.util";
import { AuthenticationProvider } from "./authentication.provider";

const NO_KEY = sha256("");

/**
 * Base class for API keys: `Authorization: Bearer <prefix>_<id>_<secret>`.
 */
export abstract class ApiKeyProvider<TUser> extends AuthenticationProvider<
  TUser,
  ApiKeySession
> {
  private readonly prefix: string;
  private readonly realm: string;
  private readonly now: () => number;

  constructor({ prefix, realm = "api", now = Date.now }: ApiKeyProviderOptions) {
    super();
    if (typeof prefix !== "string" || !API_KEY_PREFIX_PATTERN.test(prefix)) {
      throw new TypeError(
        `${new.target.name}: \`prefix\` must be 1-16 lowercase letters and digits, starting with a letter ` +
          `(e.g. 'cat' for cat_<id>_<secret>), got ${JSON.stringify(prefix)}.`,
      );
    }
    this.prefix = prefix;
    this.realm = realm;
    this.now = now;
  }

  protected abstract findKey(
    id: string,
  ):
    | ApiKeyRecord<TUser>
    | null
    | undefined
    | Promise<ApiKeyRecord<TUser> | null | undefined>;

  /** A new key with this provider's prefix. */
  generate(): GeneratedApiKey {
    const id = randomBytes(8).toString("hex");
    const key = `${this.prefix}_${id}_${randomToken()}`;
    return { key, id, hash: sha256(key) };
  }

  async authenticate(
    context: ExecutionContext,
  ): Promise<AuthenticationResult<TUser, ApiKeySession> | null> {
    const token = bearerToken(context, this.header(context, "authorization"));
    if (token === null) {
      this.reject("malformed authorization header");
    }
    if (token === undefined || !token.startsWith(`${this.prefix}_`)) {
      return null;
    }
    const match = API_KEY_PATTERN.exec(token);
    if (!match) {
      this.reject("malformed api key");
    }
    const id = match[2]!;
    const record = await this.findKey(id);
    const matches = safeEqual(
      sha256(token),
      typeof record?.hash === "string" ? record.hash : NO_KEY,
    );
    if (
      !record ||
      !matches ||
      record.user === null ||
      record.user === undefined
    ) {
      this.reject("invalid api key");
    }
    const expiresAt = record.expiresAt ?? undefined;
    if (expiresAt && hasExpired(expiresAt, this.now())) {
      this.reject("api key expired");
    }
    const session: ApiKeySession = {
      method: "api-key",
      keyId: id,
      ...(expiresAt ? { expiresAt } : {}),
    };
    return { user: record.user, session };
  }

  override challenge(): string {
    return `Bearer realm="${this.realm}"`;
  }

  private reject(description: string): never {
    throw new AuthenticationError(description, {
      challenge: `Bearer realm="${this.realm}", error="invalid_token", error_description="${description}"`,
    });
  }
}
