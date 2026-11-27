# Security Guide

Bunest ships secure-by-default HTTP, validation, authentication, policy authorization, rate-limiting, and file-storage primitives designed specifically for Bun's native WebCrypto and `Bun.password` APIs.

---

## 1. Built-In Core & Validation Security Defaults

### Strict `ValidationPipe` Defaults ([ADR-009](./adr/ADR-009.md))

Enabling `app.useGlobalPipes(new ValidationPipe())` automatically enforces:

- **`whitelist: true`**: Strips any property lacking a validation decorator (`@bunest/validation/validator` or compatible `class-validator`) for mass-assignment defense.
- **`forbidNonWhitelisted: true`**: Rejects requests containing unknown properties with HTTP `400`.
- **`forbidUnknownValues: true`**: Prevents non-object or malformed payloads from passing validation as empty valid DTOs.
- **`transformOptions.enableImplicitConversion: false`**: Blocks silent JavaScript type-coercion bugs (e.g., `"false"` turning into `true`).
- **`validationError: { target: false, value: false }`**: Never echoes raw rejected values (passwords, tokens, PII) in HTTP 400 responses.
- **Prototype-pollution defense**: Both `@bunest/core/http` (`sanitizeObject` / `sanitizeRecord`) and `@bunest/validation` (`stripDangerousKeys` / `findDangerousKeys`) strip or reject dangerous keys (`__proto__`, `constructor`, `prototype`) before DTO instantiation.

### Body Size Limits & Malformed Input Handling

Configure `bodyLimit` (bytes) when creating the app—oversized payloads are rejected before full buffering with `413 Payload Too Large`:

```ts
const app = await BunestFactory.create(AppModule, {
  bodyLimit: 1024 * 1024, // 1 MiB
});
```

Malformed JSON and malformed `multipart/form-data` bodies fail with `400 Bad Request` (`BadRequestException`), never leaking raw parser `SyntaxError`s as `500`.

### Safe Production Error Handling & Secret Redaction

- **`DefaultExceptionFilter` ([ADR-008](./adr/ADR-008.md)):** Unhandled non-`HttpException` errors return `{ statusCode: 500, error: "Internal Server Error", message: "Internal server error" }` and **never leak stack traces or internal messages** when `NODE_ENV === "production"`.
- **Log secret redaction:** Both `@bunest/core`'s `Logger` and `@bunest/core/config`'s `createSecretRedactor()` automatically redact sensitive keys (`password`, `secret`, `token`, `authorization`, `apiKey`, `cookie`, `privateKey`, etc.) while safely handling circular objects and `BigInt` values.

---

## 2. Security Headers (`SecurityHeadersMiddleware`)

`@bunest/security` provides a Helmet-style middleware with strong defaults (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `X-DNS-Prefetch-Control: off`):

```ts
import { BunestFactory } from "@bunest/core";
import { createSecurityHeadersMiddleware } from "@bunest/security";

const app = await BunestFactory.create(AppModule);

app.use(
  createSecurityHeadersMiddleware({
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    contentSecurityPolicy: {
      "default-src": ["'self'"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"],
    },
  }),
);
```

---

## 3. CORS Configuration

Enable CORS via `BunestFactory.create(AppModule, { cors: ... })` or `app.enableCors(...)`:

```ts
app.enableCors({
  origin: ["https://app.example.com"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 86400,
});
```

- Preflight `OPTIONS` requests short-circuit with `204` before guards/middleware.
- Configured CORS headers are preserved on **both** normal responses and Exception Filter error responses (400/401/403/404/405/429/500).
- **Avoid `origin: true` or `"*"` combined with `credentials: true`** for sensitive endpoints; prefer an explicit allowlist array or dynamic `(origin, req) => boolean` callback.

---

## 4. Authentication Primitives (`@bunest/security` & `@bunest/security/jwt`)

### Native WebCrypto JWT (`JwtModule` + `JwtService`)

`JwtService` uses Bun's native WebCrypto (`crypto.subtle`) supporting `HS256`/`HS384`/`HS512`, `RS256`/`RS384`/`RS512`, and `ES256`/`ES384`/`ES512`:

