# Deployment & Production Checklist

Bunest compiles routes, DI graphs, validation schemas, and declarative repositories **once at bootstrap** directly onto `Bun.serve()`, making it ideal for lightweight containers and single-file compiled binaries. This guide covers production deployment patterns and a pre-launch checklist.

## 1. Multi-Stage Docker Image

Use the official `oven/bun` image with a minimal runtime stage so your production container stays small and fast to cold-start:

@@filename(Dockerfile)

```dockerfile
# Stage 1: Install dependencies & build
FROM oven/bun:1.4.5 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# Stage 2: Minimal production runtime
FROM oven/bun:1.4.5-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist

USER bun
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e 'const r = await fetch("http://127.0.0.1:3000/health/live"); process.exit(r.ok ? 0 : 1)'

CMD ["bun", "run", "dist/main.js"]
```

## 2. Single-File Executable (`bun build --compile`)

Because Bunest has **zero external runtime dependencies**, you can ship your entire API as a single self-contained native binary with `bun build --compile`:

```bash
bun build src/main.ts --compile --minify --outfile dist/my-api
./dist/my-api
```

> tip **Metadata Plugin** If your build bundles legacy decorator metadata across packages, wire `bunestMetadataPlugin()` from `@bunest/cli` into your `Bun.build()` script so reflection metadata is preserved cleanly.

## 3. Graceful Shutdown

Enable shutdown hooks so in-flight HTTP requests, database pools, Redis clients, and background workers drain cleanly on `SIGTERM` / `SIGINT` (Kubernetes pod eviction, rolling deploys):

@@filename(main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);

// Ensures OnModuleDestroy, BeforeApplicationShutdown, and OnApplicationShutdown run on SIGTERM/SIGINT
app.enableShutdownHooks();

// Harden defaults for production
app.useSecurityHeaders();
app.enableCors({
  origin: process.env.CORS_ORIGINS?.split(",") ?? [],
  credentials: true,
});

const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port, "0.0.0.0");
```

## 4. Health Probes (Liveness & Readiness)

Expose separate `/health/live` (process is responsive) and `/health/ready` (DB/Redis dependencies are reachable) endpoints using [`@bunest/observability`](/observability/observability):

@@filename(health.controller.ts)

```ts
import { Controller, Get } from "@bunest/core";
import { HealthCheck, HealthCheckService } from "@bunest/observability";
import { Public } from "@bunest/security";

@Public()
@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  @Get("live")
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  @Get("ready")
  @HealthCheck()
  ready() {
    return this.health.check([
      async () => ({ database: { status: "up" } }),
    ]);
  }
}
```

## 5. Production Pre-Launch Checklist

| Area | Check | Reference |
| --- | --- | --- |
| **Environment** | `NODE_ENV=production` set (suppresses stack traces in error responses) | [Exception filters](/overview/exception-filters) |
| **Validation** | Global `ValidationPipe` enabled (`whitelist: true`, `forbidNonWhitelisted: true`) | [Validation](/techniques/validation) |
| **Security Headers & CSRF** | `app.useSecurityHeaders()` and `enableCsrfProtection()` (for cookie auth) enabled | [Security Module](/security/security-module) |
| **Rate Limiting** | `ThrottlerModule` / `@Throttle()` configured on auth & public endpoints | [Security Module](/security/security-module) |
| **Body Limits** | Explicit `bodyLimit` set to prevent oversized payload DoS | [Streaming & Uploads](/techniques/streaming-uploads) |
| **Graceful Shutdown** | `app.enableShutdownHooks()` called before `app.listen()` | [Lifecycle events](/fundamentals/lifecycle-events) |
| **Observability** | Structured JSON logging, `/metrics` Prometheus scrape, OTLP traces configured | [Observability](/observability/observability) |
| **Migrations** | Database migrations run as a release job before scaling new pods | [ORM & Adapters](/data/orm-adapters) |
