import {
  Inject,
  Injectable,
  Module,
  Optional,
  type DynamicModule,
  type FactoryDependency,
  type ModuleMetadata,
} from "@bunest/common";
import { JwtInvalidException } from "../jwt/jwt.errors";
import type { JwtPayload } from "../jwt/jwt.interface";
import { timingSafeEqualString } from "../utils/crypto.util";
import {
  JwksClient,
  type FetchLike,
  type JwksAlgorithm,
} from "./jwks.client";
import {
  OAuth2Exception,
  OAuth2Service,
  type OAuth2ClientAuthMethod,
  type OAuth2RefreshTokenOptions,
  type OAuth2TokenResponse,
  type OAuth2UserInfo,
} from "./oauth2.service";
import {
  generateNonce,
  type PkceCodeChallengeMethod,
} from "./pkce";

export const OIDC_MODULE_OPTIONS = Symbol.for(
  "bunest:security:oidc_module_options",
);

export interface OidcDiscoveryDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly userinfo_endpoint?: string;
  readonly revocation_endpoint?: string;
  readonly end_session_endpoint?: string;
  readonly scopes_supported?: readonly string[];
  readonly response_types_supported?: readonly string[];
  readonly id_token_signing_alg_values_supported?: readonly string[];
  [key: string]: unknown;
}

export interface OidcModuleOptions {
  /** Expected OIDC Issuer Identifier (strictly matched against discovery & ID token `iss`). */
  issuer: string;
  /** Optional explicit discovery URL. Defaults to `<issuer>/.well-known/openid-configuration`. */
  discoveryUrl?: string;
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes?: readonly string[];
  extraAuthorizationParams?: Record<string, string>;
  clientAuthMethod?: OAuth2ClientAuthMethod;
  /** Allowed asymmetric signing algorithms for ID tokens. */
  algorithms?: readonly JwksAlgorithm[];
  /** Clock skew tolerance in seconds for ID token verification. */
  clockTolerance?: number;
  /** Discovery document cache TTL in ms. Default: 3_600_000 (1 hour). */
  discoveryCacheTtlMs?: number;
  /** JWKS cache TTL in ms. Default: 600_000 (10 minutes). */
  jwksCacheTtlMs?: number;
  /** JWKS unknown-`kid` refresh cooldown in ms. Default: 30_000 (30 seconds). */
  jwksRateLimitRefreshMs?: number;
  /** HTTP request timeout in ms. Default: 10_000 (10 seconds). */
  timeoutMs?: number;
  /** Injectable fetch implementation for offline / deterministic testing. */
  fetchFn?: FetchLike;
  /** Injectable clock (returns epoch ms) for deterministic testing. */
  nowFn?: () => number;
  /** Optional externally managed JwksClient instance. */
  jwksClient?: JwksClient;
  global?: boolean;
}

export interface OidcModuleAsyncOptions {
  imports?: ModuleMetadata["imports"];
  inject?: FactoryDependency[];
  useFactory: (
    ...args: any[]
  ) => OidcModuleOptions | Promise<OidcModuleOptions>;
  global?: boolean;
}

export interface OidcAuthorizationUrlParams {
  state?: string;
  nonce?: string;
  scopes?: readonly string[];
  redirectUri?: string;
  pkce?: boolean;
  codeVerifier?: string;
  codeChallenge?: string;
  prompt?: string;
  loginHint?: string;
  maxAge?: number;
  extraParams?: Record<string, string>;
}

export interface OidcAuthorizationUrlResult {
  readonly url: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: PkceCodeChallengeMethod;
}

