import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Optional,
  type DynamicModule,
  type FactoryDependency,
  type ModuleMetadata,
} from "@bunest/core";
import { definedOnly, isFiniteNumber, isString } from "@bunest/core/common";
import type { FetchLike } from "./jwks.client";
import {
  computePkceChallenge,
  generatePkcePair,
  generateState,
  type PkceCodeChallengeMethod,
} from "./pkce";

export const OAUTH2_MODULE_OPTIONS = Symbol.for(
  "bunest:security:oauth2_module_options",
);

export type OAuth2ClientAuthMethod =
  "client_secret_post" | "client_secret_basic" | "none";

export interface OAuth2ModuleOptions {
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  scopes?: readonly string[];
  extraAuthorizationParams?: Record<string, string>;
  clientAuthMethod?: OAuth2ClientAuthMethod;
  timeoutMs?: number;
  fetchFn?: FetchLike;
  global?: boolean;
}

export interface OAuth2ModuleAsyncOptions {
  imports?: ModuleMetadata["imports"];
  inject?: FactoryDependency[];
  useFactory: (
    ...args: any[]
  ) => OAuth2ModuleOptions | Promise<OAuth2ModuleOptions>;
  global?: boolean;
}

export interface OAuth2AuthorizationUrlParams {
  state?: string;
  scopes?: readonly string[];
  redirectUri?: string;
  /** Enable PKCE S256 generation (default: `true`). */
  pkce?: boolean;
  codeVerifier?: string;
  codeChallenge?: string;
  prompt?: string;
  loginHint?: string;
  responseType?: string;
  extraParams?: Record<string, string>;
}

export interface OAuth2AuthorizationUrlResult {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: PkceCodeChallengeMethod;
}

export interface OAuth2ExchangeCodeParams {
  code: string;
  codeVerifier?: string;
  redirectUri?: string;
  extraParams?: Record<string, string>;
}

export interface OAuth2RefreshTokenOptions {
  scopes?: readonly string[];
  extraParams?: Record<string, string>;
}

export interface OAuth2TokenResponse {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresIn?: number;
  readonly refreshToken?: string;
  readonly scope?: string;
  readonly idToken?: string;
  readonly raw: Record<string, unknown>;
}

export interface OAuth2UserInfo {
  sub?: string;
  id?: string | number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  [key: string]: unknown;
}

export class OAuth2Exception extends HttpException {
  public readonly oauthError?: string;
  public readonly oauthErrorDescription?: string;