- Always rejects `alg: "none"` and unknown algorithms.
- Pins allowed verification algorithms and validates HMAC `CryptoKey` hash matches against the token header's `alg` (preventing algorithm-confusion attacks).
- Supports verify-only asymmetric/HMAC `CryptoKey`s and maps malformed PEMs/tokens cleanly to `JwtInvalidException` / `JwtExpiredException` (`401`).

```ts
import { APP_GUARD, Controller, Get, Module } from "@bunest/core";
import {
  CurrentUser,
  JwtAuthGuard,
  JwtModule,
  PasswordService,
  Public,
  Roles,
  RolesGuard,
  type JwtPayload,
} from "@bunest/security";

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET!,
      signOptions: { expiresIn: "15m", algorithm: "HS256" },
      verifyOptions: { algorithms: ["HS256"] },
    }),
  ],
  providers: [
    PasswordService, // Native Bun.password defaulting to argon2id
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  controllers: [AccountController],
})
export class AuthModule {}

@Controller("/account")
export class AccountController {
  @Public()
  @Get("status")
  status() {
    return { ok: true };
  }

  @Get("me")
  me(@CurrentUser() user: JwtPayload) {
    return { sub: user.sub, roles: user.roles };
  }

  @Roles("admin")
  @Get("admin")
  adminOnly() {
    return { secret: "restricted" };
  }
}
```

### Password Hashing (`PasswordService`)

`PasswordService` wraps native `Bun.password` defaulting to **`argon2id`** (`memoryCost: 65536`, `timeCost: 2`; `bcrypt` also supported). Always store password hashes produced by `await passwordService.hash(plain)` and verify via `await passwordService.verify(plain, hash)`.

### Cookie Sessions & CSRF Protection

When authenticating via lightweight signed cookies instead of `Authorization: Bearer`, pair `SessionCookieService` (sets `HttpOnly`, `SameSite`, `Secure` cookies) with `CsrfGuard` (timing-safe double-submit token validation via `timingSafeEqualString`).

---

## 5. Full Authentication Suite (`@bunest/security/auth`)

For full application authentication (server-side sessions, rotating refresh tokens, TOTP MFA, OIDC/OAuth2, magic links, API keys, and audit events), import from **`@bunest/security/auth`** and register `AuthenticationModule.forRoot(...)` (or `forRootAsync(...)`).

`AuthenticationModule` provides `AuthenticationGuard`, `AuthenticationRegistry`, `AuthenticationStorage`, `AuthenticationContext`, `AuthenticationEvents`, `WsAuthenticator`, `PasswordHasher`, and the feature services below. Decorate routes with `@Authenticate({ optional, mfa, verifiedEmail, providers })`, `@Public()`, `@CurrentUser()`, and `@CurrentSession()`.

### Server-Side Sessions (`SessionService`, `SignInService`, `SessionCookieProvider`)

- **Opaque hashed tokens:** `SessionService` issues 256-bit random tokens placed in an `HttpOnly` cookie and persists only their **SHA-256** hash in the configured `SessionStore` (`InMemorySessionStore` is included for development/tests; use a persistent database/Redis store in production).
- **Dual expiry & sliding idle timeout:** Enforces both `absoluteTtl` (default `7d`) and `idleTtl` (default `1d`), throttling store activity writes via `touchInterval` (default `1m`). Pending MFA sessions use a shorter `mfa.pendingTtl` (default `10m`, capped at `absoluteTtl`).
- **Session fixation & CSRF defense:** `SignInService.signIn()` deletes any prior session token carried by the browser (`replacing`) before issuing the new session, and rejects cross-origin state-changing requests (`403`) unless the origin is explicitly listed in `session.trustedOrigins`.
- **Rotation & revocation:** Call `SignInService.rotateSession()` on privilege changes, `SessionService.revoke()` / `revokeAll({ except })` to terminate specific or other devices, and `SignInService.signOutEverywhere(userId)` to revoke all sessions and refresh-token families at once.

### Refresh-Token Families (`TokenService`, `JwtSigner`, `JwtVerifier`, `JwksClient`, `JwtBearerProvider`)