export interface OidcIdTokenClaims extends JwtPayload {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  azp?: string;
  nonce?: string;
  auth_time?: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export interface OidcVerifyIdTokenOptions {
  expectedNonce?: string;
  maxAge?: number;
  algorithms?: readonly JwksAlgorithm[];
  clockTolerance?: number;
  currentDate?: Date;
}

export interface OidcTokenExchangeParams {
  code: string;
  codeVerifier?: string;
  expectedNonce?: string;
  redirectUri?: string;
  maxAge?: number;
  extraParams?: Record<string, string>;
  clockTolerance?: number;
  currentDate?: Date;
}

export interface OidcTokenExchangeResult<
  T extends OidcIdTokenClaims = OidcIdTokenClaims,
> {
  readonly tokens: OAuth2TokenResponse;
  readonly idToken: string;
  readonly claims: T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultDiscoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

/**
 * First-class OpenID Connect 1.0 Relying Party service with `/.well-known/openid-configuration`
 * discovery caching & issuer validation, PKCE S256 + `nonce` authorization URLs,
 * authorization code exchange, and cryptographic JWKS ID token verification
 * (`iss`, `aud`, `azp`, `exp`, `nbf`, `iat`, `sub`, `nonce`).
 */
@Injectable()
export class OidcService {
  private readonly options: OidcModuleOptions;
  private readonly fetchFn: FetchLike;
  private readonly nowFn: () => number;
  private readonly timeoutMs: number;
  private readonly discoveryCacheTtlMs: number;

  private cachedDiscovery: {
    doc: OidcDiscoveryDocument;
    expiresAt: number;
  } | null = null;
  private inFlightDiscovery: Promise<OidcDiscoveryDocument> | null = null;
  private jwksClient?: JwksClient;
  private jwksClientUri?: string;

  constructor(
    @Optional()
    @Inject(OIDC_MODULE_OPTIONS)
    options?: OidcModuleOptions,
  ) {
    if (!options || !options.issuer || !options.clientId) {
      throw new Error("OidcService requires issuer and clientId options");
    }
    this.options = options;
    this.fetchFn =
      options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.discoveryCacheTtlMs = options.discoveryCacheTtlMs ?? 60 * 60 * 1000;
    this.jwksClient = options.jwksClient;
  }

  /**
   * Clears cached discovery document and internal JWKS key cache.
   */
  clearCache(): void {
    this.cachedDiscovery = null;
    this.jwksClient?.clearCache();
  }

  /**
   * Loads and caches the provider's `/.well-known/openid-configuration` document,
   * strictly validating that the returned `issuer` matches the configured issuer
   * (OIDC Discovery 1.0 §4.3).
   */
  async discover(forceRefresh = false): Promise<OidcDiscoveryDocument> {
    const now = this.nowFn();
    if (
      !forceRefresh &&
      this.cachedDiscovery !== null &&
      now < this.cachedDiscovery.expiresAt
    ) {
      return this.cachedDiscovery.doc;
    }

    if (this.inFlightDiscovery) {
      return this.inFlightDiscovery;
    }

    const discoveryUrl =
      this.options.discoveryUrl ?? defaultDiscoveryUrl(this.options.issuer);

    const task = (async (): Promise<OidcDiscoveryDocument> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: Response;
      try {
        response = await this.fetchFn(discoveryUrl, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown network error";
        throw new OAuth2Exception(
          `OIDC discovery failed for ${discoveryUrl}: ${message}`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new OAuth2Exception(
          `OIDC discovery failed for ${discoveryUrl}: HTTP ${response.status}`,
        );
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new OAuth2Exception(
          `OIDC discovery document at ${discoveryUrl} is not valid JSON`,
        );
      }

      if (!isPlainRecord(raw)) {
        throw new OAuth2Exception(
          "OIDC discovery document must be a JSON object",
        );
      }

      // Strict OIDC Discovery 1.0 §4.3 issuer match check
      if (typeof raw.issuer !== "string" || raw.issuer !== this.options.issuer) {
        throw new OAuth2Exception(
          `OIDC discovery issuer mismatch: expected "${this.options.issuer}", received "${String(raw.issuer)}"`,
        );
      }

      for (const requiredField of [
        "authorization_endpoint",
        "token_endpoint",
        "jwks_uri",
      ] as const) {
        const val = raw[requiredField];
        if (typeof val !== "string" || val.trim().length === 0) {
          throw new OAuth2Exception(
            `OIDC discovery document missing required field "${requiredField}"`,
          );
        }
      }

      const doc = raw as OidcDiscoveryDocument;
      this.cachedDiscovery = {
        doc,
        expiresAt: this.nowFn() + this.discoveryCacheTtlMs,
      };
      this.ensureJwksClient(doc.jwks_uri);
      return doc;
    })();

    this.inFlightDiscovery = task;
    try {
      return await task;
    } finally {
      if (this.inFlightDiscovery === task) {
        this.inFlightDiscovery = null;
      }
    }
  }

  /**
   * Returns the `JwksClient` bound to the discovered `jwks_uri`.
   */
  async getJwksClient(): Promise<JwksClient> {
    const doc = await this.discover();
    return this.ensureJwksClient(doc.jwks_uri);
  }

  /**
   * Builds an OIDC authorization URL with guaranteed `openid` scope,
   * cryptographic `state`, `nonce`, and PKCE `S256`.
   */
  async buildAuthorizationUrl(
    params: OidcAuthorizationUrlParams = {},
  ): Promise<OidcAuthorizationUrlResult> {
    const doc = await this.discover();
    const oauth2 = this.createOAuth2Client(doc);

    const requestedScopes = params.scopes ??
      this.options.scopes ?? ["openid", "profile", "email"];
    const scopes = requestedScopes.includes("openid")
      ? [...requestedScopes]
      : ["openid", ...requestedScopes];

    const nonce = params.nonce ?? generateNonce();
    const extraParams: Record<string, string> = {
      ...(params.extraParams ?? {}),
      nonce,
      ...(params.maxAge !== undefined ? { max_age: String(params.maxAge) } : {}),
    };

    const result = await oauth2.buildAuthorizationUrl({
      state: params.state,
      scopes,
      redirectUri: params.redirectUri,
      pkce: params.pkce ?? true,
      codeVerifier: params.codeVerifier,
      codeChallenge: params.codeChallenge,
      prompt: params.prompt,
      loginHint: params.loginHint,
      extraParams,
    });

    return {
      ...result,
      nonce,
    };
  }

  /**
   * Cryptographically verifies an OIDC `id_token` using the discovered JWKS endpoint
   * and enforces OpenID Connect Core 1.0 §3.1.3.7 claims (`iss`, `aud`, `azp`,
   * `exp`, `nbf`, `iat`, `sub`, `nonce`, optional `maxAge`).
   */
  async verifyIdToken<T extends OidcIdTokenClaims = OidcIdTokenClaims>(
    idToken: string,
    options: OidcVerifyIdTokenOptions = {},
  ): Promise<T> {
    const doc = await this.discover();
    const jwks = this.ensureJwksClient(doc.jwks_uri);

    const claims = await jwks.verifyJwtWithJwks<T>(idToken, {
      issuer: doc.issuer,
      audience: this.options.clientId,
      algorithms: options.algorithms ?? this.options.algorithms,
      clockTolerance: options.clockTolerance ?? this.options.clockTolerance,
      currentDate: options.currentDate,
    });

    // OIDC Core §2 & §3.1.3.7 mandatory claims
    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      throw new JwtInvalidException("ID token missing required sub claim");
    }
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
      throw new JwtInvalidException("ID token missing required exp claim");
    }
    if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) {
      throw new JwtInvalidException("ID token missing required iat claim");
    }

    // OIDC Core §3.1.3.7 rules 4 & 5: azp validation
    const audiences = Array.isArray(claims.aud)
      ? claims.aud
      : typeof claims.aud === "string"
        ? [claims.aud]
        : [];
    if (audiences.length > 1) {
      if (typeof claims.azp !== "string" || claims.azp.length === 0) {
        throw new JwtInvalidException(
          "ID token with multiple audiences must include azp claim",
        );
      }
    }
    if (claims.azp !== undefined && claims.azp !== this.options.clientId) {
      throw new JwtInvalidException("ID token azp claim mismatch");
    }

    // OIDC Core §3.1.3.7 rule 11: nonce validation
    if (options.expectedNonce !== undefined) {
      if (
        typeof claims.nonce !== "string" ||
        !timingSafeEqualString(claims.nonce, options.expectedNonce)
      ) {
        throw new JwtInvalidException("ID token nonce mismatch");
      }
    }

    // OIDC Core §3.1.3.7 rule 13: max_age / auth_time validation
    if (options.maxAge !== undefined) {
      if (
        typeof claims.auth_time !== "number" ||
        !Number.isFinite(claims.auth_time)
      ) {
        throw new JwtInvalidException(
          "ID token missing required auth_time claim for maxAge check",
        );
      }
      const nowSec = Math.floor(
        (options.currentDate?.getTime() ?? this.nowFn()) / 1000,
      );
      const tolerance =
        options.clockTolerance ?? this.options.clockTolerance ?? 0;
      if (nowSec - claims.auth_time > options.maxAge + tolerance) {
        throw new JwtInvalidException("ID token auth_time exceeded maxAge");
      }
    }

    return claims;
  }

