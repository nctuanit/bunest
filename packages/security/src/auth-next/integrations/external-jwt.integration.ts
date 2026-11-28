import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type ExecutionContext,
  type ModuleImport,
  type Provider,
} from "@bunest/core";
import { AuthenticationModule } from "../authentication.module";
import { AuthenticationError } from "../errors/authentication.error";
import { JwtError } from "../errors/jwt.error";
import type { AuthenticationResult } from "../interfaces/authentication-result.interface";
import type { JwksClientOptions } from "../interfaces/jwks-client-options.interface";
import type { JwsAlgorithm, JwtClaims } from "../interfaces/jwt.interface";
import type { JwtVerifierOptions } from "../interfaces/jwt-options.interface";
import { hasMfaAmr } from "../jwt/amr.util";
import { JwksClient } from "../jwt/jwks.client";
import { JwtVerifier } from "../jwt/jwt-verifier.service";
import { AuthenticationProvider } from "../providers/authentication.provider";
import { AuthenticationRegistry } from "../services/authentication-registry.service";
import { API_KEY_PATTERN } from "../utils/api-key.util";
import { extractBearerToken, extractCookieValue } from "./web-request.util";

export const EXTERNAL_JWT_AUTH_OPTIONS: unique symbol = Symbol.for(
  "bunest:security:external_jwt_auth_options",
);

export interface ExternalJwtSharedOptions<TUser> {
  /**
   * Provider execution order inside `AuthenticationRegistry`.
   * @default 0
   */
  readonly order?: number;
  /**
   * `WWW-Authenticate` realm sent on 401 responses.
   * @default "api"
   */
  readonly realm?: string;
  /**
   * Optional cookie name fallback when no `Authorization: Bearer` header is sent
   * (e.g. Clerk's `__session` cookie).
   */
  readonly cookieName?: string;
  /**
   * Import `AuthenticationModule.forRoot({ globalGuard, isGlobal })` automatically.
   * @default true
   */
  readonly registerAuthenticationModule?: boolean;
  /**
   * Whether `AuthenticationModule` registers `AuthenticationGuard` globally.
   * @default true
   */
  readonly globalGuard?: boolean;
  /**
   * Make `ExternalJwtProvider` globally injectable.
   * @default true
   */
  readonly isGlobal?: boolean;
  /**
   * Custom fetch implementation for JWKS retrieval (helpful in tests or custom proxies).
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Optional JWKS cache/timeout settings.
   */
  readonly jwksOptions?: Omit<JwksClientOptions, "fetch">;
  /**
   * Optional claim mapper converting verified JWT claims into your application user object.
   * Return `null` to reject with 401.
   */
  readonly mapUser?: (
    claims: JwtClaims,
    context: ExecutionContext,
  ) => Promise<TUser | null | undefined> | TUser | null | undefined;
}

export interface ExternalJwksAuthOptions<TUser = JwtClaims>
  extends ExternalJwtSharedOptions<TUser> {
  readonly jwksUri: string;
  readonly issuer: string;
  readonly audience: string | readonly string[] | false;
  readonly algorithms?: readonly JwsAlgorithm[];
  readonly clockTolerance?: JwtVerifierOptions["clockTolerance"];
  readonly maxAge?: JwtVerifierOptions["maxAge"];
  readonly validateClaims?: (claims: JwtClaims) => void;
}

export interface ClerkUser {
  readonly id: string;
  readonly sessionId?: string;
  readonly orgId?: string;
  readonly orgRole?: string;
  readonly orgSlug?: string;
  readonly email?: string;
  readonly claims: JwtClaims;
}

export interface ClerkAuthOptions<TUser = ClerkUser>
  extends ExternalJwtSharedOptions<TUser> {
  /**
   * Clerk Frontend API issuer URL, e.g. `https://bright-fox-12.clerk.accounts.dev`
   * or your custom Clerk domain (`https://clerk.example.com`).
   */
  readonly issuer: string;
  /**
   * Override JWKS URI. Defaults to `${issuer}/.well-known/jwks.json`.
   */
  readonly jwksUri?: string;
  /**
   * Allowed `azp` (Authorized Party) origins, e.g. `["https://app.example.com"]`.
   * Strongly recommended in production to prevent cross-origin session token abuse.
   */
  readonly authorizedParties?: readonly string[];
  /**
   * Expected `aud` claim. Clerk session tokens typically omit `aud` unless using a
   * custom JWT template, so this defaults to `false`.
   * @default false
   */
  readonly audience?: string | readonly string[] | false;
  /**
   * Cookie name inspected when no `Authorization: Bearer` header is sent.
   * @default "__session"
   */
  readonly cookieName?: string;
}

