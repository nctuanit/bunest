# @bunest/security

Comprehensive zero-dependency security toolkit for **Bunest**. Provides WebCrypto JWT signing/verification, Passport-compatible authentication strategies, RBAC/policy guards, password hashing, OAuth2/OIDC/PKCE/JWKS, CSRF/sessions, rate limiting, security headers, and safe file storage.

## Features

- **JWT & JWKS**: `JwtModule`, `JwtService`, `JwksModule`, `JwksClient`, `JwksService`, and WebCrypto signing/verification with full error classes (`TokenExpiredError`, `NotBeforeError`, `JsonWebTokenError`).
- **Authentication & Passport Parity**: `AuthModule`, `PassportModule`, `PassportStrategy`, `AuthGuard`, `JwtAuthGuard`, `JwtAuthStrategy`, `JwksJwtAuthStrategy`, `ApiKeyAuthStrategy`, `BasicAuthStrategy`, `@Public()`, `@CurrentUser()`, `@Auth()`, and `@Protected()`.
- **Authorization & Passwords**: `RolesGuard` (`@Roles()`), `PoliciesGuard` (`@CheckPolicies()`), and `PasswordService` (Argon2id/scrypt hashing).
- **OAuth2, OIDC & PKCE**: `OAuth2Module`, `OAuth2Service`, `OidcModule`, `OidcService`, `OAuth2Providers` (Google, GitHub, Microsoft, Auth0, Okta), and PKCE helpers (`generatePkcePair`, `computePkceChallenge`, `verifyPkceChallenge`).
- **Sessions, CSRF, Headers & Rate Limiting**: `SessionCookieService`, `CsrfGuard`, `SecurityHeadersMiddleware`, and `ThrottlerModule` / `ThrottlerGuard` (`@Throttle()`, `@SkipThrottle()`).
- **Safe Storage Adapters**: `StorageModule`, `LocalStorageAdapter`, `MemoryStorageAdapter`, `S3StorageAdapter`, and path-traversal protection (`assertSafeStorageKey()`).

## Installation

```bash
bun add @bunest/security
```

## Quick Start

```ts
import { Controller, Get, Module, UseGuards } from "@bunest/common";
import {
  CurrentUser,
  JwtAuthGuard,
  JwtModule,
  JwtService,
  Public,
  Roles,
  RolesGuard,
} from "@bunest/security";

@Controller("accounts")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AccountsController {
  constructor(private readonly jwt: JwtService) {}

  @Public()
  @Get("token")
  issueDemoToken() {
    return { token: this.jwt.sign({ sub: "user_1", roles: ["admin"] }) };
  }

  @Get("me")
  @Roles("admin")
  me(@CurrentUser() user: { sub: string; roles: string[] }) {
    return user;
  }
}

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? "dev-secret",
      signOptions: { expiresIn: "1h" },
    }),
  ],
  controllers: [AccountsController],
})
export class AppModule {}
```

## Key Exports

- **Modules**: `SecurityModule`, `JwtModule`, `AuthModule`, `PassportModule`, `JwksModule`, `OAuth2Module`, `OidcModule`, `ThrottlerModule`, `StorageModule`
- **JWT & Crypto**: `JwtService`, `JwksClient`, `JwksService`, `PasswordService`, `randomToken`, `timingSafeEqualString`, `base64UrlEncode`, `base64UrlDecode`
- **Guards & Decorators**: `JwtAuthGuard`, `AuthGuard`, `RolesGuard`, `PoliciesGuard`, `CsrfGuard`, `ThrottlerGuard`, `Auth`, `Protected`, `Public`, `Roles`, `CheckPolicies`, `CurrentUser`, `Throttle`, `SkipThrottle`
- **Strategies & OAuth**: `PassportStrategy`, `AbstractStrategy`, `JwtAuthStrategy`, `JwksJwtAuthStrategy`, `ApiKeyAuthStrategy`, `BasicAuthStrategy`, `OAuth2Service`, `OidcService`, `OAuth2Providers`, `generatePkcePair`
- **Middleware & Storage**: `SecurityHeadersMiddleware`, `SessionCookieService`, `MemoryThrottlerStorage`, `LocalStorageAdapter`, `MemoryStorageAdapter`, `S3StorageAdapter`, `assertSafeStorageKey`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
