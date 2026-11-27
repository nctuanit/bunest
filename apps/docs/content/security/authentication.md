# Authentication

**`@bunest/security/auth`** is Bunest's zero-dependency identity and authentication engine built on native WebCrypto and `Bun.password` (Argon2id). It supports stateful sessions, Bearer JWT/JWKS, refresh-token rotation families with automatic reuse detection, TOTP MFA, magic links, OIDC/OAuth2, and scoped API keys.

## Installation

```bash
bun add @bunest/security
```

## Architecture Overview

Every authentication strategy plugs into a unified `AuthenticationModule` and resolves a normalized principal into `AuthenticationContext`:

| Strategy | Use Case | Backing Primitive |
| --- | --- | --- |
| **Sessions** | Web apps, server-rendered UIs, instant server-side revocation | `HttpOnly` + `SameSite` cookies + `SessionStore` |
| **JWT / JWKS** | Stateless mobile & SPA APIs, federated identity providers | Native WebCrypto (`HS256`, `RS256`, `ES256`, `EdDSA`) |
| **Refresh Token Families** | Long-lived sessions with theft/reuse detection | Rotating family store (revokes entire family on replay) |
| **API Keys** | Machine-to-machine integrations & developer tokens | Prefix + hashed secret verification |
| **TOTP MFA & Magic Links** | Step-up 2FA & passwordless sign-in | RFC 6238 TOTP & single-use expiring tokens |
| **OIDC / OAuth2** | Social login & enterprise SSO (Google, GitHub, Okta) | PKCE `S256` + state/nonce verification |

## Module Configuration

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { AuthenticationModule } from "@bunest/security/auth";

@Module({
  imports: [
    AuthenticationModule.forRoot({}),
  ],
})
export class AppModule {}
```

## Protecting Routes with `@Authenticate()` & `@CurrentSession()`

Apply `@Authenticate()` at the controller or handler level, and inject the resolved session or user with `@CurrentSession()` / `@CurrentUser()`:

@@filename(account.controller.ts)

```ts
import { Controller, Get, Post } from "@bunest/core";
import { CurrentUser, Public } from "@bunest/security";
import { Authenticate, CurrentSession } from "@bunest/security/auth";

@Authenticate()
@Controller("account")
export class AccountController {
  @Get("me")
  getProfile(
    @CurrentUser() user: { id: string; email: string },
    @CurrentSession() session: { id: string; expiresAt: Date },
  ) {
    return { user, sessionId: session.id, expiresAt: session.expiresAt };
  }

  @Public()
  @Post("login")
  login() {
    // Public sign-in route bypasses @Authenticate()
    return { ok: true };
  }
}
```

## Password Hashing with `PasswordService`

Never roll custom password hashing. Use `PasswordService` (powered by `Bun.password` Argon2id with safe memory/time defaults):

@@filename(auth.service.ts)

```ts
import { Injectable, UnauthorizedException } from "@bunest/core";
import { PasswordService } from "@bunest/security";

@Injectable()
export class AuthService {
  constructor(private readonly passwords: PasswordService) {}

  async register(email: string, plainPassword: string) {
    const passwordHash = await this.passwords.hash(plainPassword);
    return { email, passwordHash };
  }

  async verifyLogin(plainPassword: string, storedHash: string) {
    const valid = await this.passwords.verify(plainPassword, storedHash);
    if (!valid) {
      throw new UnauthorizedException("Invalid credentials");
    }
  }
}
```

## Refresh-Token Rotation & Reuse Detection

When refresh tokens are rotated on every use, Bunest tracks each token's **family ID**. If a previously rotated (already spent) refresh token is presented again—indicating token theft—the entire token family is immediately revoked and an audit event is emitted via `AuthenticationEvents`.

## Testing Custom Stores (`@bunest/security/testing`)

If you implement a custom `SessionStore` or `RefreshTokenStore` (for PostgreSQL, Redis, or DynamoDB), verify it against the official store contract test suite exported from `@bunest/security/testing` so edge cases like expiration, atomic rotation, and family revocation are guaranteed to behave identically.

> info **Next Steps** Combine `@bunest/security/auth` with policy-based access control in [Authorization](/security/authorization) and one-line security hardening in [Security Module](/security/security-module).
