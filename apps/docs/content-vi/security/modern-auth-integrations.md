# Tích hợp Auth hiện đại (Better Auth, Clerk, Supabase, Auth0, Auth.js, Lucia)

Bạn **không cần** phải dùng Passport.js cũ kỹ để xây dựng xác thực hiện đại trên Bunest.

Nhờ nền tảng **Web Standard `Request` / `Response`** và **WebCrypto** gốc của Bun, `@bunest/security/auth` cung cấp sẵn các **adapter trực tiếp, 0 phụ thuộc runtime ngoài** cho hệ sinh thái Auth TypeScript hiện đại — cắm thẳng vào `AuthenticationGuard`, `@CurrentUser()`, `@CurrentSession()`, `@Public()`, `@Authenticate()` và phân quyền ABAC `@Policy()` / `@Can()`.

## Bảng lựa chọn giải pháp Auth

| Giải pháp | Phù hợp nhất khi | API tích hợp | Phụ thuộc ngoài trong `@bunest/security` |
| --- | --- | --- | --- |
| **Bunest Native Auth** | Tự chủ hoàn toàn (Sessions, JWT + Refresh Rotation, TOTP MFA, Passkeys/WebAuthn, OIDC, API Keys) | `AuthenticationModule.forRoot(...)` | **0** |
| **Better Auth** | Auth TypeScript toàn diện có sẵn plugin (Organizations, Passkeys, 2FA, Social OAuth, Stripe) | `BetterAuthModule.forRoot({ auth })` | **0** (cài ở app của bạn) |
| **Clerk** | Hosted auth kèm UI dựng sẵn & tổ chức B2B | `ExternalJwtAuthModule.forClerk(...)` | **0** (WebCrypto JWKS gốc) |
| **Supabase Auth** | Dự án dùng Supabase Postgres & RLS | `ExternalJwtAuthModule.forSupabase(...)` | **0** (WebCrypto JWKS/HS256 gốc) |
| **Auth0 / Keycloak / WorkOS / Okta / Cognito / Firebase** | SSO doanh nghiệp, định danh B2B, nhà cung cấp OIDC | `ExternalJwtAuthModule.forAuth0(...)` / `.forJwks(...)` | **0** (WebCrypto JWKS gốc) |
| **Auth.js (`@auth/core`) & Lucia** | Auth handler chuẩn Web hoặc session cookie gọn nhẹ | `WebAuthModule.forRoot(...)` | **0** (cài ở app của bạn) |
| *Passport.js (tương thích cũ)* | Chỉ dùng khi chuyển dần codebase NestJS cũ chưa kịp viết lại | `PassportModule` / `AuthGuard()` | **0** (lớp tương thích) |

---

## 1. Better Auth (`BetterAuthModule`)

