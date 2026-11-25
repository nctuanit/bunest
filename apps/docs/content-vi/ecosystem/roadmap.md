# Lộ trình Triển khai

Bunest đi theo lộ trình theo từng giai đoạn, kiểm soát qua các cổng chất lượng (gate-driven), ưu tiên **tính đúng đắn, hợp đồng kiến trúc chặt chẽ, không import vòng lặp và benchmark có thể tái lập**.

## Các cột mốc Phát hành

| Phiên bản | Phạm vi Mục tiêu | Trạng thái |
| --- | --- | --- |
| **`v0.1`** | Nền tảng: Legacy decorators, metadata registry, DI chặt chẽ & đồ thị `@Module()`, vòng đời, HTTP adapter `Bun.serve` gốc, các package lõi | **Hoàn thành** |
| **`v0.2`** | Tương đồng NestJS v12: `DiscoveryService`/`MetadataScanner`, API Versioning, `RouterModule`, `ConfigurableModuleBuilder`, Durable DI, `LazyModuleLoader`, `ClsModule`, `rawBody`, `StreamableFile`, `ParseFilePipe`, `CompressionMiddleware`, `useStaticAssets`, Standard Schema v1, các kiểu mapped DTO | **Hoàn thành** |
| **`v0.5`** | Hệ sinh thái NestJS v12 hợp nhất gốc trên Bun: 35 package hợp nhất (`@bunest/orm`, `@bunest/ai`, `@bunest/ai/mcp`, `@bunest/core/client`, `@bunest/core/i18n`, `@bunest/mail`, `@bunest/storage`, `@bunest/security/auth`, `@bunest/security/authz`, `@bunest/resilience`, `@bunest/resilience/locks`, `@bunest/resilience/idempotency`, `@bunest/messaging/outbox`, `@bunest/messaging/webhooks`, `@bunest/workflows`, `@bunest/elasticsearch`, `@bunest/graphql/apollo`, cùng các bản hợp nhất `@bunest/jobs/queues`, `@bunest/security`, `@bunest/observability`, `@bunest/core/http`, `@bunest/validation`) | **Hoàn thành** |
| **`v0.8`** | AOP tầng Service & Declarative Repository `@bunest/orm` thống nhất gốc trên Bun: `MethodAspectWeaver` không chi phí dư thừa, `@Transactional`, `@OrmRepository` + `CrudRepository` biên dịch một lần, `OrmMigrationRunner`, các subpath SQL Store Kit (`./store`, `./postgres`, `./mysql`, `./testing`), `@UseMiddleware`, `@Cacheable`, `@Span`, `@EmitEvent`, `@Auth`/`@Protected`, `@InjectConfig`, `@WithLock`, `@WithCls`, `@Retry`/`@CircuitBreaker` tầng service | **Hoàn thành** |
| **`v1.0`** | Đóng băng các hợp đồng lõi, chính sách semver, đánh giá bảo mật độc lập bên ngoài, kiểm chứng vận hành thực tế trên production | **Đang thực hiện** |

## Chi tiết theo từng Giai đoạn

### Giai đoạn 0 — Nền tảng _(Hoàn thành)_

- [x] Chốt các Bản ghi Quyết định Kiến trúc (`ADR-001` – `ADR-014`) & `RFC-001`
- [x] `@bunest/core`, `@bunest/core`, `@bunest/validation` (bao gồm các hàm hỗ trợ mapped DTO) đạt 100% độ tương đồng NestJS v12.5.1 điều chỉnh theo ADR

### Giai đoạn 1 — Lõi HTTP & Tương đồng NestJS v12 _(Hoàn thành)_

- [x] `@bunest/core/http`: `AbstractHttpAdapter` & `BunHttpAdapter` gốc trên Bun, hybrid `Bun.serve({ routes })` + `FallbackRadixRouter`, `ServeStaticModule`, Fetch-Metadata CSRF, các header bảo mật Helmet-8, cookie ký HMAC-SHA256, `@Render()`, API Versioning, `CompressionMiddleware`, `useStaticAssets`, `@UseMiddleware`

### Giai đoạn 2 — Trải nghiệm Lập trình viên _(Hoàn thành)_

- [x] `@bunest/testing`, `@bunest/core/config`, `@bunest/cli`, `@bunest/swagger`, `@bunest/core/client`, `@bunest/core/i18n`, `@bunest/mail`, `@bunest/storage`

### Giai đoạn 3 — Bảo mật, Định danh & Lưu trữ Dữ liệu _(Hoàn thành)_

- [x] `@bunest/security` (`JwtModule`, `PassportModule`, `ThrottlerModule`), `@bunest/security/auth`, `@bunest/security/authz`
- [x] `@bunest/orm` (12 dialect trên `bun:sqlite`, `Bun.SQL`, `fetch()` và `Bun.connect()`, cùng các subpath `./store`, `./postgres`, `./mysql`, `./testing`), `@bunest/elasticsearch`

### Giai đoạn 4 — Thời gian thực, Hệ thống Phân tán, AI & Giám sát _(Hoàn thành)_

- [x] `@bunest/core/ws`, `@bunest/graphql`, `@bunest/graphql/apollo`
- [x] `@bunest/messaging/events`, `@bunest/jobs/scheduler`, `@bunest/cache`, `@bunest/jobs/queues` (`QueueModule`, `BullModule`/`BullMQModule`), `@bunest/messaging/cqrs`, `@bunest/microservices`
- [x] `@bunest/resilience`, `@bunest/resilience/locks`, `@bunest/resilience/idempotency`, `@bunest/messaging/outbox`, `@bunest/messaging/webhooks`, `@bunest/workflows`
- [x] `@bunest/ai`, `@bunest/ai/mcp`
- [x] `@bunest/observability` (`ObservabilityModule`, `TerminusModule`/`HealthModule`, `DevtoolsModule`)

### Giai đoạn 5 — AOP tầng Service & Declarative Repository _(Hoàn thành)_

- [x] `MethodAspectWeaver` trong `DIContainer` không chi phí dư thừa (`WeakMap` bỏ qua trong `O(1)` cho các class không gắn decorator)
- [x] Declarative repository biên dịch một lần trong `@bunest/orm` (`@OrmRepository`/`CrudRepository`) với derived finder, `@Query`/`@Modifying`/`@SqlParam`, `@Transactional` và `OrmMigrationRunner`
- [x] Bộ benchmark đối đầu trực tiếp 8 mục tiêu công khai có thể tái lập so sánh Bunest với `Bun.serve()` thuần và NestJS v12 trên Bun & Node.js

## Chính sách Trung thực Benchmark

Bunest không bao giờ công bố các tuyên bố tiếp thị kiểu _"nhanh hơn X lần"_ thiếu kiểm chứng. Mọi benchmark được công bố cho Bunest đều phải minh bạch:

1. Phiên bản Bun chính xác, hệ điều hành, CPU, RAM và phiên bản các package.
2. Số lượng route, kích thước payload, mức độ đồng thời (concurrency), keep-alive, thời gian khởi động (warmup) và thời lượng đo.
3. Cấu hình middleware/validation/logging tương đương giữa các framework.
4. Thông lượng (req/s), độ trễ `p50`/`p95`/`p99`, CPU, bộ nhớ/RSS và tỷ lệ lỗi—kèm script có thể tái lập được commit trong kho mã nguồn.