export interface SupabaseUser {
  readonly id: string;
  readonly email?: string;
  readonly phone?: string;
  readonly role?: string;
  readonly aal?: string;
  readonly appMetadata: Record<string, unknown>;
  readonly userMetadata: Record<string, unknown>;
  readonly claims: JwtClaims;
}

export interface SupabaseAuthOptions<TUser = SupabaseUser>
  extends ExternalJwtSharedOptions<TUser> {
  /**
   * Supabase project URL, e.g. `https://<project-ref>.supabase.co`.
   */
  readonly projectUrl: string;
  /**
   * Legacy HS256 JWT Secret. When omitted, verifies asymmetric ES256/RS256 tokens
   * using `${projectUrl}/auth/v1/.well-known/jwks.json` (Supabase's modern default).
   */
  readonly jwtSecret?: string;
  /**
   * Override JWKS URI (only used when `jwtSecret` is not provided).
   * Defaults to `${projectUrl}/auth/v1/.well-known/jwks.json`.
   */
  readonly jwksUri?: string;
  /**
   * Expected `aud` claim.
   * @default "authenticated"
   */
  readonly audience?: string | readonly string[] | false;
}

export interface Auth0User {
  readonly id: string;
  readonly scope: readonly string[];
  readonly permissions: readonly string[];
  readonly email?: string;
  readonly claims: JwtClaims;
}

export interface Auth0AuthOptions<TUser = Auth0User>
  extends ExternalJwtSharedOptions<TUser> {
  /**
   * Auth0 tenant domain (e.g. `my-tenant.us.auth0.com` or `https://my-tenant.us.auth0.com`).
   */
  readonly domain: string;
  /**
   * Auth0 API identifier configured as the `aud` claim.
   */
  readonly audience: string | readonly string[];
  /**
   * Override JWKS URI. Defaults to `https://${domain}/.well-known/jwks.json`.
   */
  readonly jwksUri?: string;
}

interface ResolvedExternalJwtConfig<TUser = unknown> {
  readonly verifier: JwtVerifier;
  readonly realm: string;
  readonly order: number;
  readonly cookieName?: string;
  readonly validateClaims?: (claims: JwtClaims) => void;
  readonly mapUser: (
    claims: JwtClaims,
    context: ExecutionContext,
  ) => Promise<TUser | null | undefined> | TUser | null | undefined;
}

/**
 * Zero-dependency WebCrypto JWT/JWKS credential provider powering Clerk, Supabase,
 * Auth0, Keycloak, WorkOS, Okta, Cognito, and Firebase Auth integrations.
 */
@Injectable()
export class ExternalJwtProvider<
  TUser = unknown,
