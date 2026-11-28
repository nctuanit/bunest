export {
  BETTER_AUTH_INSTANCE,
  BETTER_AUTH_MODULE_OPTIONS,
  BetterAuthModule,
  BetterAuthProvider,
  InjectBetterAuth,
  type BetterAuthLike,
  type BetterAuthModuleAsyncOptions,
  type BetterAuthModuleOptions,
  type BetterAuthSessionEnvelope,
  type BetterAuthSharedOptions,
} from "./better-auth.integration";
export {
  EXTERNAL_JWT_AUTH_OPTIONS,
  ExternalJwtAuthModule,
  ExternalJwtProvider,
  type Auth0AuthOptions,
  type Auth0User,
  type ClerkAuthOptions,
  type ClerkUser,
  type ExternalJwksAuthOptions,
  type ExternalJwtSharedOptions,
  type SupabaseAuthOptions,
  type SupabaseUser,
} from "./external-jwt.integration";
export {
  ExternalSessionProvider,
  WEB_AUTH_MODULE_OPTIONS,
  WebAuthModule,
  type WebAuthHandler,
  type WebAuthModuleAsyncOptions,
  type WebAuthModuleOptions,
  type WebAuthSessionContext,
  type WebAuthSessionResolver,
} from "./web-auth.integration";
export {
  extractBearerToken,
  extractCookieValue,
  extractHttpRequest,
  extractWebHeaders,
  normalizeAuthMountPath,
  parseCookieHeader,
} from "./web-request.util";
