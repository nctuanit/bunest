// Module
export { AuthenticationModule } from "./authentication.module";
export type { AuthenticationModuleAsyncOptions } from "./authentication.module-definition";
export { AUTHENTICATION_MODULE_OPTIONS } from "./authentication.constants";

// Registration: credential providers and feature handlers
export { AuthenticationRegistry } from "./services/authentication-registry.service";

// Storage
export { AuthenticationStorage } from "./storage/authentication.storage";
export {
  RedisAuthenticationStore,
  type RedisAuthClientLike,
  type RedisAuthenticationStoreOptions,
} from "./storage/redis-auth.store";
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
} from "./storage/sql-auth.store";

// Routes and the current user
export { AuthenticationGuard } from "./guards/authentication.guard";
export { Authenticate } from "./decorators/authenticate.decorator";
export { CurrentSession } from "./decorators/current-session.decorator";
export { CurrentUser } from "./decorators/current-user.decorator";
export { Public } from "./decorators/public.decorator";
export { AuthenticationContext } from "./context/authentication.context";
export { WsAuthenticator } from "./services/ws-authenticator.service";

// Writing a credential provider & API keys
export { AuthenticationProvider } from "./providers/authentication.provider";
export { ApiKeyProvider } from "./providers/api-key.provider";

// Errors
export { AuthenticationError } from "./errors/authentication.error";
export { JwtError } from "./errors/jwt.error";
export { MagicLinkError } from "./errors/magic-link.error";
export { MfaAlreadyEnrolledError } from "./errors/mfa-already-enrolled.error";
export { RefreshTokenError } from "./errors/refresh-token.error";

// Audit events (also on `nestjs:authentication:<type>` diagnostics channels)
export { AuthenticationEvents } from "./events/authentication-events.service";
export type {
  AuthenticationEmailVerifiedEvent,
  AuthenticationEvent,
  AuthenticationMagicLinkRefusedEvent,
  AuthenticationMfaDisabledEvent,
  AuthenticationMfaEnabledEvent,
  AuthenticationMfaFailedEvent,
  AuthenticationMfaVerifiedEvent,
  AuthenticationPasswordResetEvent,
  AuthenticationPasswordResetRequestedEvent,
  AuthenticationRecoveryCodesGeneratedEvent,
  AuthenticationRefreshTokenReusedEvent,
  AuthenticationSignInEvent,
  AuthenticationSignOutEvent,
} from "./events/authentication-events.interface";

// Public interfaces & types
export type {
  AccessTokenResult,
  IssuedTokens,
  IssueTokensOptions,
  RefreshClaimsMapper,
  RefreshTokenMapOptions,
  TokenPair,
} from "./interfaces/token.interface";
export type {
  ApiKeyProviderOptions,
  ApiKeyRecord,
  ApiKeySession,
  GeneratedApiKey,
} from "./interfaces/api-key.interface";
export type { AuthenticateOptions } from "./interfaces/authenticate-options.interface";
export type { AuthenticationErrorOptions } from "./interfaces/authentication-error-options.interface";
export type {
  AuthenticationHandlerName,
  AuthenticationHandlers,
  CredentialProvider,
  RegisterHandlerOptions,
  RegisterProviderOptions,
} from "./interfaces/authentication-registry.interface";
export type {
  AuthenticationModuleOptions,
  AuthenticationOptionsFactory,
} from "./interfaces/authentication-module-options.interface";
export type {
  AuthenticationResult,
  MfaState,
  SessionExtra,
} from "./interfaces/authentication-result.interface";
export type {
  AuthenticationStorageContract,
  AuthenticationStorageRegisterOptions,
  AuthenticationStorageSources,
} from "./interfaces/authentication-storage.interface";
export type { Duration } from "./interfaces/duration.interface";
export type {
  EmailTokenPurpose,
  EmailTokenRecord,
  EmailTokenStore,
} from "./interfaces/email-token-store.interface";
export type {
  EmailVerificationLink,
  EmailVerificationOptions,
} from "./interfaces/email-verification.interface";
export type {
  IssuedSession,
  SessionOptions,
} from "./interfaces/session.interface";
export type { JwksClientOptions } from "./interfaces/jwks-client-options.interface";
export type { JwsAlgorithm, JwtClaims } from "./interfaces/jwt.interface";
export type {
  JwtBearerProviderOptions,
  JwtSignerOptions,
  JwtVerifierOptions,
} from "./interfaces/jwt-options.interface";
export type {
  CreatedMagicLink,
  MagicLink,
  MagicLinkAccount,
  MagicLinkOptions,
  MagicLinkRequest,
} from "./interfaces/magic-link.interface";
export type {
  MagicLinkRecord,
  MagicLinkStore,
} from "./interfaces/magic-link-store.interface";
export type { MfaOptions } from "./interfaces/mfa-options.interface";
export type { MfaStore, TotpRecord } from "./interfaces/mfa-store.interface";
export type {
  OAuthTokens,
  OidcProfile,
  OidcProviderConfig,
} from "./interfaces/oidc-provider.interface";
export type {
  OidcOptions,
  OidcRedirect,
  OidcRequest,
  OidcResolveContext,
  OidcStartOptions,
  OidcTransaction,
} from "./interfaces/oidc.interface";
export type { OidcStateStore } from "./interfaces/oidc-state-store.interface";
export type { PasswordHasherOptions } from "./interfaces/password-hasher-options.interface";
export type {
  PasswordResetAccount,
  PasswordResetLink,
  PasswordResetOptions,
  PasswordResetResult,
  ResetPasswordOptions,
} from "./interfaces/password-reset.interface";
export type { RefreshTokenOptions } from "./interfaces/refresh-token-options.interface";
export type {
  RefreshTokenRecord,
  RefreshTokenStore,
} from "./interfaces/refresh-token-store.interface";
export type {
  SessionRecord,
  SessionStore,
} from "./interfaces/session-store.interface";
export type { SignInOptions } from "./interfaces/sign-in-options.interface";

