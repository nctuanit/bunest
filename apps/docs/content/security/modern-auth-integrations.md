# Modern Auth Integrations (Better Auth, Clerk, Supabase, Auth0, Auth.js, Lucia)

You do **not** need legacy Passport.js strategies to build modern authentication in Bunest.

Because Bunest runs natively on **Web Standard `Request` / `Response`** and **WebCrypto**, `@bunest/security/auth` provides **first-class, zero-dependency adapters** for the modern TypeScript auth ecosystem — plugging directly into `AuthenticationGuard`, `@CurrentUser()`, `@CurrentSession()`, `@Public()`, `@Authenticate()`, and ABAC `@Policy()` / `@Can()` authorization.

## Choosing Your Auth Strategy

| Solution | Best For | Integration API | External Deps in `@bunest/security` |
| --- | --- | --- | --- |
| **Bunest Built-In Auth** | Full self-hosted control (Sessions, JWT + Refresh Rotation, TOTP MFA, Passkeys/WebAuthn, OIDC, API Keys) | `AuthenticationModule.forRoot(...)` | **0** |
| **Better Auth** | Full-featured TypeScript auth with plugins (Organizations, Passkeys, 2FA, Social OAuth, Stripe) | `BetterAuthModule.forRoot({ auth })` | **0** (peer in your app) |
| **Clerk** | Hosted auth + prebuilt UI components & B2B organizations | `ExternalJwtAuthModule.forClerk(...)` | **0** (native WebCrypto JWKS) |
| **Supabase Auth** | Apps backed by Supabase Postgres & RLS | `ExternalJwtAuthModule.forSupabase(...)` | **0** (native WebCrypto JWKS/HS256) |
| **Auth0 / Keycloak / WorkOS / Okta / Cognito / Firebase** | Enterprise SSO, B2B identity, managed OIDC providers | `ExternalJwtAuthModule.forAuth0(...)` / `.forJwks(...)` | **0** (native WebCrypto JWKS) |
| **Auth.js (`@auth/core`) & Lucia** | Custom Web-Standard auth handlers or lightweight cookie sessions | `WebAuthModule.forRoot(...)` | **0** (peer in your app) |
| *Legacy Passport.js* | Migrating existing NestJS codebases without rewriting strategies | `PassportModule` / `AuthGuard()` | **0** (compat layer only) |

---

## 1. Better Auth (`BetterAuthModule`)

`BetterAuthModule` connects [Better Auth](https://www.better-auth.com/) to Bunest in one module import:

1. **Mounts `auth.handler(req)`** automatically on `/api/auth` and `/api/auth/*` (passing the unread native Web `Request` straight through and preserving redirects + multi-value `Set-Cookie` headers).
2. **Registers `BetterAuthProvider`** on `AuthenticationRegistry` so every route validates sessions via `auth.api.getSession({ headers })` across HTTP, WebSockets, GraphQL, and MCP.
3. **Injects the Better Auth instance** anywhere via `@InjectBetterAuth()` (or `BETTER_AUTH_INSTANCE`).

### Step 1 — Install `better-auth` in Your App

```bash
bun add better-auth @bunest/security
```

### Step 2 — Create Your Better Auth Instance

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

### Step 3 — Mount with `BetterAuthModule.forRoot()`

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
      basePath: "/api/auth", // optional: inferred from auth.options.basePath
    }),
    AuthorizationModule.forRoot(),
  ],
  controllers: [ProjectsController],
  providers: [ProjectPolicy],
})
export class AppModule {}
```

### Step 4 — Enable CORS with `credentials: true` (for SPA Frontends)

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

### Step 5 — Use `@CurrentUser()`, `@CurrentSession()`, `@InjectBetterAuth()`, and ABAC `@Can()`

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
    // Call any Better Auth server API directly via DI!
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

### Async Setup (`BetterAuthModule.forRootAsync()`)

When your Better Auth instance depends on `ConfigService` or a database provider:

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
> See the full runnable example with Better Auth + `ApiKeyProvider` + ABAC `@Policy()` in [`examples/modern-auth-integrations`](https://github.com/nctuanit/bunest/tree/main/examples/modern-auth-integrations).

---

## 2. Clerk (`ExternalJwtAuthModule.forClerk`)

Verify Clerk session JWTs natively with Bun WebCrypto and cached JWKS — supporting **both** `Authorization: Bearer <token>` headers and Clerk's `__session` cookie automatically, plus `azp` (`authorizedParties`) validation:

@@filename(src/app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ExternalJwtAuthModule } from "@bunest/security/auth";
import { AccountController } from "./account.controller";

@Module({
  imports: [
    ExternalJwtAuthModule.forClerk({
      issuer: Bun.env.CLERK_ISSUER_URL!, // e.g. https://bright-fox-12.clerk.accounts.dev
      authorizedParties: ["https://app.example.com"],
    }),
  ],
  controllers: [AccountController],
})
export class AppModule {}
```

