# Cookies & CORS

Bunest integrates directly with Bun's native `req.cookies` (`CookieMap`), RFC-compliant `Set-Cookie` serialization, and built-in CORS handling at Stage 3 of the execution pipeline.

## Reading Cookies (`@Cookies()`)

Extract all cookies as a key-value map or read a single cookie directly via `@Cookies()`:

@@filename(session.controller.ts)

```ts
import { Controller, Cookies, Get, Post, Res } from "@bunest/core";
import type { ResponseContext } from "@bunest/core";

@Controller("session")
export class SessionController {
  @Get()
  inspect(
    @Cookies("session_id") sessionId?: string,
    @Cookies() all?: Record<string, string>,
  ) {
    return {
      sessionId: sessionId ?? null,
      count: Object.keys(all ?? {}).length,
    };
  }

  @Post("login")
  login(@Res() res: ResponseContext) {
    res.cookie("session_id", "tok_9f8a7b", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24,
    });
    res.cookie("theme", "dark", { path: "/" });
    return { loggedIn: true };
  }

  @Post("logout")
  logout(@Res() res: ResponseContext) {
    res.clearCookie("session_id", { path: "/" });
    return { loggedOut: true };
  }
}
```

> info **Multi-Cookie Invariant (ADR-010)** Calling `res.cookie(...)` multiple times always uses `headers.append("Set-Cookie", ...)`—never `headers.set()`—so multiple cookies are always preserved cleanly on the outgoing native `Response`.

## Configuring CORS (`CorsOptions`)

Enable Cross-Origin Resource Sharing via `app.enableCors(options)` or `BunestApplicationOptions.cors`:

@@filename(main.ts)

```ts
const app = await BunestFactory.create(AppModule, {
  cors: {
    origin: ["https://app.example.com", /\.example\.com$/],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["X-Request-Id"],
    credentials: true,
    maxAge: 86400,
  },
});
```

### CORS Pipeline Guarantees (ADR-008 & ADR-011)

- **Fast preflight short-circuit:** `OPTIONS` preflight requests carrying `Origin` and `Access-Control-Request-Method` are answered immediately with `204 No Content` inside both native per-path route dispatchers and the `fetch()` fallback.
- **Preserved on error responses:** Because CORS runs inside the Exception Filter boundary, `400`, `401`, `403`, `404`, `405`, `413`, and `500` responses always retain your configured `Access-Control-*` headers so browser clients receive clean API errors instead of opaque CORS failures.

## Client IP & `trustProxy`

Read the client's IP address using `@Ip()`. By default, Bunest reads `server.requestIP(req)?.address` directly and ignores spoofable `X-Forwarded-For` headers unless `trustProxy` is explicitly enabled in `BunestApplicationOptions`.
