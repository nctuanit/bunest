# Security Policy

## Supported Versions

| Version | Runtime Requirement | Supported |
| ------- | ------------------- | --------- |
| `0.1.x` | Bun `>= 1.4.5`      | Yes       |

For full SemVer, runtime compatibility, and per-module stability tiers, see [`docs/support-policy.md`](./docs/support-policy.md).

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues, pull requests, or public discussions.**

Instead, report suspected vulnerabilities privately using one of the following channels:

1. **GitHub Security Advisories (Preferred):** Use the **Report a vulnerability** button in the repository's **Security** tab. This creates an encrypted, private advisory thread with the maintainers and supports private temporary forks for patch verification.
2. **Direct Email:** Send a report to `security@bunest.dev` including:
   - Affected `@bunest/*` package(s), subpath(s), and version(s)
   - Bun version (`bun --version`) and OS
   - Minimal reproduction steps or proof-of-concept
   - Impact assessment and any suggested remediation
3. **Private / Encrypted Fallback:** If you cannot use GitHub Security Advisories and need end-to-end encryption over email, send a plaintext message to `security@bunest.dev` with the subject `[PGP KEY REQUEST]` (containing no vulnerability details). Maintainers will reply with the current security PGP public key fingerprint so you can transmit an encrypted report and PoC payload.

## Severity-to-Patch SLA

Severity is classified using CVSS v3.1 base scores alongside real-world exploitability in default Bunest configurations:

| Severity | CVSS v3.1 / Criteria | Acknowledgement | Triage & Plan | Target Patch Release |
| -------- | -------------------- | --------------- | ------------- | -------------------- |
| **Critical** | `9.0 – 10.0` (e.g., remote code execution, auth bypass in default config, arbitrary file read/write) | Within **24 hours** | Within **2 business days** | Within **7 days** (expedited out-of-band release) |
| **High** | `7.0 – 8.9` (e.g., privilege escalation, JWT/session forgery, SSRF, SQL injection, prototype pollution leading to authz bypass) | Within **48 hours** | Within **3 business days** | Within **14 days** |
| **Medium** | `4.0 – 6.9` (e.g., scoped DoS, CSRF bypass under non-default settings, sensitive info leak in non-prod/edge paths) | Within **48 hours** | Within **5 business days** | Within **30 days** (next scheduled patch release) |
| **Low** | `0.1 – 3.9` (e.g., hardening gaps, defense-in-depth improvements, low-impact edge cases) | Within **5 business days** | Within **10 business days** | Next regular patch or minor release |

## CVE & Embargo Coordination

- **CVE Assignment:** For confirmed **Medium**, **High**, and **Critical** vulnerabilities, maintainers request a CVE identifier via GitHub Security Advisories (CNA) prior to public disclosure.
- **Coordinated Embargo:** Bunest follows a standard **up to 90-day** coordinated disclosure embargo from the date of initial report receipt. The embargo may be shortened by mutual agreement once a fix is ready (or if active exploitation in the wild is observed), or extended briefly if downstream ecosystem coordination is required.
- **Pre-Release Verification & Credit:** Reporters are invited to review the fix and advisory draft in the private GitHub Security Advisory before publication. With the reporter's permission, credit is published in the advisory and [`CHANGELOG.md`](./CHANGELOG.md).

## Backport Policy

All 19 `@bunest/*` workspace packages are lockstep-versioned and published to npm with provenance (`--provenance`).

- **Pre-`1.0` (`0.x`):** Security fixes are released immediately as patch versions on the latest active minor line (e.g., `0.1.x`). Older `0.x` minor lines do not receive backports.
- **`1.0.0+` (GA & LTS):**
  - **Critical** and **High** fixes are backported to the current major release line and any active LTS release line (see [`docs/support-policy.md`](./docs/support-policy.md)).
  - **Medium** and **Low** fixes are released on the latest minor of the current major line; LTS backports are evaluated case-by-case based on exploitability.

## `1.0` RC Private-Finding Triage & Re-Verification Workflow

