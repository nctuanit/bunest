# Multi-Auth Security (Zero Passport)

Demonstrates Bunest's native identity & authorization stack (`@bunest/security/auth` + `@bunest/security/authz`) with **zero Passport** and **zero external runtime dependencies**:

- **Argon2id password hashing** (`PasswordHasher`)
- **JWT access tokens + rotating opaque refresh token families** (`TokenService`) with automatic reuse detection & family revocation
- **Multi-provider credential chain** (`JwtBearerProvider` + `ApiKeyProvider` registered on `AuthenticationRegistry`)
- **TOTP MFA** (`MfaService` — AES-GCM encrypted secrets, RFC 6238 verification, `amr: ["mfa"]` elevation)
- **ABAC Policy-based authorization** (`@Policy()`, `@Can()`, `AuthorizationGuard` deny-by-default)

## Run

```bash
bun run --cwd examples/multi-auth-security dev
bun test examples/multi-auth-security
```
