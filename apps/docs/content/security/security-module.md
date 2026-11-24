# Security, JWT, Passport & Throttler

**`@bunest/security`** is Bunest's unified, zero-external-dependency security suite combining JWT, Passport-compatible guards/strategies, rate limiting, and security headers in one package:

- `SecurityModule.forRoot()`, `@Auth()`, `@Protected()`, `PasswordService` (`argon2id`), `RolesGuard`/`PoliciesGuard`, `CsrfGuard`, and `SecurityHeadersMiddleware`.
- WebCrypto `JwtModule`/`JwtService`, `JwksModule`, and `OAuth2Module`/`OidcModule` (PKCE).
- `PassportModule`, `AuthGuard`, and `PassportStrategy`.
- `ThrottlerModule`, `ThrottlerGuard`, `@Throttle`, and `@SkipThrottle`.

## Installation

```bash
bun add @bunest/security
```

## Declarative `SecurityModule.forRoot()`

Wire JWT authentication, RBAC, rate limiting, and security headers in a single module registration:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { SecurityModule } from "@bunest/security";

@Module({
  imports: [
    SecurityModule.forRoot({
      jwt: {
        secret: process.env.JWT_SECRET!,
        expiresIn: "15m",
      },
      throttler: {
        ttl: 60_000,
        limit: 100,
      },
      headers: true,
    }),
  ],
})
export class AppModule {}
```

## Route Protection with `@Auth()` & `@Protected()`

@@filename(admin.controller.ts)

```ts
import { Controller, Get } from "@bunest/core";
import { Auth, CurrentUser, Public, Throttle } from "@bunest/security";

@Controller("admin")
export class AdminController {
  @Get("health")
  @Public()
  health() {
    return { status: "ok" };
  }

  @Get("users")
  @Auth("admin")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  listUsers(@CurrentUser() user: { sub: string; roles: string[] }) {
    return { requestedBy: user.sub };
  }
}
```

## Argon2id Passwords & WebCrypto JWT

`PasswordService` uses Bun's native `Bun.password` (`argon2id`), and `JwtService` uses WebCrypto (`HS256`/`HS384`/`HS512`/`RS256`/`ES256`/`EdDSA`) with strict algorithm pinning (never accepting `alg: "none"`):

@@filename(auth.service.ts)

```ts
import { Injectable, UnauthorizedException } from "@bunest/core";
import { JwtService, PasswordService } from "@bunest/security";

@Injectable()
export class AuthService {
  constructor(
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
  ) {}

  async issueToken(userId: string, plainPassword: string, hash: string) {
    const valid = await this.passwords.verify(plainPassword, hash);
    if (!valid) throw new UnauthorizedException("Invalid credentials");
    return this.jwt.signAsync({ sub: userId });
  }
}
```