During the `1.0` release candidate cycle and independent security review (see [Independent Security Review Scope](./docs/security.md#independent-security-review-scope-10-rc)), all security findings follow a strict private lifecycle:

1. **Private Intake:** Findings are logged exclusively in a private GitHub Security Advisory or the designated encrypted audit channel—never in public issues or PRs.
2. **Triage & Classification:** Within the SLA window above, maintainers confirm reproducibility on the pinned runtime (`Bun >= 1.4.5`), assign CVSS v3.1 severity, and map the affected package(s) and trust boundary.
3. **Private Remediation:** Fixes and minimal regression tests are developed and peer-reviewed in a private advisory fork. Commit messages and branch names must not disclose unpatched vulnerability details during embargo.
4. **Independent Re-Verification:** The reporter or independent auditor verifies the fix against the patched RC build (confirming the original PoC fails and no bypass variants remain) and records a signed-off re-test status.
5. **RC Promotion & Coordinated Disclosure:**
   - No `1.0` RC may be promoted to `1.0.0` GA while any in-scope **Critical** or **High** finding remains open or unverified.
   - Once the patched RC/GA release is published, the advisory, CVE, and regression tests are disclosed in coordination with the reporter/auditor.

## Built-in Security Defaults

Bunest ships conservative security defaults across its consolidated 19-package workspace (see [`docs/security.md`](./docs/security.md) for usage guides):

- **DTO Validation (`@bunest/validation` — [ADR-009](./docs/adr/ADR-009.md)):** `ValidationPipe` defaults to `whitelist: true`, `forbidNonWhitelisted: true`, `forbidUnknownValues: true`, `transformOptions.enableImplicitConversion: false`, and `validationError: { target: false, value: false }` (never echoing sensitive input fields such as passwords).
- **Prototype Pollution Defense:** Own keys `"__proto__"`, `"constructor"`, and `"prototype"` are stripped or rejected across HTTP JSON/query parsing (`@bunest/core/http`), DTO validation (`@bunest/validation`), `.env` config merging (`@bunest/core/config`), WebSocket frame parsing (`@bunest/core/ws`), and W3C `tracestate`/`baggage` header parsing (`@bunest/observability`).
- **Payload & Error Hardening (`@bunest/core/http`, [ADR-008](./docs/adr/ADR-008.md)):** Configurable `bodyLimit` enforces HTTP `413 Payload Too Large` on both `Content-Length` and streaming chunk reads; malformed JSON and `multipart/form-data` return HTTP `400`; production mode (`NODE_ENV === "production"`) redacts internal error messages and stack traces.
- **Cryptography, Auth & Policy Authorization (`@bunest/security`, `@bunest/security/jwt`, `@bunest/security/auth`, `@bunest/security/authz`):**
  - WebCrypto `JwtService` / `JwtVerifier` enforce constant-time verification, reject `alg: "none"`, prevent asymmetric/symmetric algorithm confusion (`RS256` -> `HS256`), and validate HMAC `CryptoKey` hash matches.
  - Password hashing uses `Bun.password` (`argon2id` default).
  - `@bunest/security/auth` provides SHA-256-hashed opaque sessions with fixation defense and cross-origin write checks, single-use refresh-token families with reuse-triggered family revocation, AES-256-GCM-encrypted TOTP MFA with lockout and replay protection, and PKCE (`S256`) + `state`/`nonce`/RFC 9207 `iss` OIDC flows.
  - `@bunest/security/authz` enforces deny-by-default `@Policy` / `@Can` authorization via `AuthorizationGuard` with startup guard-ordering verification.
- **HTTP Headers, Cookies, CSRF, Cache & Rate Limiting (`@bunest/security`, `@bunest/security/throttler`, `@bunest/cache`):** `SecurityHeadersMiddleware`, `SessionCookieService` (HMAC-SHA256 signed `HttpOnly` cookies), double-submit `CsrfGuard`, `CacheInterceptor` (`Set-Cookie` and `Cache-Control: no-store`/`private` bypass), and sliding-window `ThrottlerGuard`.
- **Safe File Storage (`@bunest/storage`, `@bunest/storage/local`):** `LocalStorageAdapter` enforces two-layer path-traversal containment via `assertSafeStorageKey()`, rejecting `..`, `.`, null/control bytes, absolute paths, drive prefixes, and Windows NTFS Alternate Data Streams (`:`).
- **Production Introspection Gate (`@bunest/observability`):** `DevtoolsModule` HTTP endpoints (`/_devtools/*`) are disabled by default whenever `NODE_ENV === "production"`.
- **Structured Log Redaction (`@bunest/core/common`, `@bunest/core/config`, `@bunest/observability`):** Sensitive keys (`password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`, etc.) are deeply redacted without mutating caller objects.

### Deployment Recommendations

- Always configure `trustProxy` explicitly (exact hop count or trusted CIDR/IP list) when running behind a reverse proxy or load balancer so client IP extraction and rate limiting cannot be spoofed via `X-Forwarded-For`.
- Configure explicit `cors.origin` allowlists in production when `credentials: true`.
- Set `NODE_ENV=production` in production deployments to enforce safe error redaction and disable Devtools HTTP endpoints.