- **Short-lived JWT + single-use opaque refresh token:** `TokenService.issue()` signs a short-lived JWT access token (`accessToken.ttl`, default `15m`) and creates an opaque refresh token stored by SHA-256 hash under a `familyId` (`refreshToken.ttl` default `30d`, `refreshToken.absoluteTtl` default `90d`).
- **Reuse detection & family revocation:** `TokenService.refresh()` atomically marks the spent refresh token as used (`markRefreshTokenUsed`) and issues its successor in the same family. Presenting an already-used token immediately **revokes the entire token family** (`revokeRefreshTokenFamily`), emits an `AuthenticationEvents` `"refresh-token-reused"` event, and throws `RefreshTokenError("reused")`.
- **Claim integrity:** Locked claims (`iss`, `sub`, `aud`, `exp`, `nbf`, `iat`, `jti`, `amr`, `auth_time`) cannot be overwritten by custom refresh `claims` mappers, and MFA `amr` values are only attached after `MfaService` verifies a second factor.

### Multi-Factor Authentication (`MfaService`)

- **RFC 6238 TOTP:** 6-digit codes, 30-second period, SHA-1, configurable clock-skew `window` (default `1`). Replay within a time step is blocked via `MfaStore.claimTotpStep()`.
- **Encryption at rest required by default:** `mfa.encryption` is mandatory when configuring MFA—TOTP seeds are encrypted with **AES-256-GCM** (`SecretCipher`, keys listed newest-first for rotation, AAD bound to `totp.<userId>`). Older ciphertexts are transparently re-encrypted on verify or via `MfaService.reencrypt()`. Plaintext storage requires an explicit `encryption: false` opt-out.
- **Lockout & recovery codes:** Failed TOTP or recovery-code attempts are tracked per user (`maxAttempts` default `5` within `lockoutWindow` default `15m`). `generateRecoveryCodes()` returns one-time codes (default `10`) stored as per-user `scrypt` hashes.
- **Session step-up:** When an enrolled user signs in, `SignInService.signIn()` creates a session with `mfa: "pending"`. `AuthenticationGuard` rejects pending sessions with `code: "mfa_required"` until `SignInService.completeMfa({ code | recoveryCode })` verifies the second factor and rotates the session to `mfa: "verified"`.

### OpenID Connect & OAuth 2.0 (`OidcService`, `OidcAccountResolver`)

- **Built-in presets & discovery:** Ships `google`, `github`, and `microsoft` presets alongside generic OIDC discovery (`/.well-known/openid-configuration` cached with issuer matching and HTTPS-only enforcement; loopback HTTP allowed for local dev). Outbound discovery/token requests enforce `redirect: "error"` and a 10s timeout.
- **Flow hardening:** Every login uses Authorization Code flow with **PKCE (`S256`)**, a single-use `state` bound via SHA-256 to an `HttpOnly; SameSite=Lax` transaction cookie (`oidc_tx`), `nonce` verification, **RFC 9207 `iss` mix-up defense**, JWKS-backed ID token verification, and `Cache-Control: no-store` on redirect responses.
- **Safe account linking:** Passing `{ link: true }` to `OidcService.start()` refuses `Sec-Fetch-Site: cross-site` requests (`403`) and binds the transaction to the caller's active, MFA-verified session ID, verifying the same session still holds the browser in `OidcService.finish()`.

```ts
import { Module } from "@bunest/core";
import {
  AuthenticationGuard,
  AuthenticationModule,
  google,
} from "@bunest/security/auth";
import { APP_GUARD } from "@bunest/core";

@Module({
  imports: [
    AuthenticationModule.forRoot({
      session: {
        absoluteTtl: "7d",
        idleTtl: "1d",
        trustedOrigins: ["https://app.example.com"],
      },
      accessToken: {
        key: process.env.JWT_SECRET!,
        ttl: "15m",
      },
      refreshToken: {
        ttl: "30d",
        absoluteTtl: "90d",
      },
      mfa: {
        issuer: "MyApp",
        encryption: { keys: [process.env.MFA_ENCRYPTION_KEY!] },
        maxAttempts: 5,
        lockoutWindow: "15m",
      },
      oidc: {
        callbackUrl: "https://app.example.com/auth/oidc/:provider/callback",
        providers: {
          google: google({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          }),
        },
      },
    }),
  ],
  providers: [{ provide: APP_GUARD, useExisting: AuthenticationGuard }],
})
export class AppAuthModule {}
```

