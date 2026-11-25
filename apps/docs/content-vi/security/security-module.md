# Bảo mật, JWT, Passport & Throttler

**`@bunest/security`** là bộ giải pháp bảo mật hợp nhất, không phụ thuộc thư viện ngoài của Bunest, kết hợp JWT, guard/strategy tương thích Passport, giới hạn tốc độ (rate limiting) và security headers trong cùng một gói:

- `SecurityModule.forRoot()`, `@Auth()`, `@Protected()`, `PasswordService` (`argon2id`), `RolesGuard`/`PoliciesGuard`, `CsrfGuard` và `SecurityHeadersMiddleware`.
- WebCrypto `JwtModule`/`JwtService`, `JwksModule` và `OAuth2Module`/`OidcModule` (PKCE).
- `PassportModule`, `AuthGuard` và `PassportStrategy`.
- `ThrottlerModule`, `ThrottlerGuard`, `@Throttle` và `@SkipThrottle`.

## Cài đặt

```bash
bun add @bunest/security
```

## Cấu hình khai báo `SecurityModule.forRoot()`

Kết nối xác thực JWT, RBAC, giới hạn tốc độ và security headers chỉ trong một lần đăng ký module duy nhất:

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

## Bảo vệ Route với `@Auth()` & `@Protected()`

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

## Mật khẩu Argon2id & WebCrypto JWT

`PasswordService` sử dụng `Bun.password` (`argon2id`) thuần Bun, còn `JwtService` sử dụng WebCrypto (`HS256`/`HS384`/`HS512`/`RS256`/`ES256`/`EdDSA`) với cơ chế ghim thuật toán nghiêm ngặt (không bao giờ chấp nhận `alg: "none"`):

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
