# Security Guide

Bunest ships secure-by-default HTTP, validation, authentication, rate-limiting, and file-storage primitives designed specifically for Bun's native WebCrypto and `Bun.password` APIs.

---

## 1. Built-In Core & Validation Security Defaults

### Strict `ValidationPipe` Defaults ([ADR-009](./adr/ADR-009.md))

Enabling `app.useGlobalPipes(new ValidationPipe())` automatically enforces:

- **`whitelist: true`**: Strips any property lacking a `class-validator` decorator (mass-assignment defense).
- **`forbidNonWhitelisted: true`**: Rejects requests containing unknown properties with HTTP `400`.
- **`forbidUnknownValues: true`**: Prevents non-object or malformed payloads from passing validation as empty valid DTOs.
- **`transformOptions.enableImplicitConversion: false`**: Blocks silent JavaScript type-coercion bugs (e.g., `"false"` turning into `true`).
- **`validationError: { target: false, value: false }`**: Never echoes raw rejected values (passwords, tokens, PII) in HTTP 400 responses.
- **Prototype-pollution defense**: Both `@bunest/http` (`sanitizeObject` / `sanitizeRecord`) and `@bunest/validation` (`stripDangerousKeys` / `findDangerousKeys`) strip or reject dangerous keys (`__proto__`, `constructor`, `prototype`) before DTO instantiation.

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
- **Log secret redaction:** Both `@bunest/common`'s `Logger` and `@bunest/config`'s `createSecretRedactor()` automatically redact sensitive keys (`password`, `secret`, `token`, `authorization`, `apiKey`, `cookie`, `privateKey`, etc.) while safely handling circular objects and `BigInt` values.

---

## 2. Security Headers (`SecurityHeadersMiddleware`)

`@bunest/security` provides a Helmet-style middleware with strong defaults (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `X-DNS-Prefetch-Control: off`):

```ts
import { BunestFactory } from "@bunest/core";
import { createSecurityHeadersMiddleware } from "@bunest/security";

const app = await BunestFactory.create(AppModule);

app.use(
  createSecurityHeadersMiddleware({
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true, preload: true },
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

## 4. Authentication & Authorization (`@bunest/security`)

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

When authenticating via cookies instead of `Authorization: Bearer`, pair `SessionCookieService` (sets `HttpOnly`, `SameSite`, `Secure` cookies) with `CsrfGuard` (timing-safe double-submit token validation via `timingSafeEqualString`).

---

## 5. Rate Limiting (`ThrottlerModule` & `ThrottlerGuard`)

Protect endpoints from brute-force and DoS traffic using sliding-window rate limiting:

```ts
import { APP_GUARD, Module } from "@bunest/core";
import { SkipThrottle, Throttle, ThrottlerGuard, ThrottlerModule } from "@bunest/security";

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

## 6. Safe File Storage (`StorageModule` & `LocalStorageAdapter`)

`StorageModule.forRoot({ driver: "local", rootDir: "./uploads" })` enforces `assertSafeStorageKey()` on every put/get/delete/stat call, blocking:
- Path traversal (`../`, `..\\`, absolute paths)
- Null bytes (`\0`) and control characters
- Windows drive letters and NTFS Alternate Data Streams (`:` in any path segment, e.g., `file.txt:hidden`)

Always validate uploaded MIME types and file sizes via custom pipes on `@UploadedFile()` before persisting.

---

## 7. Reverse Proxy & `trustProxy` Guidance

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