  /**
   * Exchanges an authorization `code` (with optional PKCE `codeVerifier`) at the
   * discovered `token_endpoint` and cryptographically verifies the returned `id_token`.
   */
  async exchangeCodeAndVerifyIdToken<
    T extends OidcIdTokenClaims = OidcIdTokenClaims,
  >(params: OidcTokenExchangeParams): Promise<OidcTokenExchangeResult<T>> {
    const doc = await this.discover();
    const oauth2 = this.createOAuth2Client(doc);

    const tokens = await oauth2.exchangeAuthorizationCode({
      code: params.code,
      codeVerifier: params.codeVerifier,
      redirectUri: params.redirectUri,
      extraParams: params.extraParams,
    });

    if (!tokens.idToken) {
      throw new JwtInvalidException(
        "OIDC token response did not contain an id_token",
      );
    }

    const claims = await this.verifyIdToken<T>(tokens.idToken, {
      expectedNonce: params.expectedNonce,
      maxAge: params.maxAge,
      clockTolerance: params.clockTolerance,
      currentDate: params.currentDate,
    });

    return {
      tokens,
      idToken: tokens.idToken,
      claims,
    };
  }

  /**
   * Refreshes an access token via the discovered `token_endpoint`.
   */
  async refreshAccessToken(
    refreshToken: string,
    options?: OAuth2RefreshTokenOptions,
  ): Promise<OAuth2TokenResponse> {
    const doc = await this.discover();
    return this.createOAuth2Client(doc).refreshAccessToken(
      refreshToken,
      options,
    );
  }