`BetterAuthModule` kết nối [Better Auth](https://www.better-auth.com/) vào Bunest chỉ trong một dòng đăng ký module:

1. **Tự động mount `auth.handler(req)`** tại `/api/auth` và `/api/auth/*` (chuyển thẳng Web `Request` nguyên bản chưa đọc body và giữ nguyên redirect + nhiều header `Set-Cookie`).
2. **Tự đăng ký `BetterAuthProvider`** vào `AuthenticationRegistry` để mọi route tự xác thực phiên qua `auth.api.getSession({ headers })` trên cả HTTP, WebSocket, GraphQL và MCP.
3. **Inject trực tiếp instance Better Auth** ở mọi service/controller qua `@InjectBetterAuth()` (hoặc token `BETTER_AUTH_INSTANCE`).

### Bước 1 — Cài đặt `better-auth` trong dự án của bạn

```bash
bun add better-auth @bunest/security
```

### Bước 2 — Khởi tạo Better Auth instance

@@filename(src/auth.ts)

```ts
import { betterAuth } from "better-auth";
import { Database } from "bun:sqlite";

export const auth = betterAuth({
  database: new Database("./auth.sqlite"),
  basePath: "/api/auth",
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    github: {
      clientId: Bun.env.GITHUB_CLIENT_ID!,
      clientSecret: Bun.env.GITHUB_CLIENT_SECRET!,
    },
  },
});

export type BetterAuthUser = typeof auth.$Infer.Session.user;
export type BetterAuthSession = typeof auth.$Infer.Session.session;
```

### Bước 3 — Kết nối với `BetterAuthModule.forRoot()`

@@filename(src/app.module.ts)

```ts
import { Module } from "@bunest/core";
import { BetterAuthModule } from "@bunest/security/auth";
import { AuthorizationModule } from "@bunest/security/authz";
import { auth } from "./auth";
import { ProjectPolicy } from "./project.policy";
import { ProjectsController } from "./projects.controller";

@Module({
  imports: [
    BetterAuthModule.forRoot({
      auth,
      basePath: "/api/auth", // tùy chọn: tự lấy từ auth.options.basePath
    }),
    AuthorizationModule.forRoot(),
  ],
  controllers: [ProjectsController],
  providers: [ProjectPolicy],
})
export class AppModule {}
```

### Bước 4 — Bật CORS có `credentials: true` (cho frontend SPA)

@@filename(src/main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
app.enableCors({
  origin: ["http://localhost:5173"],
  credentials: true,
});
await app.listen(3000);
```

### Bước 5 — Sử dụng `@CurrentUser()`, `@CurrentSession()`, `@InjectBetterAuth()` và ABAC `@Can()`

@@filename(src/projects.controller.ts)

```ts
import { Controller, Delete, Get, Param, Req } from "@bunest/core";
import {
  CurrentSession,
  CurrentUser,
  InjectBetterAuth,
  Public,
} from "@bunest/security/auth";
import { Can } from "@bunest/security/authz";
import type { auth as AuthInstance, BetterAuthSession, BetterAuthUser } from "./auth";
import { ProjectPolicy } from "./project.policy";

@Controller("projects")
export class ProjectsController {
  constructor(
    @InjectBetterAuth()
    private readonly betterAuth: typeof AuthInstance,
  ) {}

  @Public()
  @Get("status")
  status() {
    return { ok: true };
  }

  @Can(ProjectPolicy, "read")
  @Get("me")
  async me(
    @CurrentUser() user: BetterAuthUser,
    @CurrentSession() session: BetterAuthSession,
    @Req() req: Request,
  ) {
    // Gọi trực tiếp server API của Better Auth qua DI!
    const sessions = await this.betterAuth.api.listSessions({
      headers: req.headers,
    });
    return { user, sessionId: session.id, activeDevices: sessions.length };
  }

  @Can(ProjectPolicy, "delete")
  @Delete(":id")
  remove(@Param("id") id: string, @CurrentUser() user: BetterAuthUser) {
    return { deleted: id, by: user.email };
  }
}
```

### Cấu hình bất đồng bộ (`BetterAuthModule.forRootAsync()`)

Khi instance Better Auth cần inject `ConfigService` hoặc kết nối database:

```ts
BetterAuthModule.forRootAsync({
  basePath: "/api/auth",
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    betterAuth({
      secret: config.getOrThrow("BETTER_AUTH_SECRET"),
      baseURL: config.getOrThrow("APP_URL"),
      database: new Database(config.get("SQLITE_PATH", "./auth.sqlite")),
      emailAndPassword: { enabled: true },
    }),
});
```

> [!TIP]
> Chạy thử ví dụ hoàn chỉnh kết hợp Better Auth + `ApiKeyProvider` + ABAC `@Policy()` tại [`examples/modern-auth-integrations`](https://github.com/nctuanit/bunest/tree/main/examples/modern-auth-integrations).

---

## 2. Clerk (`ExternalJwtAuthModule.forClerk`)

Xác thực JWT phiên của Clerk thuần WebCrypto + JWKS có cache — tự động đọc **cả** header `Authorization: Bearer <token>` lẫn cookie `__session` của Clerk, kèm kiểm tra `azp` (`authorizedParties`):

@@filename(src/app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ExternalJwtAuthModule } from "@bunest/security/auth";
import { AccountController } from "./account.controller";

@Module({
  imports: [
    ExternalJwtAuthModule.forClerk({
      issuer: Bun.env.CLERK_ISSUER_URL!, // vd: https://bright-fox-12.clerk.accounts.dev
      authorizedParties: ["https://app.example.com"],
    }),
  ],
  controllers: [AccountController],
})
export class AppModule {}
```

Lấy đối tượng `ClerkUser` có đầy đủ type trong controller hoặc `@Policy()`:

```ts
import { Controller, Get } from "@bunest/core";
import { CurrentUser, type ClerkUser } from "@bunest/security/auth";

@Controller("account")
export class AccountController {
  @Get("me")
  me(@CurrentUser() user: ClerkUser) {
    return {
      userId: user.id,
      orgId: user.orgId,
      orgRole: user.orgRole,
    };
  }
}
```

---

## 3. Supabase Auth (`ExternalJwtAuthModule.forSupabase`)

Hỗ trợ **cả hai chế độ**: khóa bất đối xứng JWKS mới của Supabase (`ES256` / `RS256` tại `${projectUrl}/auth/v1/.well-known/jwks.json`) và `jwtSecret` HS256 cũ:

```ts
import { Module } from "@bunest/core";
import { ExternalJwtAuthModule } from "@bunest/security/auth";

// Khuyên dùng: Supabase Asymmetric JWKS (tự động xoay vòng khóa)
@Module({
  imports: [
    ExternalJwtAuthModule.forSupabase({
      projectUrl: Bun.env.SUPABASE_URL!, // https://<project-ref>.supabase.co
    }),
  ],
})
export class AppModule {}

// Dự án cũ dùng HS256 JWT Secret:
// ExternalJwtAuthModule.forSupabase({
//   projectUrl: Bun.env.SUPABASE_URL!,
//   jwtSecret: Bun.env.SUPABASE_JWT_SECRET!,
// })
```

`@CurrentUser()` nhận về `SupabaseUser` gồm `{ id, email, phone, role, aal, appMetadata, userMetadata, claims }`.

---

## 4. Auth0, Keycloak, WorkOS, Okta, Cognito & Firebase

### Auth0 (`ExternalJwtAuthModule.forAuth0`)

```ts
ExternalJwtAuthModule.forAuth0({
  domain: Bun.env.AUTH0_DOMAIN!, // vd: my-tenant.us.auth0.com
  audience: Bun.env.AUTH0_AUDIENCE!, // vd: https://api.example.com
});
```

`@CurrentUser()` trả về `Auth0User` đã tách sẵn `scope: readonly string[]` và `permissions: readonly string[]`.

### OIDC / JWKS tổng quát (`ExternalJwtAuthModule.forJwks`)

Hoạt động với **Keycloak**, **WorkOS**, **Okta**, **AWS Cognito**, **Firebase Auth**, **Logto** và **Kinde**:

```ts
// Ví dụ: Keycloak Realm
ExternalJwtAuthModule.forJwks({
  jwksUri: "https://sso.example.com/realms/prod/protocol/openid-connect/certs",
  issuer: "https://sso.example.com/realms/prod",
  audience: "bunest-api",
  algorithms: ["RS256", "ES256"],
  mapUser: (claims) => ({
    id: String(claims.sub),
    email: claims.email as string | undefined,
    roles:
      ((claims.realm_access as { roles?: string[] } | undefined)?.roles) ?? [],
  }),
});
```

---

## 5. Auth.js (`@auth/core`) & Lucia (`WebAuthModule`)

`WebAuthModule` đưa mọi thư viện auth chuẩn Web vào thẳng pipeline guard và `@CurrentUser()` của Bunest.

### Auth.js (`@auth/core`)

Mount handler `Auth(request, config)` tại `/api/auth/*` và đọc phiên từ cookie/headers:

```ts
import { Auth } from "@auth/core";
import GitHub from "@auth/core/providers/github";
import { WebAuthModule } from "@bunest/security/auth";

const authConfig = {
  secret: Bun.env.AUTH_SECRET!,
  providers: [GitHub],
};

WebAuthModule.forRoot({
  basePath: "/api/auth",
  handler: (req) => Auth(req, authConfig),
  getSession: async ({ headers }) => {
    const res = await Auth(
      new Request("http://localhost/api/auth/session", { headers }),
      authConfig,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: Record<string, unknown> } | null;
    return data?.user ? { user: data.user, session: data } : null;
  },
});
```

### Lucia Auth (Xác thực Cookie Session không cần mount handler)

Bỏ qua thuộc tính `handler` nếu controller của bạn tự xử lý đăng nhập/đăng xuất và chỉ cần xác thực session cookie:

```ts
WebAuthModule.forRoot({
  getSession: async ({ cookie }) => {
    const sessionId = cookie(lucia.sessionCookieName);
    if (!sessionId) return null;
    const { user, session } = await lucia.validateSession(sessionId);
    return user && session ? { user, session } : null;
  },
});
```

---

## 6. Kết hợp nhiều cơ chế Auth cùng lúc (VD: Better Auth + API Keys)

Import `AuthenticationModule.forRoot()` một lần, đặt `registerAuthenticationModule: false` trên từng tích hợp và gán thứ tự `order` khác nhau:

```ts
@Module({
  imports: [
    AuthenticationModule.forRoot(),
    BetterAuthModule.forRoot({
      auth,
      order: 0,
      registerAuthenticationModule: false,
    }),
    AuthorizationModule.forRoot(),
  ],
  providers: [
    ServiceApiKeyProvider, // đăng ký trên AuthenticationRegistry với order: 10
    ProjectPolicy,
  ],
})
export class AppModule {}
```

Khi đó, người dùng trình duyệt xác thực bằng cookie Better Auth, dịch vụ/CI xác thực bằng `Authorization: Bearer bnst_<id>_<secret>`, và **cả hai** cùng đi qua đúng một hệ thống `@CurrentUser()` và quy tắc ABAC `@Can(ProjectPolicy, ...)`.
