# @bunest/authentication

Next-generation NestJS v12 authentication for Bunest — sessions, JWTs & refresh-token families, API keys, TOTP MFA & recovery codes, passwordless magic links, email verification, password reset, and OAuth 2.0 / OpenID Connect with zero external runtime dependencies and zero RxJS.

## Features

- **Module & Guard**: `AuthenticationModule.forRoot()` / `forRootAsync()`, global `AuthenticationGuard`, `AuthenticationRegistry`, `AuthenticationStorage` (with production in-memory guard), `AuthenticationContext` (`AsyncLocalStorage`), `@Public()`, `@Authenticate()`, `@CurrentUser()`, `@CurrentSession()`, and `WsAuthenticator`.
- **Sessions & CSRF**: `SessionService`, `SignInService`, and `SessionCookieProvider` with `__Host-` cookies, idle + absolute expiry, session fixation defense, and cross-origin write protection.
- **JWT & Refresh Tokens**: `JwtSigner`, `JwtVerifier`, `JwksClient`, `JwtBearerProvider`, and `TokenService` with strict `alg: "none"` rejection, key-confusion prevention, and refresh-token family reuse detection.
- **API Keys & Passwords**: `ApiKeyProvider` (constant-time verification) and `PasswordHasher` (scrypt + NFKC normalization + timing equalization).
- **MFA, Magic Links, OIDC & Account Flows**: `MfaService` (AES-256-GCM encrypted TOTP secrets, replay protection, lockout, recovery codes), `MagicLinkService` (browser-bound), `OidcService` (`google`, `github`, `microsoft` presets, PKCE S256, RFC 9207 `iss`), `EmailVerificationService`, and `PasswordResetService`.
- **Observability**: Zero-RxJS `AuthenticationEvents` (`events$` supporting `.subscribe()` and `for await`) plus `node:diagnostics_channel`.
- **Contract Testing**: `@bunest/authentication/testing` exports the runner-agnostic `authenticationStoreContract` compliance suite.

## Installation

```bash
bun add @bunest/authentication
```

## Quick Start

```ts
import { Controller, Get, Module } from "@bunest/common";
import {
  AuthenticationModule,
  CurrentUser,
  Public,
} from "@bunest/authentication";

@Controller("profile")
export class ProfileController {
  @Get("me")
  getProfile(@CurrentUser() user: { id: string }) {
    return { user };
  }

  @Public()
  @Get("health")
  health() {
    return { status: "ok" };
  }
}

@Module({
  imports: [
    AuthenticationModule.forRoot({
      session: { secret: process.env.SESSION_SECRET! },
    }),
  ],
  controllers: [ProfileController],
})
export class AppModule {}
```

## Key Exports

- **Module & Core**: `AuthenticationModule`, `AUTHENTICATION_MODULE_OPTIONS`, `AuthenticationGuard`, `AuthenticationRegistry`, `AuthenticationStorage`, `AuthenticationContext`, `AuthenticationEvents`, `WsAuthenticator`
- **Decorators**: `@Authenticate()`, `@Public()`, `@CurrentUser()`, `@CurrentSession()`
- **Providers & Services**: `AuthenticationProvider`, `ApiKeyProvider`, `JwtBearerProvider`, `SessionCookieProvider`, `SessionService`, `SignInService`, `TokenService`, `JwtSigner`, `JwtVerifier`, `JwksClient`, `PasswordHasher`, `MfaService`, `MagicLinkService`, `MagicLinkHandler`, `OidcService`, `OidcAccountResolver`, `EmailVerificationService`, `EmailVerificationHandler`, `PasswordResetService`, `PasswordResetHandler`
- **OIDC Presets**: `google`, `github`, `microsoft`
- **In-Memory Stores**: `InMemorySessionStore`, `InMemoryRefreshTokenStore`, `InMemoryMfaStore`, `InMemoryMagicLinkStore`, `InMemoryOidcStateStore`, `InMemoryEmailTokenStore`
- **Errors**: `AuthenticationError`, `JwtError`, `MagicLinkError`, `MfaAlreadyEnrolledError`, `RefreshTokenError`

## Subpath Exports

- **`@bunest/authentication/testing`**: `authenticationStoreContract` (runner-agnostic compliance suite for custom session, refresh-token, MFA, magic-link, OIDC-state, and email-token stores)

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
