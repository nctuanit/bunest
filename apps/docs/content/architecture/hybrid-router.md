# Hybrid `Bun.serve` Router

`Bun.serve({ routes, fetch, websocket })` provides an ultra-fast native Zig router, yet empirical testing on **Bun 1.4.5** shows specific gaps (such as `405 + Allow`, host-constrained routes, optional/regex params, and mid-path wildcards). **[ADR-011](/architecture/adrs)** specifies Bunest's hybrid compilation strategy that keeps 95%+ of REST routes on Bun's native fast path while handling every edge case cleanly.

@@component(router-architecture)

## Verified Bun 1.4.5 `routes` Support Matrix

Native matching precedence inside `Bun.serve({ routes })` is strictly **`static > :param > * > fetch`**.

| Routing Feature                                       | Bun 1.4.5 Native Behavior                    | Bunest Strategy                                                    |
| ----------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Static paths (`/`, `/users`, `/api/health`)           | Supported natively                           | Compile into `Bun.serve({ routes })`                               |
| Named params (`/users/:id`, `/:org/repos/:id`)        | Supported natively; `req.params` URL-decoded | Compile into `Bun.serve({ routes })`                               |
| Trailing wildcard (`/files/*`)                        | Supported natively (misses bare `/files`)    | Compile into `Bun.serve({ routes })`                               |
| `req.cookies` (`CookieMap`) & `server.requestIP(req)` | Supported natively                           | Used directly by `@Cookies()` & `@Ip()`                            |
| WebSocket upgrade (`server.upgrade`)                  | Supported from `routes` and `fetch()`        | Dispatched cleanly for WS gateways                                 |
| **Unmatched verb &rarr; `405` + `Allow`**             | Falls through to `fetch()` natively          | Handled in **O(1)** inside per-path `routes[path]` dispatcher      |
| **CORS `OPTIONS` preflight**                          | Unmatched `OPTIONS` falls through            | Handled in per-path dispatcher & `fetch()` fallback                |
| **Trailing slash (`/users/` vs `/users`)**            | Strict miss natively                         | Strict by default; opt-in `ignoreTrailingSlash: true` in `fetch()` |
| **Mid-path wildcard (`/files/*/meta`)**               | Not native                                   | Compiled into **Fallback Radix Router**                            |
| **Optional params (`/users/:id?`)**                   | Treated literally natively                   | Compiled into **Fallback Radix Router**                            |
| **Regex params (`/users/:id(\\d+)`)**                 | Treated literally natively                   | Compiled into **Fallback Radix Router**                            |
| **Host constraints (`@Controller({ host })`)**        | Not native                                   | Compiled into **Fallback Radix Router**                            |

## Why One Per-Path Dispatcher Closure?

Instead of registering a raw `{ GET, POST }` object map per path in `Bun.serve({ routes })`, Bunest registers a **single compiled closure `(req, server) => ...`** for every native-eligible canonical path:

1. Preserves Bun's native Zig radix lookup, `req.params`, `req.cookies`, and `static > :param > * > fetch` precedence.
2. Dispatches `methods[req.method]` in **O(1)** (mapping `HEAD` to `GET` with an empty body when no explicit `HEAD` route exists, and falling back to `@All()` if defined).
3. Answers **CORS `OPTIONS` preflight** immediately on matched paths without falling through to `fetch()`.
4. Returns **`405 Method Not Allowed`** with a precomputed sorted `Allow` header (e.g., `"GET, HEAD, POST"`) directly through Global Exception Filters with CORS headers preserved.
5. Executes pre-bound `MiddlewareConsumer` chains resolved at bootstrap—zero per-request middleware regex matching.

## Controlled `fetch(req, server)` Fallback Order

Requests not matched by `Bun.serve({ routes })` enter Bunest's `fetch()` handler in exact order:

```text
fetch(req, server)
  1. WebSocket Upgrade Check (if WS gateway registered on pathname)
  2. Trailing-Slash Normalization (only if ignoreTrailingSlash === true)
  3. Fallback Radix Router Match (host, mid-path wildcard, optional/regex params)
       -> method match: run compiled ExecutionPlan closure
       -> CORS preflight OPTIONS: return 204 with CORS headers
       -> method mismatch: throw MethodNotAllowedException (405) + Allow header
  4. Unmatched CORS Preflight Check (if CORS enabled & OPTIONS + Origin + ACRM)
  5. 404 Not Found -> NotFoundException(`Cannot ${req.method} ${pathname}`)
       -> routed through Global Exception Filters with CORS headers
```

> tip **Parallel E2E Testing** `@bunest/core/http` supports `app.listen(0)` (ephemeral OS-assigned port) and exposes `app.getUrl()`, making parallel `bun test` suites completely port-conflict-free—or use `@bunest/testing`'s zero-socket `request(app)` / `TestClient` / `app.inject()` (see the [Testing guide](/fundamentals/testing)).
