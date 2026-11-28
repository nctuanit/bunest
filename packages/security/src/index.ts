// Crypto & Timing-Safe Utilities
export {
  base64UrlDecode,
  base64UrlDecodeUtf8,
  base64UrlEncode,
  parseDurationToSeconds,
  pemToArrayBuffer,
  randomBytes,
  randomToken,
  timingSafeEqualBytes,
  timingSafeEqualString,
} from "./utils/crypto.util";

// JWT
export {
  JsonWebTokenError,
  JwtException,
  JwtExpiredException,
  JwtInvalidException,
  JwtNotBeforeException,
  NotBeforeError,
  TokenExpiredError,
  WrongSecretProviderError,
} from "./jwt/jwt.errors";
export {
  JWT_MODULE_OPTIONS,
  JwtSecretRequestType,
  type DecodedJwt,
  type GetSecretKeyResult,
  type JwtAlgorithm,
  type JwtAsymmetricKeyInput,
  type JwtHeader,
  type JwtModuleAsyncOptions,
  type JwtModuleOptions,
  type JwtOptionsFactory,
  type JwtPayload,
  type JwtSecretInput,
  type JwtSecretKeyObject,
  type JwtSignOptions,
  type JwtVerifyOptions,
} from "./jwt/jwt.interface";
export { JwtService } from "./jwt/jwt.service";
export { JwtModule } from "./jwt/jwt.module";

// Authentication & Authorization (including @nestjs/passport parity)
export {
  CheckPolicies,
  CurrentUser,
  IS_PUBLIC_KEY,
  POLICIES_KEY,
  Public,
  ROLES_KEY,
  Roles,
  getRequestUser,
  setRequestUser,
  type IPolicyHandler,
  type PolicyHandler,
  type PolicyHandlerCallback,
} from "./auth/auth.decorators";
export {
  Auth,
  Protected,
  type ProtectedOptions,
} from "./auth/auth-composite.decorators";
export {
  SECURITY_MODULE_OPTIONS,
  SecurityModule,
  type SecurityModuleGlobalGuardsOptions,
  type SecurityModuleOptions,
} from "./security.module";
export {
  JWT_AUTH_GUARD_OPTIONS,
  JwtAuthGuard,
  extractBearerToken,
  extractCookieToken,
  type JwtAuthGuardOptions,
  type TokenExtractor,
} from "./auth/jwt-auth.guard";
export {
  ROLES_GUARD_OPTIONS,
  RolesGuard,
  type RolesGuardOptions,
} from "./auth/roles.guard";
export { PoliciesGuard } from "./auth/policies.guard";
export {
  CurrentTenant,
  DEFAULT_TENANT_SOURCES,
  REQUIRE_TENANT_KEY,
  RequireTenant,
  TENANT_GUARD_OPTIONS,
  TENANT_ROLES_KEY,
  TenantGuard,
  TenantRoles,
  getRequestTenant,
  setRequestTenant,
  type RequireTenantOptions,
  type TenantGuardOptions,
  type TenantSource,
} from "./auth/tenant.guard";
export {
  PASSWORD_OPTIONS,
  PasswordService,
  type PasswordHashOptions,
} from "./auth/password.service";
export {
  CSRF_OPTIONS,
  CsrfGuard,
  SESSION_COOKIE_OPTIONS,
  SessionCookieService,
  type CsrfGuardOptions,
  type SessionCookieOptions,
} from "./auth/session-csrf.service";
export {
  AbstractStrategy,
  BunestPassportInstance,
  PassportSerializer,
  PassportStrategy,
  defaultPassportInstance,
  type AllConstructorParameters,
  type AuthGuardAuthenticateOptions,
  type DeserializeUserFn,
  type IAuthGuard,
  type SerializeUserFn,
  type Type,
  type WithoutCallback,
} from "./auth/passport.compat";
export {
  API_KEY_AUTH_STRATEGY_OPTIONS,
  AUTH_MODULE_OPTIONS,
  ApiKeyAuthStrategy,
  AuthGuard,
  AuthModule,
  AuthModuleOptions,
  AuthStrategyRegistry,
  BASIC_AUTH_STRATEGY_OPTIONS,
  BasicAuthStrategy,
  JWKS_JWT_AUTH_STRATEGY_OPTIONS,
  JWT_AUTH_STRATEGY_OPTIONS,
  JwksJwtAuthStrategy,
  JwtAuthStrategy,
  PassportModule,
  type ApiKeyAuthStrategyOptions,
  type ApiKeyRecord,
  type AuthModuleAsyncOptions,
  type AuthOptionsFactory,
  type AuthStrategy,
  type AuthStrategyRegistration,
  type BasicAuthStrategyOptions,
  type BasicAuthUser,
  type IAuthModuleOptions,
  type JwksJwtAuthStrategyOptions,
  type JwtAuthStrategyOptions,
} from "./auth/auth-strategy";