// Sessions
export { SessionCookieProvider } from "./session/session-cookie.provider";
export { InMemorySessionStore } from "./session/in-memory-session.store";
export { SessionService } from "./session/session.service";
export { SignInService } from "./session/sign-in.service";

// Passwords
export { PasswordHasher } from "./services/password-hasher.service";

// Second factor (TOTP and recovery codes)
export { InMemoryMfaStore } from "./mfa/in-memory-mfa.store";
export { MfaService } from "./mfa/mfa.service";

// JWTs, access and refresh tokens
export { JwksClient } from "./jwt/jwks.client";
export { JwtBearerProvider } from "./jwt/jwt-bearer.provider";
export { JwtSigner } from "./jwt/jwt-signer.service";
export { JwtVerifier } from "./jwt/jwt-verifier.service";
export { InMemoryRefreshTokenStore } from "./jwt/in-memory-refresh-token.store";
export { TokenService } from "./jwt/token.service";

// Magic links
export { MagicLinkHandler } from "./magic-link/magic-link.handler";
export { MagicLinkService } from "./magic-link/magic-link.service";
export { InMemoryMagicLinkStore } from "./magic-link/in-memory-magic-link.store";

// Password reset and email verification
export { InMemoryEmailTokenStore } from "./account/in-memory-email-token.store";
export { EmailVerificationHandler } from "./account/email-verification.handler";
export { EmailVerificationService } from "./account/email-verification.service";
export { PasswordResetHandler } from "./account/password-reset.handler";
export { PasswordResetService } from "./account/password-reset.service";

// OAuth 2.0 / OpenID Connect
export { OidcAccountResolver } from "./oidc/oidc-account.resolver";
export { OidcService } from "./oidc/oidc.service";
export { InMemoryOidcStateStore } from "./oidc/in-memory-oidc-state.store";
export { github, google, microsoft } from "./oidc/oidc.presets";

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
} from "./webauthn/cbor.util";
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
} from "./webauthn/cose.util";
export { InMemoryPasskeyStore } from "./webauthn/in-memory-passkey.store";
export {
  WebAuthnService,
  parseAuthenticatorData,
  type ParsedAuthenticatorData,
} from "./webauthn/webauthn.service";
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
} from "./webauthn/webauthn.interface";

// Modern auth ecosystem integrations (Better Auth, Auth.js, Lucia, Clerk, Supabase, Auth0, OIDC/JWKS)
export {
  BETTER_AUTH_INSTANCE,
  BETTER_AUTH_MODULE_OPTIONS,
  BetterAuthModule,
  BetterAuthProvider,
  EXTERNAL_JWT_AUTH_OPTIONS,
  ExternalJwtAuthModule,
  ExternalJwtProvider,
  ExternalSessionProvider,
  InjectBetterAuth,
  WEB_AUTH_MODULE_OPTIONS,
  WebAuthModule,
  extractBearerToken,
  extractCookieValue,
  extractHttpRequest,
  extractWebHeaders,
  normalizeAuthMountPath,
  parseCookieHeader,
  type Auth0AuthOptions,
  type Auth0User,
  type BetterAuthLike,
  type BetterAuthModuleAsyncOptions,
  type BetterAuthModuleOptions,
  type BetterAuthSessionEnvelope,
  type BetterAuthSharedOptions,
  type ClerkAuthOptions,
  type ClerkUser,
  type ExternalJwksAuthOptions,
  type ExternalJwtSharedOptions,
  type SupabaseAuthOptions,
  type SupabaseUser,
  type WebAuthHandler,
  type WebAuthModuleAsyncOptions,
  type WebAuthModuleOptions,
  type WebAuthSessionContext,
  type WebAuthSessionResolver,
} from "./integrations/index";

// Declaration merging hook
export type { AuthenticationTypes } from "./interfaces/authentication-types.interface";