  constructor(
    message: string,
    options?: {
      status?: number;
      oauthError?: string;
      oauthErrorDescription?: string;
    },
  ) {
    super(message, options?.status ?? HttpStatus.UNAUTHORIZED);
    this.oauthError = options?.oauthError;
    this.oauthErrorDescription = options?.oauthErrorDescription;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * First-class OAuth 2.0 client supporting Authorization Code Flow with PKCE (`S256`),
 * CSRF `state` generation, token exchange, refresh token grants, and UserInfo retrieval.
 */
@Injectable()
export class OAuth2Service {
  private readonly options: OAuth2ModuleOptions;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    @Optional()
    @Inject(OAUTH2_MODULE_OPTIONS)
    options?: OAuth2ModuleOptions,
  ) {
    if (
      !options ||
      !options.clientId ||
      !options.authorizationUrl ||
      !options.tokenUrl
    ) {
      throw new Error(
        "OAuth2Service requires clientId, authorizationUrl, and tokenUrl options",
      );
    }
    this.options = options;
    this.fetchFn =
      options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * Builds an OAuth 2.0 authorization redirect URL with CSRF `state`,
   * PKCE `S256` challenge (enabled by default), scopes, and extra parameters.
   */
  async buildAuthorizationUrl(
    params: OAuth2AuthorizationUrlParams = {},
  ): Promise<OAuth2AuthorizationUrlResult> {
    const url = new URL(this.options.authorizationUrl);

    // Apply default extra params, then call-level extra params
    if (this.options.extraAuthorizationParams) {
      for (const [k, v] of Object.entries(
        this.options.extraAuthorizationParams,
      )) {
        url.searchParams.set(k, v);
      }
    }
    if (params.extraParams) {
      for (const [k, v] of Object.entries(params.extraParams)) {
        url.searchParams.set(k, v);
      }
    }

    if (params.prompt) {
      url.searchParams.set("prompt", params.prompt);
    }
    if (params.loginHint) {
      url.searchParams.set("login_hint", params.loginHint);
    }

    const state = params.state ?? generateState();
    const redirectUri = params.redirectUri ?? this.options.redirectUri;
    const scopes = params.scopes ?? this.options.scopes;

    url.searchParams.set("response_type", params.responseType ?? "code");
    url.searchParams.set("client_id", this.options.clientId);
    if (redirectUri) {
      url.searchParams.set("redirect_uri", redirectUri);
    }
    if (scopes && scopes.length > 0) {
      url.searchParams.set("scope", scopes.join(" "));
    }
    url.searchParams.set("state", state);

    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;
    let codeChallengeMethod: PkceCodeChallengeMethod | undefined;

    if (params.codeChallenge) {
      codeChallenge = params.codeChallenge;
      codeChallengeMethod = "S256";
      codeVerifier = params.codeVerifier;
    } else if (params.codeVerifier) {
      codeVerifier = params.codeVerifier;
      codeChallenge = await computePkceChallenge(params.codeVerifier);
      codeChallengeMethod = "S256";
    } else if (params.pkce !== false) {
      const pair = await generatePkcePair();
      codeVerifier = pair.codeVerifier;
      codeChallenge = pair.codeChallenge;
      codeChallengeMethod = pair.codeChallengeMethod;
    }

    if (codeChallenge && codeChallengeMethod) {
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", codeChallengeMethod);
    }

    return {
      url: url.toString(),
      state,
      ...definedOnly({ codeVerifier, codeChallenge, codeChallengeMethod }),
    };
  }

  /**
   * Exchanges an authorization `code` (with optional PKCE `codeVerifier`) for tokens.
   */
  async exchangeAuthorizationCode(
    params: OAuth2ExchangeCodeParams,
  ): Promise<OAuth2TokenResponse> {
    if (!params.code || params.code.trim().length === 0) {
      throw new OAuth2Exception(
        "Authorization code must be a non-empty string",
        {
          status: HttpStatus.BAD_REQUEST,
        },
      );
    }

    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", params.code);

    const redirectUri = params.redirectUri ?? this.options.redirectUri;
    if (redirectUri) {
      body.set("redirect_uri", redirectUri);
    }
    if (params.codeVerifier) {
      body.set("code_verifier", params.codeVerifier);
    }
    if (params.extraParams) {
      for (const [k, v] of Object.entries(params.extraParams)) {
        body.set(k, v);
      }
    }

    return this.requestTokenEndpoint(body);
  }

  /**
   * Exchanges a `refresh_token` for a fresh access token (and optional rotated refresh token).
   */
  async refreshAccessToken(
    refreshToken: string,
    options: OAuth2RefreshTokenOptions = {},
  ): Promise<OAuth2TokenResponse> {
    if (!refreshToken || refreshToken.trim().length === 0) {
      throw new OAuth2Exception("Refresh token must be a non-empty string", {
        status: HttpStatus.BAD_REQUEST,
      });
    }

    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refreshToken);

    if (options.scopes && options.scopes.length > 0) {
      body.set("scope", options.scopes.join(" "));
    }
    if (options.extraParams) {
      for (const [k, v] of Object.entries(options.extraParams)) {
        body.set(k, v);
      }
    }

    return this.requestTokenEndpoint(body);
  }

  /**
   * Fetches user profile claims from the provider's UserInfo endpoint using a Bearer access token.
   */
  async fetchUserInfo<T extends OAuth2UserInfo = OAuth2UserInfo>(
    accessToken: string,
    userInfoUrl?: string,
  ): Promise<T> {
    if (!accessToken || accessToken.trim().length === 0) {
      throw new OAuth2Exception("Access token must be a non-empty string");
    }
    const targetUrl = userInfoUrl ?? this.options.userInfoUrl;
    if (!targetUrl) {
      throw new OAuth2Exception("OAuth2 userInfoUrl is not configured", {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });
    }

    const response = await this.fetchWithTimeout(targetUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new OAuth2Exception(
        `OAuth2 UserInfo request failed with HTTP ${response.status}`,
        { status: HttpStatus.UNAUTHORIZED },
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new OAuth2Exception(
        "OAuth2 UserInfo endpoint returned invalid JSON",
      );
    }

    if (!isPlainRecord(data)) {
      throw new OAuth2Exception(
        "OAuth2 UserInfo payload must be a JSON object",
      );
    }

    return data as T;
  }

  private async requestTokenEndpoint(
    body: URLSearchParams,
  ): Promise<OAuth2TokenResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };

    const authMethod: OAuth2ClientAuthMethod =
      this.options.clientAuthMethod ??
      (this.options.clientSecret ? "client_secret_post" : "none");

    if (authMethod === "client_secret_basic" && this.options.clientSecret) {
      const credentials = `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`;
      headers.Authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
    } else {
      body.set("client_id", this.options.clientId);
      if (authMethod === "client_secret_post" && this.options.clientSecret) {
        body.set("client_secret", this.options.clientSecret);
      }
    }

    const response = await this.fetchWithTimeout(this.options.tokenUrl, {
      method: "POST",
      headers,
      body: body.toString(),
    });

    const contentType = response.headers.get("content-type") ?? "";
    let raw: Record<string, unknown>;

    try {
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const text = await response.text();
        raw = Object.fromEntries(new URLSearchParams(text).entries());
      } else {
        const parsed: unknown = await response.json();
        if (!isPlainRecord(parsed)) {
          throw new Error("Expected JSON object");
        }
        raw = parsed;
      }
    } catch {
      throw new OAuth2Exception(
        `OAuth2 token endpoint returned malformed payload (HTTP ${response.status})`,
      );
    }

