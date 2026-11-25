# Xác thực (Authentication)

**`@bunest/security/auth`** là module định danh và xác thực đầy đủ tính năng, không phụ thuộc thư viện ngoài dành cho Bunest, hỗ trợ session có trạng thái (stateful), token JWT/JWKS, họ refresh-token xoay vòng (kèm phát hiện tái sử dụng), TOTP MFA, magic link, OIDC/OAuth2, API key và băm mật khẩu Argon2id.

## Cài đặt

```bash
bun add @bunest/security/auth
```

## Các tính năng chính

- **Xác thực đa nhà cung cấp:** Session, Bearer JWT/JWKS, API key (`ApiKeyProvider`), OAuth2/OIDC, magic link và TOTP MFA.
- **Họ refresh-token (Refresh-token families):** Tự động xoay vòng token và thu hồi toàn bộ họ bị xâm phạm khi phát hiện tái sử dụng token.
- **Ngữ cảnh yêu cầu & guard:** `AuthenticationGuard`, `@Authenticate()` và `AuthenticationContext` giúp truy cập thực thể định danh đã xác thực ở bất kỳ đâu trong vòng đời request.
- **Sự kiện vòng đời:** `AuthenticationEvents` phục vụ kiểm toán đăng nhập, đăng xuất, thử thách MFA và thu hồi token.
- **Bộ kiểm thử hợp đồng (`@bunest/security/testing`):** Xác minh các session/token store tùy chỉnh theo hợp đồng store chính thức.

## Bắt đầu nhanh

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

Bảo vệ các controller hoặc route bằng `@Authenticate()` và `AuthenticationGuard`, đồng thời kiểm tra danh tính đang hoạt động thông qua `AuthenticationContext`.
