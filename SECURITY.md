# Security Policy

## Supported Versions

| Version | Runtime Requirement | Supported |
| ------- | ------------------- | --------- |
| `0.1.x` | Bun `>= 1.4.3`      | Yes       |

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues or public discussions.**

Instead, report suspected vulnerabilities privately using one of the following channels:

1. **GitHub Security Advisories:** Use the **Report a vulnerability** button in the repository's **Security** tab (preferred).
2. **Direct Contact:** Email `security@bunest.dev` with:
   - Affected package(s) and version(s)
   - Bun version (`bun --version`) and OS
   - Minimal reproduction steps or proof-of-concept
   - Impact assessment and any suggested remediation

### Response Timeline

- **Acknowledgement:** within **48 hours** of receipt.
- **Triage & Assessment:** within **5 business days**, including severity classification and remediation plan.
- **Fix & Coordinated Disclosure:** critical/high issues are prioritized for immediate patch releases; credit is given to reporters who wish to be acknowledged after coordinated release.

## Built-in Security Defaults

Bunest ships conservative security defaults across its core and security packages:

- **DTO Validation (`@bunest/validation` — ADR-009):** `ValidationPipe` defaults to `whitelist: true`, `forbidNonWhitelisted: true`, `forbidUnknownValues: true`, `transformOptions.enableImplicitConversion: false`, and `validationError: { target: false, value: false }` (never echoing sensitive input fields such as passwords).
- **Prototype Pollution Defense:** Own keys `"__proto__"`, `"constructor"`, and `"prototype"` are stripped or rejected across HTTP JSON/query parsing (`@bunest/http`), DTO validation (`@bunest/validation`), `.env` config merging (`@bunest/config`), WebSocket frame parsing (`@bunest/websockets`), and W3C `tracestate`/`baggage` header parsing (`@bunest/observability`).
- **Payload & Error Hardening (`@bunest/http`):** Configurable `bodyLimit` enforces HTTP `413 Payload Too Large` on both `Content-Length` and streaming chunk reads; malformed JSON returns HTTP `400`; production mode (`NODE_ENV === "production"`) redacts internal error messages and stack traces.
- **Cryptography & Auth (`@bunest/security`):** WebCrypto `JwtService` enforces constant-time verification, rejects `alg: "none"`, prevents asymmetric/symmetric algorithm confusion (`RS256` -> `HS256`), validates HMAC `CryptoKey` hash matches, and hashes passwords with `Bun.password` (`argon2id` default).
- **HTTP Headers, Cookies, CSRF & Rate Limiting:** `SecurityHeadersMiddleware`, `SessionCookieService` (HMAC-SHA256 signed `HttpOnly` cookies), double-submit `CsrfGuard`, `CacheInterceptor` (`Set-Cookie` and `Cache-Control: no-store`/`private` bypass), and sliding-window `ThrottlerGuard`.
- **Safe File Storage (`@bunest/security`):** `LocalStorageAdapter` enforces two-layer path-traversal containment rejecting `..`, `.`, null/control bytes, absolute paths, drive prefixes, and Windows NTFS Alternate Data Streams (`:`).
- **Production Introspection Gate (`@bunest/observability`):** `DevtoolsModule` HTTP endpoints (`/_devtools/*`) are disabled by default whenever `NODE_ENV === "production"`.
- **Structured Log Redaction (`@bunest/common`, `@bunest/observability`):** Sensitive keys (`password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`, etc.) are deeply redacted without mutating caller objects.

### Deployment Recommendations

- Always configure `trustProxy` explicitly (exact hop count or trusted CIDR/IP list) when running behind a reverse proxy or load balancer so client IP extraction and rate limiting cannot be spoofed via `X-Forwarded-For`.
- Configure explicit `cors.origin` allowlists in production when `credentials: true`.
- Set `NODE_ENV=production` in production deployments to enforce safe error redaction and disable Devtools HTTP endpoints.