    if (!response.ok || typeof raw.error === "string") {
      const oauthError =
        typeof raw.error === "string" ? raw.error : `http_${response.status}`;
      const oauthErrorDescription =
        typeof raw.error_description === "string"
          ? raw.error_description
          : undefined;
      throw new OAuth2Exception(
        oauthErrorDescription
          ? `OAuth2 token request failed (${oauthError}): ${oauthErrorDescription}`
          : `OAuth2 token request failed (${oauthError})`,
        {
          status: HttpStatus.UNAUTHORIZED,
          oauthError,
          oauthErrorDescription,
        },
      );
    }

    if (typeof raw.access_token !== "string" || raw.access_token.length === 0) {
      throw new OAuth2Exception(
        "OAuth2 token response missing required access_token",
      );
    }

    const rawExpires = raw.expires_in;
    let expiresIn: number | undefined;
    if (isFiniteNumber(rawExpires)) {
      expiresIn = rawExpires;
    } else if (isString(rawExpires) && /^\d+$/.test(rawExpires)) {
      expiresIn = Number.parseInt(rawExpires, 10);
    }

    return {
      accessToken: raw.access_token,
      tokenType:
        isString(raw.token_type) && raw.token_type.length > 0
          ? raw.token_type
          : "Bearer",
      ...definedOnly({
        expiresIn,
        refreshToken: isString(raw.refresh_token)
          ? raw.refresh_token
          : undefined,
        scope: isString(raw.scope) ? raw.scope : undefined,
        idToken: isString(raw.id_token) ? raw.id_token : undefined,
      }),
      raw,
    };
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown network error";
      throw new OAuth2Exception(`OAuth2 request to ${url} failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

@Module({})
export class OAuth2Module {
  static register(options: OAuth2ModuleOptions): DynamicModule {
    return {
      module: OAuth2Module,
      global: options.global,
      providers: [
        { provide: OAUTH2_MODULE_OPTIONS, useValue: options },
        OAuth2Service,
      ],
      exports: [OAuth2Service, OAUTH2_MODULE_OPTIONS],
    };
  }

  static registerAsync(options: OAuth2ModuleAsyncOptions): DynamicModule {
    return {
      module: OAuth2Module,
      global: options.global,
      imports: options.imports,
      providers: [
        {
          provide: OAUTH2_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject,
        },
        OAuth2Service,
      ],
      exports: [OAuth2Service, OAUTH2_MODULE_OPTIONS],
    };
  }
}
