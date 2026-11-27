# Triển khai & Checklist Production

Bunest biên dịch toàn bộ route, đồ thị DI, schema kiểm tra dữ liệu và declarative repository **một lần duy nhất lúc khởi động** trực tiếp lên `Bun.serve()`, giúp ứng dụng cực kỳ gọn nhẹ khi đóng gói Docker hoặc biên dịch thành single binary.

## 1. Multi-Stage Docker Image

Sử dụng image chính thức `oven/bun` với 2 stage để container production nhỏ gọn và khởi động nhanh:

@@filename(Dockerfile)

```dockerfile
# Stage 1: Cài đặt & build
FROM oven/bun:1.4.5 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# Stage 2: Runtime production tối giản
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

## 2. Biên dịch thành Single Binary (`bun build --compile`)

Nhờ **0 external runtime dependencies**, bạn có thể đóng gói toàn bộ API thành một file thực thi duy nhất:

```bash
bun build src/main.ts --compile --minify --outfile dist/my-api
./dist/my-api
```

> tip **Metadata Plugin** Khi bundle legacy decorator metadata qua nhiều package, hãy gắn `bunestMetadataPlugin()` từ `@bunest/cli` vào script `Bun.build()` để bảo toàn đầy đủ metadata.

## 3. Graceful Shutdown

Bật shutdown hooks để request đang xử lý, connection pool database, Redis client và background worker đóng kết nối an toàn khi nhận `SIGTERM` / `SIGINT` (Kubernetes rolling deploy):

@@filename(main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);

// Kích hoạt OnModuleDestroy, BeforeApplicationShutdown và OnApplicationShutdown khi nhận SIGTERM/SIGINT
app.enableShutdownHooks();

// Cấu hình bảo mật mặc định cho production
app.useSecurityHeaders();
app.enableCors({
  origin: process.env.CORS_ORIGINS?.split(",") ?? [],
  credentials: true,
});

const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port, "0.0.0.0");
```

## 4. Health Probes (Liveness & Readiness)

Tách riêng `/health/live` (tiến trình còn sống) và `/health/ready` (database/Redis sẵn sàng nhận traffic) bằng [`@bunest/observability`](/observability/observability):

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

## 5. Checklist trước khi lên Production

| Hạng mục | Kiểm tra | Tài liệu liên quan |
| --- | --- | --- |
| **Môi trường** | Đặt `NODE_ENV=production` (ẩn stack trace trong phản hồi lỗi) | [Bộ lọc ngoại lệ](/overview/exception-filters) |
| **Validation** | Bật `ValidationPipe` toàn cục (`whitelist: true`, `forbidNonWhitelisted: true`) | [Validation](/techniques/validation) |
| **Security & CSRF** | Bật `app.useSecurityHeaders()` và `enableCsrfProtection()` (khi dùng cookie auth) | [Security Module](/security/security-module) |
| **Rate Limiting** | Cấu hình `ThrottlerModule` / `@Throttle()` cho các route đăng nhập và public | [Security Module](/security/security-module) |
| **Giới hạn Body** | Đặt `bodyLimit` rõ ràng để chống DoS payload lớn | [Streaming & Uploads](/techniques/streaming-uploads) |
| **Graceful Shutdown** | Gọi `app.enableShutdownHooks()` trước `app.listen()` | [Lifecycle events](/fundamentals/lifecycle-events) |
| **Observability** | Bật structured JSON log, Prometheus `/metrics`, OTLP traces | [Observability](/observability/observability) |
| **Migrations** | Chạy migration database ở bước release job trước khi scale pod mới | [ORM & Adapters](/data/orm-adapters) |