// OAuth2, OIDC, PKCE & JWKS
export {
  computePkceChallenge,
  computePkceChallengeSync,
  generateNonce,
  generatePkcePair,
  generateState,
  isValidPkceVerifier,
  verifyPkceChallenge,
  type PkceCodeChallengeMethod,
  type PkcePair,
} from "./oauth/pkce";
export {
  JWKS_CLIENT_OPTIONS,
  JwksClient,
  JwksModule,
  JwksService,
  importPublicJwk,
  type FetchLike,
  type JsonWebKeySet,
  type JwksAlgorithm,
  type JwksClientOptions,
  type JwksKey,
  type JwksModuleAsyncOptions,
  type JwksVerifyOptions,
} from "./oauth/jwks.client";
export {
  OAuth2Providers,
  type Auth0ProviderOptions,
  type GitHubProviderOptions,
  type GoogleProviderOptions,
  type MicrosoftProviderOptions,
  type OAuth2ProviderPreset,
  type OidcProviderPreset,
  type OktaProviderOptions,
} from "./oauth/providers";
export {
  OAUTH2_MODULE_OPTIONS,
  OAuth2Exception,
  OAuth2Module,
  OAuth2Service,
  type OAuth2AuthorizationUrlParams,
  type OAuth2AuthorizationUrlResult,
  type OAuth2ClientAuthMethod,
  type OAuth2ExchangeCodeParams,
  type OAuth2ModuleAsyncOptions,
  type OAuth2ModuleOptions,
  type OAuth2RefreshTokenOptions,
  type OAuth2TokenResponse,
  type OAuth2UserInfo,
} from "./oauth/oauth2.service";
export {
  OIDC_MODULE_OPTIONS,
  OidcModule,
  OidcService,
  type OidcAuthorizationUrlParams,
  type OidcAuthorizationUrlResult,
  type OidcDiscoveryDocument,
  type OidcIdTokenClaims,
  type OidcModuleAsyncOptions,
  type OidcModuleOptions,
  type OidcTokenExchangeParams,
  type OidcTokenExchangeResult,
  type OidcVerifyIdTokenOptions,
} from "./oauth/oidc.service";

// Rate Limiting / Throttler
export {
  DEFAULT_IPV6_SUBNET_PREFIX,
  days,
  hours,
  minutes,
  normalizeIp,
  seconds,
  weeks,
} from "./throttler/throttler.utils";
export {
  ThrottlerException,
  throttlerMessage,
} from "./throttler/throttler.exception";
export {
  SKIP_THROTTLE_METADATA,
  THROTTLER_OPTIONS,
  THROTTLER_STORAGE,
  THROTTLE_METADATA,
  ThrottlerStorage,
  getOptionsToken,
  getStorageToken,
  type Resolvable,
  type ThrottleDecoratorConfig,
  type ThrottleOverride,
  type ThrottlerAsyncOptions,
  type ThrottlerGenerateKeyFunction,
  type ThrottlerGetTrackerFunction,
  type ThrottlerLimitDetail,
  type ThrottlerModuleAsyncOptions,
  type ThrottlerModuleOptions,
  type ThrottlerModuleOptionsObject,
  type ThrottlerOptions,
  type ThrottlerOptionsFactory,
  type ThrottlerRequest,
  type ThrottlerRule,
  type ThrottlerSkipIfFunction,
  type ThrottlerStorageOptions,
  type ThrottlerStorageRecord,
} from "./throttler/throttler.interface";
export {
  DEFAULT_SWEEP_INTERVAL,
  MEMORY_THROTTLER_SWEEP_MS,
  MemoryThrottlerStorage,
  ThrottlerStorageService,
} from "./throttler/memory-throttler.storage";
export {
  LUA_FIXED_WINDOW_INCREMENT,
  LUA_SLIDING_WINDOW_INCREMENT,
  RedisThrottlerStorage,
  type RedisThrottlerAlgorithm,
  type RedisThrottlerClientLike,
  type RedisThrottlerStorageOptions,
} from "./throttler/redis-throttler.storage";
export {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  SkipThrottle,
  Throttle,
} from "./throttler/throttler.decorators";
export { ThrottlerGuard } from "./throttler/throttler.guard";
export { ThrottlerModule } from "./throttler/throttler.module";

