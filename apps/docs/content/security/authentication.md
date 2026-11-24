# Authentication

**`@bunest/security/auth`** is a full-featured, zero-dependency identity and authentication module for Bunest supporting stateful sessions, JWT/JWKS tokens, refresh-token rotation families (with reuse detection), TOTP MFA, magic links, OIDC/OAuth2, API keys, and Argon2id password hashing.

## Installation

```bash
bun add @bunest/security/auth
```

## Key Capabilities

- **Multi-provider authentication:** Sessions, Bearer JWT/JWKS, API keys (`ApiKeyProvider`), OAuth2/OIDC, magic links, and TOTP MFA.
- **Refresh-token families:** Automatic rotation and compromised-family revocation on token reuse.
- **Request context & guards:** `AuthenticationGuard`, `@Authenticate()`, and `AuthenticationContext` for accessing the authenticated principal anywhere in the request lifecycle.
- **Lifecycle events:** `AuthenticationEvents` for auditing logins, logouts, MFA challenges, and token revocations.
- **Contract test suite (`@bunest/security/testing`):** Verify custom session/token stores against the official store contract.

## Quick Start

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { AuthenticationModule } from "@bunest/security/auth";

@Module({
  imports: [
    AuthenticationModule.forRoot({
      providers: [
        // Configure SessionProvider, JwtProvider, ApiKeyProvider, OidcProvider, etc.
      ],
    }),
  ],
})
export class AppModule {}
```

Protect controllers or routes with `@Authenticate()` and `AuthenticationGuard`, and inspect the active identity via `AuthenticationContext`.
