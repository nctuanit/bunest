import { createPublicKey, type KeyObject } from "node:crypto";
import { JwtError } from "../errors/jwt.error";
import type { JwksClientOptions } from "../interfaces/jwks-client-options.interface";
import type { JwsAlgorithm } from "../interfaces/jwt.interface";
import { durationOr } from "../utils/duration.util";
import { ASYMMETRIC_ALGORITHMS, type JwsHeader } from "./jws.util";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const EC_ALGORITHMS: Record<string, JwsAlgorithm> = {
  "P-256": "ES256",
  "P-384": "ES384",
  "P-521": "ES512",
};

function algorithmsFor(jwk: Record<string, unknown>): JwsAlgorithm[] {
  if (jwk.kty === "RSA") {
    return ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512"];
  }
  if (
    jwk.kty === "EC" &&
    typeof jwk.crv === "string" &&
    EC_ALGORITHMS[jwk.crv]
  ) {
    return [EC_ALGORITHMS[jwk.crv]!];
  }
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
    return ["EdDSA"];
  }
  return [];
}

interface CachedJwk {
  kid?: string;
  alg?: string;
  algorithms: JwsAlgorithm[];
  key: KeyObject;
}

/**
 * A cached JSON Web Key Set, shared by bearer-token verification and OIDC ID tokens.
 */
export class JwksClient {
  readonly uri: string;
  private keys: CachedJwk[] = [];
  private fetchedAt = -Infinity;
  private attemptedAt = -Infinity;
  private failure?: Error;
  private inflight?: Promise<void>;
  private readonly options: {
    cacheTtl: number;
    cooldown: number;
    timeout: number;
    fetch?: typeof fetch;
    now?: () => number;
  };
  /** Number of network fetches, for tests and metrics. */
  fetchCount = 0;

  constructor(uri: string, options: JwksClientOptions = {}) {
    this.uri = uri;
    let url: URL | undefined;
    try {
      url = new URL(uri);
    } catch {
      url = undefined;
    }
    if (
      !url ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))
    ) {
      throw new TypeError(
        `JwksClient: the key set must be an https URL (http only on loopback), got ${JSON.stringify(uri)}.`,
      );
    }
    this.options = {
      fetch: options.fetch,
      now: options.now,
      cacheTtl: durationOr(options.cacheTtl, "10m"),
      cooldown: durationOr(options.cooldown, "30s"),
      timeout: durationOr(options.timeout, "5s"),
    };
  }

  async getKey(header: Pick<JwsHeader, "alg" | "kid">): Promise<KeyObject> {
    const alg = header.alg as JwsAlgorithm;
    if (!ASYMMETRIC_ALGORITHMS.includes(alg)) {
      throw new JwtError("unsupported algorithm");
    }
    if (this.now() - this.fetchedAt >= this.options.cacheTtl) {
      await this.refresh(true);
    }
    let found = this.find(header.kid, alg);
    if (!found && this.now() - this.attemptedAt >= this.options.cooldown) {
      await this.refresh(false);
      found = this.find(header.kid, alg);
    }
    if (!found) {
      throw new JwtError("no matching key");
    }
    return found;
  }

  private find(kid: string | undefined, alg: JwsAlgorithm): KeyObject | undefined {
    const candidates = this.keys.filter(
      (k) => k.algorithms.includes(alg) && (!k.alg || k.alg === alg),
    );
    if (kid !== undefined) {
      return candidates.find((k) => k.kid === kid)?.key;
    }
    return candidates.length === 1 ? candidates[0]!.key : undefined;
  }

  private refresh(expired: boolean): Promise<void> {
    this.inflight ??= this.load(expired).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async load(expired: boolean): Promise<void> {
    if (
      this.failure &&
      this.keys.length === 0 &&
      this.now() - this.attemptedAt < this.options.cooldown
    ) {
      throw this.failure;
    }
    this.attemptedAt = this.now();
    try {
      this.fetchCount++;
      const response = await (this.options.fetch ?? fetch)(this.uri, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeout),
        redirect: "error",
      });
      if (!response.ok) {
        throw new Error(`it answered ${response.status}`);
      }
      const body = (await response.json()) as { keys?: unknown };
      if (!Array.isArray(body.keys)) {
        throw new Error("it has no keys array");
      }
      this.keys = body.keys.flatMap((entry): CachedJwk[] => {
        try {
          if (typeof entry !== "object" || entry === null) {
            return [];
          }
          const jwk = entry as Record<string, unknown>;
          if (jwk.use !== undefined && jwk.use !== "sig") {
            return [];
          }
          if (
            jwk.key_ops !== undefined &&
            !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes("verify"))
          ) {
            return [];
          }
          const algorithms = algorithmsFor(jwk);
          if (algorithms.length === 0) {
            return [];
          }
          const {
            d: _d,
            p: _p,
            q: _q,
            dp: _dp,
            dq: _dq,
            qi: _qi,
            ...publicJwk
          } = jwk;
          const key = createPublicKey({
            key: publicJwk as any,
            format: "jwk",
          });
          const kid = typeof jwk.kid === "string" ? jwk.kid : undefined;
          const alg = typeof jwk.alg === "string" ? jwk.alg : undefined;
          return [{ kid, alg, algorithms, key }];
        } catch {
          return [];
        }
      });
      this.fetchedAt = this.now();
      this.failure = undefined;
    } catch (error) {
      if (this.keys.length === 0) {
        this.failure = new Error(
          `JWKS ${this.uri} is unavailable: ${(error as Error).message}`,
          { cause: error },
        );
        throw this.failure;
      }
      if (expired) {
        this.fetchedAt =
          this.now() - this.options.cacheTtl + this.options.cooldown;
      }
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