Access the typed `ClerkUser` in controllers and `@Policy()` classes:

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

Supports **both** Supabase's modern asymmetric JWKS signing keys (`ES256` / `RS256` from `${projectUrl}/auth/v1/.well-known/jwks.json`) and legacy `HS256` JWT secrets:

```ts
import { Module } from "@bunest/core";
import { ExternalJwtAuthModule } from "@bunest/security/auth";

// Recommended: Modern Supabase Asymmetric JWKS (automatic key rotation)
@Module({
  imports: [
    ExternalJwtAuthModule.forSupabase({
      projectUrl: Bun.env.SUPABASE_URL!, // https://<project-ref>.supabase.co
    }),
  ],
})
export class AppModule {}

// Legacy projects using HS256 JWT Secret:
// ExternalJwtAuthModule.forSupabase({
//   projectUrl: Bun.env.SUPABASE_URL!,
//   jwtSecret: Bun.env.SUPABASE_JWT_SECRET!,
// })
```

`@CurrentUser()` receives a typed `SupabaseUser` containing `{ id, email, phone, role, aal, appMetadata, userMetadata, claims }`.

---

## 4. Auth0, Keycloak, WorkOS, Okta, Cognito & Firebase

### Auth0 (`ExternalJwtAuthModule.forAuth0`)

```ts
ExternalJwtAuthModule.forAuth0({
  domain: Bun.env.AUTH0_DOMAIN!, // e.g. my-tenant.us.auth0.com
  audience: Bun.env.AUTH0_AUDIENCE!, // e.g. https://api.example.com
});
```

`@CurrentUser()` receives `Auth0User` with parsed `scope: readonly string[]` and RBAC `permissions: readonly string[]`.

### Generic OIDC / JWKS (`ExternalJwtAuthModule.forJwks`)

Works with **Keycloak**, **WorkOS**, **Okta**, **AWS Cognito**, **Firebase Auth**, **Logto**, and **Kinde**:

```ts
// Example: Keycloak Realm
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

`WebAuthModule` bridges any Web-Standard auth library into Bunest's guard and `@CurrentUser()` pipeline.

### Auth.js (`@auth/core`)

Mount Auth.js's `Auth(request, config)` handler on `/api/auth/*` and resolve sessions via cookie/headers:

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

### Lucia Auth (Headless Cookie Sessions)

Omit `handler` when your own controllers handle sign-in/sign-out and you only want session cookie validation:

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

## 6. Combining Multiple Auth Providers (e.g., Better Auth + API Keys)

Import `AuthenticationModule.forRoot()` once, pass `registerAuthenticationModule: false` on each integration, and assign distinct `order` values:

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
    ServiceApiKeyProvider, // registers on AuthenticationRegistry at order: 10
    ProjectPolicy,
  ],
})
export class AppModule {}
```

Now browser requests authenticate via Better Auth cookies, CI/partner scripts authenticate via `Authorization: Bearer bnst_<id>_<secret>`, and **both** flow through the exact same `@CurrentUser()` and `@Can(ProjectPolicy, ...)` ABAC rules!