// Production Auth Storage Adapters
export {
  RedisAuthenticationStore,
  type RedisAuthClientLike,
  type RedisAuthenticationStoreOptions,
} from "./auth-next/storage/redis-auth.store";
export {
  SqlAuthenticationStore,
  createBunSqliteAuthExecutor,
  getAuthMigrationSql,
  getAuthMigrationStatements,
  type AuthMigrationOptions,
  type BunSqlClientLike,
  type BunSqliteDatabaseLike,
  type SqlAuthDialect,
  type SqlAuthExecutorLike,
  type SqlAuthQueryExecutor,
  type SqlAuthQueryResult,
  type SqlAuthenticationStoreOptions,
} from "./auth-next/storage/sql-auth.store";

// Passkeys / WebAuthn (FIDO2)
export {
  CborDecodeError,
  decodeCbor,
  decodeCborPrefix,
  encodeCbor,
  type CborDecodeOptions,
  type CborDecodePrefixResult,
  type CborKey,
  type CborValue,
} from "./auth-next/webauthn/cbor.util";
export {
  COSE_ALG_EDDSA,
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  COSE_CRV_ED25519,
  COSE_CRV_P256,
  COSE_KTY_EC2,
  COSE_KTY_OKP,
  COSE_KTY_RSA,
  CoseKeyError,
  DEFAULT_WEBAUTHN_ALGORITHMS,
  derToP1363,
  importCosePublicKey,
  p1363ToDer,
  parseCosePublicKey,
  verifyCoseSignature,
  type ParsedCosePublicKey,
} from "./auth-next/webauthn/cose.util";
export { InMemoryPasskeyStore } from "./auth-next/webauthn/in-memory-passkey.store";
export {
  WebAuthnService,
  parseAuthenticatorData,
  type ParsedAuthenticatorData,
} from "./auth-next/webauthn/webauthn.service";
export type {
  AttestationConveyancePreference,
  AuthenticationOptions,
  AuthenticatorAttachment,
  AuthenticatorSelectionCriteria,
  AuthenticatorTransport,
  CoseAlgorithmIdentifier,
  GenerateAuthenticationOptionsInput,
  GenerateRegistrationOptionsInput,
  PasskeyChallengeRecord,
  PasskeyChallengeType,
  PasskeyCredential,
  PasskeyDeviceType,
  PasskeyStore,
  PublicKeyCredentialDescriptorJSON,
  RegistrationOptions,
  ResidentKeyRequirement,
  UserVerificationRequirement,
  VerifiedAuthenticationResult,
  VerifiedRegistrationResult,
  VerifyAuthenticationInput,
  VerifyRegistrationInput,
  WebAuthnOptions,
} from "./auth-next/webauthn/webauthn.interface";

// Security Headers Middleware
export {
  SECURITY_HEADERS_OPTIONS,
  SecurityHeadersMiddleware,
  createSecurityHeadersMiddleware,
  type SecurityHeadersOptions,
  type StrictTransportSecurityOptions,
} from "./headers/security-headers.middleware";