> extends AuthenticationProvider<TUser, JwtClaims> {
  constructor(
    @Inject(EXTERNAL_JWT_AUTH_OPTIONS)
    private readonly config: ResolvedExternalJwtConfig<TUser>,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerProvider(this, { order: config.order });
  }

  override async authenticate(
    context: ExecutionContext,
  ): Promise<AuthenticationResult<TUser, JwtClaims> | null> {
    const token = this.extractToken(context);
    if (token === undefined) {
      return null;
    }

    let claims: JwtClaims;
    try {
      claims = await this.config.verifier.verify(token);
      this.config.validateClaims?.(claims);
    } catch (error) {
      if (error instanceof JwtError) {
        this.reject(error.message);
      }
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw error;
    }

    const user = await this.config.mapUser(claims, context);
    if (user === null || user === undefined) {
      this.reject("unknown subject");
    }

    return {
      user,
      session: claims,
      ...(hasMfaAmr(claims.amr) ? { mfa: "verified" as const } : {}),
    };
  }

  override challenge(): string {
    return `Bearer realm="${this.config.realm}"`;
  }

  private extractToken(context: ExecutionContext): string | undefined {
    const bearer = extractBearerToken(context);
    if (bearer === null) {
      this.reject("malformed authorization header");
    }
    if (bearer !== undefined) {
      // Let ApiKeyProvider handle prefixed API keys if both are registered in the same app.
      if (API_KEY_PATTERN.test(bearer)) {
        return undefined;
      }
      return bearer;
    }
    if (this.config.cookieName) {
      return extractCookieValue(context, this.config.cookieName);
    }
    return undefined;
  }

  private reject(description: string): never {
    throw new AuthenticationError(description, {
      challenge: `Bearer realm="${this.config.realm}", error="invalid_token", error_description="${description}"`,
    });
  }
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeOrigin(raw: string): string {
  const trimmed = stripTrailingSlashes(raw.trim());
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function normalizeAudience(
  audience: string | readonly string[] | false | undefined,
): string | string[] | false | undefined {
  return Array.isArray(audience) ? [...audience] : (audience as string | false | undefined);
}

function defaultClerkUser(claims: JwtClaims): ClerkUser | null {
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return null;
  }
  return {
    id: claims.sub,
    ...(typeof claims.sid === "string" ? { sessionId: claims.sid } : {}),
    ...(typeof claims.org_id === "string" ? { orgId: claims.org_id } : {}),
    ...(typeof claims.org_role === "string"
      ? { orgRole: claims.org_role }
      : {}),
    ...(typeof claims.org_slug === "string"
      ? { orgSlug: claims.org_slug }
      : {}),
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    claims,
  };
}

function defaultSupabaseUser(claims: JwtClaims): SupabaseUser | null {
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return null;
  }
  return {
    id: claims.sub,
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    ...(typeof claims.phone === "string" ? { phone: claims.phone } : {}),
    ...(typeof claims.role === "string" ? { role: claims.role } : {}),
    ...(typeof claims.aal === "string" ? { aal: claims.aal } : {}),
    appMetadata:
      claims.app_metadata && typeof claims.app_metadata === "object"
        ? (claims.app_metadata as Record<string, unknown>)
        : {},
    userMetadata:
      claims.user_metadata && typeof claims.user_metadata === "object"
        ? (claims.user_metadata as Record<string, unknown>)
        : {},
    claims,
  };
}

function defaultAuth0User(claims: JwtClaims): Auth0User | null {
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return null;
  }
  const scope =
    typeof claims.scope === "string"
      ? claims.scope.split(/\s+/).filter(Boolean)
      : [];
  const permissions = Array.isArray(claims.permissions)
    ? claims.permissions.filter((p): p is string => typeof p === "string")
    : [];
  return {
    id: claims.sub,
    scope,
    permissions,
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    claims,
  };
}

function buildExternalJwtModule<TUser>(
  config: ResolvedExternalJwtConfig<TUser>,
  options: ExternalJwtSharedOptions<TUser>,
): DynamicModule {
  const isGlobal = options.isGlobal !== false;
  const imports: ModuleImport[] = [];
  if (options.registerAuthenticationModule !== false) {
    imports.push(
      AuthenticationModule.forRoot({
        isGlobal,
        globalGuard: options.globalGuard !== false,
      }),
    );
  }

  const providers: Provider[] = [
    { provide: EXTERNAL_JWT_AUTH_OPTIONS, useValue: config },
    ExternalJwtProvider,
  ];

  return {
    module: ExternalJwtAuthModule,
    global: isGlobal,
    imports,
    providers,
    exports: [ExternalJwtProvider],
  };
}

/**
 * First-class, zero-dependency JWT/JWKS authentication integrations for modern identity providers:
 *
 * - `ExternalJwtAuthModule.forClerk(...)` — Clerk (`Authorization: Bearer` + `__session` cookie + `azp` check)
 * - `ExternalJwtAuthModule.forSupabase(...)` — Supabase Auth (Asymmetric JWKS `ES256`/`RS256` or legacy `HS256` secret)
 * - `ExternalJwtAuthModule.forAuth0(...)` — Auth0 (`RS256` JWKS + `permissions`/`scope`)
 * - `ExternalJwtAuthModule.forJwks(...)` — Keycloak, WorkOS, Okta, AWS Cognito, Firebase Auth, Logto, Kinde
 */