---

## 6. Policy-Based Authorization (`@bunest/security/authz`)

Import from **`@bunest/security/authz`** to enforce strongly typed, deny-by-default resource policies across HTTP, WebSocket, and RPC handlers.

### Defining Policies (`@Policy`)

`@Policy()` marks an injectable class as a policy. Every method whose first parameter is the user and that returns `boolean | Promise<boolean>` is an ability. Only a literal `true` allows access (truthy non-boolean values are denied).

An optional `before(user, ability, ...args)` hook runs first—it **must** accept `null` for unauthenticated guests and may return `true` (allow immediately), `false` (deny immediately), or `undefined`/`void` (delegate to the ability method):

```ts
import { Policy, type PolicyBefore } from "@bunest/security/authz";

interface User {
  id: string;
  role: "admin" | "member";
}

interface Invoice {
  id: string;
  ownerId: string;
}

@Policy()
export class InvoicePolicy implements PolicyBefore<User> {
  before(user: User | null): boolean | void {
    if (user?.role === "admin") return true;
  }

  read(user: User | null, invoice: Invoice): boolean {
    return user !== null && invoice.ownerId === user.id;
  }

  create(user: User | null): boolean {
    return user !== null;
  }
}
```

### Enforcing Policies (`@Can`, `@Can.Anyone`, `AuthorizationGuard`, `AuthorizationService`)

- **Deny-by-default global guard:** Registering `AuthorizationModule.forRoot()` installs `AuthorizationGuard` globally and `AuthorizationErrorInterceptor` (which translates `AuthorizationError` into `401`/`403`, `WsException`, or `RpcException`). Any handler without `@Can(...)`, `@Can.Anyone()`, or `@bunest/security/auth`'s `@Public()` is **denied by default**.
- **Guard-ordering safety:** At startup, `@bunest/security/authz` verifies that `AuthenticationGuard` runs before `AuthorizationGuard` and fails fast if misordered.
- **Stackable `@Can()` decorators:** Multiple `@Can(Policy, "ability", argsResolver?)` decorators on a controller class and handler method are evaluated in order (class-level first, then method-level; all must return `true`). A method-level `@Can.Anyone()` or `@Public()` lifts class-level `@Can()` checks.
- **Service-level checks (`AuthorizationService`):** Inject `AuthorizationService` to call `can(Policy, ability, user, ...args)` (returns `boolean`, never throws—ideal for response shaping) or `authorize(Policy, ability, user, ...args)` (throws `AuthorizationError` and emits an `AuthorizationEvents` `"denied"` event).

```ts
import { Controller, Get, Module, Param, Post } from "@bunest/core";
import {
  AuthorizationModule,
  AuthorizationService,
  Can,
} from "@bunest/security/authz";
import { CurrentUser } from "@bunest/security/auth";
import { InvoicePolicy } from "./invoice.policy";
import { InvoiceService } from "./invoice.service";

@Module({
  imports: [AuthorizationModule.forRoot()],
  providers: [InvoicePolicy, InvoiceService],
  controllers: [InvoicesController],
})
export class InvoicesModule {}

@Controller("/invoices")
export class InvoicesController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly authz: AuthorizationService,
  ) {}

  @Can(InvoicePolicy, "create")
  @Post()
  create() {
    return this.invoices.create();
  }

  @Can.Anyone()
  @Get("health")
  health() {
    return { ok: true };
  }

  @Get(":id")
  @Can.Anyone() // Route-level open; resource-level check runs after loading the row
  async findOne(@Param("id") id: string, @CurrentUser() user: User | null) {
    const invoice = await this.invoices.findById(id);
    await this.authz.authorize(InvoicePolicy, "read", user, invoice);
    return invoice;
  }
}
```

---

## 7. Rate Limiting (`@bunest/security` & `@bunest/security/throttler`)

Protect endpoints from brute-force and DoS traffic using sliding-window rate limiting:

```ts
import { APP_GUARD, Module } from "@bunest/core";
import {
  SkipThrottle,
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
} from "@bunest/security/throttler";

@Module({
  imports: [
    ThrottlerModule.forRoot({
      global: true,
      throttlers: [{ name: "default", ttl: 60_000, limit: 100 }],
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

- Override per controller/route with `@Throttle({ ttl: 10_000, limit: 5 })` or exempt health probes with `@SkipThrottle()`.
- Rejected `429 Too Many Requests` hits do **not** pollute the sliding window, keeping `X-RateLimit-Reset` accurate.

---

## 8. Safe File Storage (`@bunest/storage` & `@bunest/storage/local`)

`StorageModule.forRoot({ disks: { local: new LocalDisk({ root: "./uploads" }) } })` (`LocalDisk` from `@bunest/storage` / `@bunest/storage/local`) enforces `assertValidKey()` on every put/get/delete/stat call, blocking:

- Path traversal (`../`, `..\\`, absolute paths)
- Null bytes (`\0`) and control characters
- Windows drive letters and NTFS Alternate Data Streams (`:` in any path segment, e.g., `file.txt:hidden`)

Always validate uploaded MIME types and file sizes via custom pipes on `@UploadedFile()` before persisting.

---

## 9. Reverse Proxy & `trustProxy` Guidance

By default, `@Ip()` and `ThrottlerGuard` use the direct socket IP from `server.requestIP(req)` and **ignore `X-Forwarded-For`** so clients cannot spoof their IP address to bypass rate limits or IP allowlists.

Only enable `trustProxy` when Bunest runs behind a reverse proxy you control (Cloudflare, Nginx, ALB, Caddy):

```ts
// Trust a specific hop count (recommended over `true`):
const app = await BunestFactory.create(AppModule, { trustProxy: 1 });

// Or trust only explicit proxy CIDRs / IPs:
const app = await BunestFactory.create(AppModule, {
  trustProxy: ["127.0.0.1", "10.0.0.1"],
});
```

Never set `trustProxy: true` on a directly internet-exposed Bun server.

---

## Independent Security Review Scope (`1.0` RC)

Before promoting a `1.0` Release Candidate (`1.0.0-rc.*`) to `1.0.0` General Availability, Bunest undergoes an independent third-party security review governed by the scope and release criteria below and the private triage workflow in [`SECURITY.md`](../SECURITY.md#10-rc-private-finding-triage--re-verification-workflow).

### In-Scope Packages & Subpaths

The review covers all GA-targeted framework packages and their public `package.json#exports` subpaths on the pinned runtime (**Linux + Bun `>= 1.4.5`**):

