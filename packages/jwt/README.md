# @bunest/jwt

Drop-in 1:1 `@nestjs/jwt` (v12) migration facade for Bunest, powered natively by `@bunest/security` WebCrypto JWT signing and verification with zero external runtime dependencies.

## Features

- **Drop-In `@nestjs/jwt` Parity**: Replace `@nestjs/jwt` imports with `@bunest/jwt` verbatim.
- **WebCrypto Signing & Verification**: `JwtService` supports `sign`, `signAsync`, `verify`, `verifyAsync`, and `decode` for symmetric (HMAC) and asymmetric (RSA/ECDSA/EdDSA) keys.
- **Sync & Async Configuration**: `JwtModule.register()` and `JwtModule.registerAsync()` with dynamic secret providers (`JwtSecretRequestType`).
- **NestJS & JWT Error Compatibility**: Exports both standard JWT errors (`JsonWebTokenError`, `TokenExpiredError`, `NotBeforeError`) and Bunest JWT exceptions (`JwtException`, `JwtExpiredException`, `JwtInvalidException`, `JwtNotBeforeException`).

## Installation

```bash
bun add @bunest/jwt
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import { JwtModule, JwtService } from "@bunest/jwt";

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? "change-me",
      signOptions: { expiresIn: "15m" },
    }),
  ],
})
export class AuthModule {}

@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  async issueToken(userId: string) {
    return this.jwt.signAsync({ sub: userId });
  }
}
```

## Key Exports

- **Module & Service**: `JwtModule` (`register`, `registerAsync`), `JwtService`, `JwtSecretRequestType`
- **Errors**: `JsonWebTokenError`, `TokenExpiredError`, `NotBeforeError`, `WrongSecretProviderError`, `JwtException`, `JwtExpiredException`, `JwtInvalidException`, `JwtNotBeforeException`
- **Tokens**: `JWT_MODULE_OPTIONS`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