  /**
   * Fetches user profile claims from the discovered `userinfo_endpoint`.
   */
  async fetchUserInfo<T extends OAuth2UserInfo = OAuth2UserInfo>(
    accessToken: string,
  ): Promise<T> {
    const doc = await this.discover();
    return this.createOAuth2Client(doc).fetchUserInfo<T>(
      accessToken,
      doc.userinfo_endpoint,
    );
  }

  private ensureJwksClient(jwksUri: string): JwksClient {
    if (this.options.jwksClient) {
      return this.options.jwksClient;
    }
    if (!this.jwksClient || this.jwksClientUri !== jwksUri) {
      this.jwksClient = new JwksClient({
        jwksUri,
        cacheTtlMs: this.options.jwksCacheTtlMs,
        rateLimitRefreshMs: this.options.jwksRateLimitRefreshMs,
        timeoutMs: this.options.timeoutMs,
        fetchFn: this.fetchFn,
        nowFn: this.nowFn,
        algorithms: this.options.algorithms,
        clockTolerance: this.options.clockTolerance,
      });
      this.jwksClientUri = jwksUri;
    }
    return this.jwksClient;
  }

  private createOAuth2Client(doc: OidcDiscoveryDocument): OAuth2Service {
    return new OAuth2Service({
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      redirectUri: this.options.redirectUri,
      authorizationUrl: doc.authorization_endpoint,
      tokenUrl: doc.token_endpoint,
      userInfoUrl: doc.userinfo_endpoint,
      scopes: this.options.scopes,
      extraAuthorizationParams: this.options.extraAuthorizationParams,
      clientAuthMethod: this.options.clientAuthMethod,
      timeoutMs: this.timeoutMs,
      fetchFn: this.fetchFn,
    });
  }
}

@Module({})
export class OidcModule {
  static register(options: OidcModuleOptions): DynamicModule {
    return {
      module: OidcModule,
      global: options.global,
      providers: [
        { provide: OIDC_MODULE_OPTIONS, useValue: options },
        OidcService,
      ],
      exports: [OidcService, OIDC_MODULE_OPTIONS],
    };
  }

  static registerAsync(options: OidcModuleAsyncOptions): DynamicModule {
    return {
      module: OidcModule,
      global: options.global,
      imports: options.imports,
      providers: [
        {
          provide: OIDC_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject,
        },
        OidcService,
      ],
      exports: [OidcService, OIDC_MODULE_OPTIONS],
    };
  }
}