@Module({})
export class ExternalJwtAuthModule {
  static forClerk<TUser = ClerkUser>(
    options: ClerkAuthOptions<TUser>,
  ): DynamicModule {
    const issuer = stripTrailingSlashes(options.issuer.trim());
    const jwksUri = options.jwksUri ?? `${issuer}/.well-known/jwks.json`;
    const jwks = new JwksClient(jwksUri, {
      ...options.jwksOptions,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

    const verifier = new JwtVerifier({
      jwks,
      issuer,
      audience: normalizeAudience(options.audience ?? false),
      algorithms: ["RS256"],
    });

    const authorizedParties = options.authorizedParties;
    const validateClaims =
      authorizedParties && authorizedParties.length > 0
        ? (claims: JwtClaims) => {
            const azp = claims.azp;
            if (typeof azp !== "string" || !authorizedParties.includes(azp)) {
              throw new JwtError("unauthorized party (azp)");
            }
          }
        : undefined;

    return buildExternalJwtModule<TUser>(
      {
        verifier,
        realm: options.realm ?? "clerk",
        order: options.order ?? 0,
        cookieName: options.cookieName ?? "__session",
        validateClaims,
        mapUser:
          options.mapUser ??
          ((claims) => defaultClerkUser(claims) as TUser | null),
      },
      options,
    );
  }

  static forSupabase<TUser = SupabaseUser>(
    options: SupabaseAuthOptions<TUser>,
  ): DynamicModule {
    const base = stripTrailingSlashes(options.projectUrl.trim());
    const issuer = `${base}/auth/v1`;
    const audience = normalizeAudience(options.audience ?? "authenticated");

    const verifier = options.jwtSecret
      ? new JwtVerifier({
          key: options.jwtSecret,
          issuer,
          audience,
          algorithms: ["HS256"],
        })
      : new JwtVerifier({
          jwks: new JwksClient(
            options.jwksUri ?? `${issuer}/.well-known/jwks.json`,
            {
              ...options.jwksOptions,
              ...(options.fetch ? { fetch: options.fetch } : {}),
            },
          ),
          issuer,
          audience,
          algorithms: ["ES256", "RS256"],
        });

    return buildExternalJwtModule<TUser>(
      {
        verifier,
        realm: options.realm ?? "supabase",
        order: options.order ?? 0,
        cookieName: options.cookieName,
        mapUser:
          options.mapUser ??
          ((claims) => defaultSupabaseUser(claims) as TUser | null),
      },
      options,
    );
  }

  static forAuth0<TUser = Auth0User>(
    options: Auth0AuthOptions<TUser>,
  ): DynamicModule {
    const origin = normalizeOrigin(options.domain);
    const issuer = `${origin}/`;
    const jwksUri = options.jwksUri ?? `${origin}/.well-known/jwks.json`;

    const verifier = new JwtVerifier({
      jwks: new JwksClient(jwksUri, {
        ...options.jwksOptions,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
      issuer,
      audience: normalizeAudience(options.audience),
      algorithms: ["RS256"],
    });

    return buildExternalJwtModule<TUser>(
      {
        verifier,
        realm: options.realm ?? "auth0",
        order: options.order ?? 0,
        cookieName: options.cookieName,
        mapUser:
          options.mapUser ??
          ((claims) => defaultAuth0User(claims) as TUser | null),
      },
      options,
    );
  }

  static forJwks<TUser = JwtClaims>(
    options: ExternalJwksAuthOptions<TUser>,
  ): DynamicModule {
    const verifier = new JwtVerifier({
      jwks: new JwksClient(options.jwksUri, {
        ...options.jwksOptions,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
      issuer: options.issuer,
      audience: normalizeAudience(options.audience),
      ...(options.algorithms ? { algorithms: [...options.algorithms] } : {}),
      ...(options.clockTolerance !== undefined
        ? { clockTolerance: options.clockTolerance }
        : {}),
      ...(options.maxAge !== undefined ? { maxAge: options.maxAge } : {}),
    });

    return buildExternalJwtModule<TUser>(
      {
        verifier,
        realm: options.realm ?? "api",
        order: options.order ?? 0,
        cookieName: options.cookieName,
        validateClaims: options.validateClaims,
        mapUser: options.mapUser ?? ((claims) => claims as unknown as TUser),
      },
      options,
    );
  }
}
