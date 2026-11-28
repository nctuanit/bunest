# Xác thực (Authentication)

**`@bunest/security/auth`** là hệ thống xác thực zero-dependency của Bunest xây dựng trực tiếp trên WebCrypto và `Bun.password` (Argon2id) — hỗ trợ phiên đăng nhập (sessions), Bearer JWT/JWKS, refresh-token rotation families kèm phát hiện dùng lại token, TOTP MFA, magic links, OIDC/OAuth2 và API keys.

## Cài đặt

```bash
bun add @bunest/security
```

## Tổng quan kiến trúc

Mọi chiến lược xác thực đều cắm vào `AuthenticationModule` thống nhất và giải mã danh tính người dùng vào `AuthenticationContext`:

| Chiến lược | Trường hợp sử dụng | Nền tảng kỹ thuật |
| --- | --- | --- |
| **Sessions** | Ứng dụng web, UI SSR, thu hồi phiên tức thì phía server | Cookie `HttpOnly` + `SameSite` + `SessionStore` |
| **JWT / JWKS** | API stateless cho mobile & SPA, hệ thống định danh liên kết | WebCrypto thuần (`HS256`, `RS256`, `ES256`, `EdDSA`) |
| **Refresh Token Families** | Phiên dài hạn có phát hiện đánh cắp/tái sử dụng token | Store xoay vòng theo family (thu hồi cả family khi bị replay) |
| **API Keys** | Tích hợp machine-to-machine & developer tokens | Kiểm tra prefix + secret đã băm |
| **TOTP MFA & Magic Links** | Xác thực 2 lớp & đăng nhập không mật khẩu | TOTP chuẩn RFC 6238 & token dùng một lần có hạn |
| **Passkeys / WebAuthn (FIDO2)** | Đăng nhập sinh trắc học / khóa phần cứng chống phishing | `WebAuthnService` thuần Bun (CBOR/COSE `ES256`, `RS256`, `EdDSA`) |
| **OIDC / OAuth2** | Đăng nhập mạng xã hội & SSO doanh nghiệp (Google, GitHub, Microsoft, Okta) | PKCE `S256` + xác thực state/nonce |
| **Tích hợp Auth hiện đại** | Cắm trực tiếp Better Auth, Clerk, Supabase, Auth0, Auth.js, Lucia | `BetterAuthModule`, `ExternalJwtAuthModule`, `WebAuthModule` |

## Cấu hình Module

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

## Bảo vệ route với `@Authenticate()` & `@CurrentSession()`

Gắn `@Authenticate()` ở mức controller hoặc handler, rồi trích xuất thông tin user/session bằng `@CurrentUser()` và `@CurrentSession()`:

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
    // Route đăng nhập công khai bỏ qua @Authenticate()
    return { ok: true };
  }
}
```

## Băm mật khẩu an toàn với `PasswordService`

Luôn dùng `PasswordService` (sử dụng `Bun.password` Argon2id với cấu hình bộ nhớ/thời gian an toàn mặc định):

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
      throw new UnauthorizedException("Thông tin đăng nhập không hợp lệ");
    }
  }
}
```

## Xoay vòng Refresh Token & Phát hiện tái sử dụng

Mỗi lần làm mới token, Bunest xoay vòng token và theo dõi **family ID**. Nếu một refresh token cũ (đã dùng rồi) bị gửi lại — dấu hiệu token bị đánh cắp — toàn bộ family sẽ bị thu hồi ngay lập tức và phát sự kiện kiểm toán qua `AuthenticationEvents`.

## Kiểm thử Custom Store (`@bunest/security/testing`)

Khi tự triển khai `SessionStore` hoặc `RefreshTokenStore` (PostgreSQL, Redis, DynamoDB), hãy chạy bộ contract test chính thức từ `@bunest/security/testing` để đảm bảo hết hạn, xoay vòng nguyên tử và thu hồi family hoạt động chính xác.

> info **Bước tiếp theo** Xem hướng dẫn cắm trực tiếp Better Auth, Clerk, Supabase, Auth0, Auth.js và Lucia tại [Tích hợp Auth hiện đại](/security/modern-auth-integrations), kết hợp phân quyền ABAC tại [Phân quyền (Authorization)](/security/authorization) và cấu hình bảo mật tổng thể tại [Security Module](/security/security-module).