| Package | In-Scope Subpaths | Primary Security Focus |
| --- | --- | --- |
| `@bunest/core` | `.`, `/common`, `/http`, `/config`, `/client`, `/ws`, `/i18n` | `Bun.serve` request parsing, `bodyLimit`, CORS, `trustProxy`, prototype-pollution sanitization, `DefaultExceptionFilter` redaction, `.env` config loading, WS frame handling, SSRF/redirect behavior in `/client` |
| `@bunest/validation` | `.`, `/validator`, `/transformer`, `/standard-schema` | `ValidationPipe` defaults (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`), dangerous-key stripping, nested DTO/array validation bypasses, error value redaction |
| `@bunest/security` | `.`, `/auth`, `/authz`, `/jwt`, `/throttler` | WebCrypto JWT/JWKS verification & algorithm pinning, `SessionService`/`SignInService` fixation & CSRF checks, refresh-token family reuse detection, AES-256-GCM TOTP MFA & lockout, OIDC PKCE/`state`/`nonce`/`iss` verification, `@Policy`/`@Can` deny-by-default guard & ordering, `CsrfGuard`, `SecurityHeadersMiddleware`, `ThrottlerGuard` |
| `@bunest/orm` | `.`, `/postgres`, `/store`, `/plugin` | Parameterized `Bun.SQL` query generation (PostgreSQL & SQLite), identifier/column quoting, migration execution safety |
| `@bunest/observability` | `.`, `/tracing`, `/health`, `/metrics`, `/devtools` | Deep secret redaction, `/_devtools/*` production gate (`NODE_ENV === "production"`), W3C `tracestate`/`baggage` parsing |
| `@bunest/cache` | `.`, `/redis` | `CacheInterceptor` bypass on `Set-Cookie` and `Cache-Control: private`/`no-store`, cache-key isolation |
| `@bunest/jobs` | `.`, `/queues`, `/scheduler`, `/redis` | Job payload deserialization, retry/lease isolation |
| `@bunest/resilience`, `@bunest/swagger`, `@bunest/cli` | Public exports | OpenAPI/Swagger exposure controls, CLI scaffold/config handling |

### Trust Boundaries

1. **Network & Reverse-Proxy Boundary:** Untrusted HTTP/WebSocket traffic entering `Bun.serve`, reverse-proxy header parsing (`X-Forwarded-For` / `trustProxy`), CORS preflight/error preservation, `bodyLimit`, and JSON/multipart/query parsing.
2. **Authentication & Session Boundary:** Cookie parsing and cross-origin write checks, JWT/JWKS signature and claim validation, opaque session and refresh-token lifecycle, TOTP secret encryption at rest, and OIDC browser redirects/callbacks.
3. **Authorization & Multi-Tenant Boundary:** Guard execution order (`AuthenticationGuard` -> `AuthorizationGuard`), deny-by-default enforcement, `@Policy` guest (`null`) handling, and service-level `AuthorizationService.authorize()` error translation across HTTP/WS/RPC.
4. **Persistence & Telemetry Boundary:** SQL query parameterization in `@bunest/orm`, secret redaction in structured logs and HTTP error responses, and production gating of diagnostic endpoints.
5. **Supply-Chain & Runtime Boundary:** Zero external runtime dependencies ([ADR-017](./adr/ADR-017.md)), Bun `>= 1.4.5` native API usage, and npm provenance (`--provenance`).

### Out-of-Scope Experimental / Preview Packages

Per [`docs/support-policy.md`](./support-policy.md#3-per-module-stability-tiers), the following **Preview / Experimental** packages and non-GA targets are **out of scope** for the `1.0` RC GA review (each undergoes dedicated review prior to its own promotion):

- `@bunest/graphql`, `@bunest/microservices`, `@bunest/messaging`, `@bunest/workflows`, `@bunest/storage`, `@bunest/mail`, `@bunest/elasticsearch`, `@bunest/ai`
- Non-PostgreSQL/SQLite `Bun.SQL` dialects (MySQL, MariaDB, MongoDB, LibSQL, D1)
- Reference apps and tooling (`examples/*`, `apps/playground`, `apps/vscode-bunest`), except where an issue demonstrates a vulnerability inside an in-scope `@bunest/*` package

### Audit Deliverables

1. **Threat Model & Review Notes:** Documented review of all five trust boundaries and in-scope subpaths.
2. **Private Findings Report:** Detailed report with CVSS v3.1 scores, affected package/subpath, minimal PoC / reproduction steps, and remediation guidance delivered via the private channel in [`SECURITY.md`](../SECURITY.md).
3. **Re-Test Verification Report:** Independent verification of every remediated finding against the patched RC commit/build, confirming the original PoC and variant bypasses are blocked.
4. **Public Executive Summary:** Redacted summary suitable for publication alongside the `1.0.0` release once all Critical/High findings are resolved.

### `1.0` RC Go / No-Go Criteria

A `1.0` RC is **blocked** from `1.0.0` GA promotion unless **all** of the following are satisfied:

- **Zero open Critical or High findings** across all in-scope packages and subpaths.
- **Verified re-tests:** Every remediated Critical/High finding has an automated regression test in the repository and a signed-off independent re-test.
- **Medium/Low disposition:** Every open Medium or Low finding has documented mitigation guidance, explicit risk acceptance, or a scheduled post-GA patch milestone.
- **Release gates green:** `bun run typecheck`, `bun test`, `bun run conformance:gate`, `bun run ai:docs --check`, and `bun run build && bun run verify:release` all pass on the pinned Linux + Bun `1.4.5` CI runner.
