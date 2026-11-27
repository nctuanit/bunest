# Lộ trình Triển khai & Phạm vi Hỗ trợ

Bunest đi theo lộ trình theo từng giai đoạn, kiểm soát qua các cổng chất lượng (gate-driven), ưu tiên **tính đúng đắn, hợp đồng kiến trúc chặt chẽ, không import vòng lặp, không runtime dependency ngoài và benchmark có thể tái lập**.

> info **Cách đọc trang này** Lộ trình dưới đây tách bạch bốn khía cạnh khác nhau: **(1) Phiên bản đang phát hành**, **(2) Phạm vi hỗ trợ Production** (công bố theo từng module dựa trên kiểm thử hạ tầng thật, không suy diễn từ số lượng unit/conformance test), **(3) Tính năng đã triển khai trong monorepo**, và **(4) Các mốc lịch sử trước khi hợp nhất package**.

---

## 1. Trạng thái Phát hành Hiện tại (`0.1.0 Production Preview`)

| Tiêu chí | Hiện trạng |
| --- | --- |
| **Phiên bản đã phát hành** | **`0.1.0` — Production Preview** (đồng nhất phiên bản cho toàn bộ **19 package `@bunest/*`**) |
| **Runtime mục tiêu** | **Bun `>= 1.4.5`** (cổng CI bắt buộc trên Linux + Bun `1.4.5`; theo dõi `latest` trên Linux, macOS, Windows) |
| **Kiến trúc Package** | **19 package hợp nhất** theo 6 lĩnh vực (`ADR-016`), **19/19 (100%) không có runtime dependency bên ngoài** (`ADR-017`), **0 RxJS**, **0 import vòng lặp** |
| **Tương thích NestJS v12** | **7.005 / 7.005 (100,00%, 0 skip)** bài kiểm thử conformance thượng nguồn đạt trong monorepo |
| **Phạm vi Production Preview** | REST API trên Linux + Bun `1.4.5` với `@bunest/core`, `@bunest/validation`, `@bunest/orm` (PostgreSQL qua `Bun.SQL`, migration tường minh) và `@bunest/observability` |

---

## 2. Lộ trình Phát hành (`0.1.0` → `1.0`)

| Dòng phiên bản | Phạm vi & Cam kết | Trạng thái |
| --- | --- | --- |
| **`0.1.0` (Production Preview)** | Bản phát hành công khai đầu tiên của hệ sinh thái 19 package không phụ thuộc ngoài cho Bun `>= 1.4.5`, kèm ứng dụng tham chiếu PostgreSQL (`examples/production-rest-postgres`), runbook và tự động hóa phát hành | **Đã phát hành** |
| **`0.1.x` (Củng cố Preview)** | Kiểm chứng cài đặt sạch & nâng cấp ngoài monorepo từ registry, kiểm thử thực tế trên PostgreSQL (lưu trữ, migration, ngắt kết nối, backup/restore), soak 2 giờ & diễn tập rollback `< 5 phút`, xác thực với ứng dụng pilot, chỉ gồm bản vá tương thích ngược | **Đang thực hiện** |
| **`0.2.x+` (Các chu kỳ Minor)** | Nâng mức hỗ trợ các module tiếp theo theo nhu cầu thực tế (ví dụ `@bunest/cache` / `@bunest/jobs` dùng Redis sau khi kiểm chứng fault-injection thật), kiểm kê `package.json#exports` và chính sách deprecation | **Kế hoạch** |
| **`1.0.0` (General Availability)** | Đóng băng các hợp đồng lõi, cam kết tương thích ngược SemVer đầy đủ trên public exports, đánh giá bảo mật độc lập và xác nhận nâng cấp qua nhiều phiên bản từ dự án pilot | **Kế hoạch** |

---

## 3. Phạm vi Hỗ trợ Production (Phân tầng Ổn định theo Module)

Cả 19 package đều được phát hành đồng bộ phiên bản dưới nhánh `0.1.x` với đầy đủ unit test và conformance test, nhưng **mức sẵn sàng production được công bố riêng cho từng module** dựa trên kiểm thử tích hợp và tạo lỗi trên hạ tầng thật (xem `docs/support-policy.md`, `docs/public-api-matrix.md`, `docs/production-preview.md` trong kho mã nguồn và [Triển khai & Production](/recipes/deployment)):

| Mức ổn định | Package / Phạm vi | Tiêu chí đạt chuẩn |
| --- | --- | --- |
| **Production Preview (`0.1`)** | `@bunest/core` (HTTP, DI, Config), `@bunest/validation`, `@bunest/orm` (PostgreSQL qua `Bun.SQL`, migration tường minh), `@bunest/observability` (logging, health, metrics) trên **Linux** | CI Linux cố định phiên bản xanh, bộ smoke trên PostgreSQL thật (persistence/migration/outage/backup), soak 2 giờ (`p95 < 200 ms`, `5xx < 0,1%`, RSS ổn định), diễn tập rollback `< 5 phút`, cài đặt sạch từ registry ngoài monorepo |
| **Beta (Đã kiểm chứng tích hợp)** | `@bunest/cache`, `@bunest/jobs`, `@bunest/security`, `@bunest/swagger`, `@bunest/testing`, `@bunest/cli`, `@bunest/resilience`, `@bunest/orm` (SQLite) | Đầy đủ unit & conformance test + bài kiểm thử tích hợp với dịch vụ thật (Redis / SQLite) trên CI |
| **Preview / Thử nghiệm** | `@bunest/graphql`, `@bunest/microservices`, `@bunest/messaging`, `@bunest/workflows`, `@bunest/storage`, `@bunest/mail`, `@bunest/elasticsearch`, `@bunest/ai`, các dialect `Bun.SQL` ngoài PostgreSQL (MySQL/MariaDB/MongoDB/LibSQL/D1) | Hoạt động đầy đủ với 100% conformance / unit test; chờ bộ kiểm thử fault-injection & soak chuyên biệt trên hạ tầng thật trước khi nâng hạng |

---

## 4. Các Tính năng Đã Triển khai trong Monorepo (Chi tiết theo Giai đoạn)

Toàn bộ các giai đoạn dưới đây đều **đã được triển khai trong monorepo `0.1.0`** trên 19 package `@bunest/*` (xem [Các Package & Monorepo](/ecosystem/packages) để biết đầy đủ danh sách subpath):

### Giai đoạn 0 — Nền tảng _(Đã triển khai)_

- [x] Chốt các Bản ghi Quyết định Kiến trúc (`ADR-001` – `ADR-018`) & `RFC-001` (xem [Chỉ mục ADR & RFC](/architecture/adrs))
- [x] `@bunest/core` (gồm subpath `./common` cho decorator, metadata registry, DI chặt chẽ & đồ thị `@Module()`) và `@bunest/validation` (gồm các hàm hỗ trợ mapped DTO) đạt 100% độ tương đồng NestJS v12.5.1 điều chỉnh theo ADR

### Giai đoạn 1 — Lõi HTTP & Tương đồng NestJS v12 _(Đã triển khai)_

- [x] `@bunest/core/http`: `AbstractHttpAdapter` & `BunHttpAdapter` gốc trên Bun, hybrid `Bun.serve({ routes })` + `FallbackRadixRouter`, `ServeStaticModule`, Fetch-Metadata CSRF, các header bảo mật Helmet-8, cookie ký HMAC-SHA256, `@Render()`, API Versioning, `CompressionMiddleware`, `useStaticAssets`, `@UseMiddleware`

### Giai đoạn 2 — Trải nghiệm Lập trình viên _(Đã triển khai)_

- [x] `@bunest/testing`, `@bunest/core/config`, `@bunest/cli`, `@bunest/swagger`, `@bunest/core/client`, `@bunest/core/i18n`, `@bunest/mail`, `@bunest/storage`

### Giai đoạn 3 — Bảo mật, Định danh & Lưu trữ Dữ liệu _(Đã triển khai)_

- [x] `@bunest/security` (`SecurityModule.forRoot()`, `JwtModule`, `PassportModule`, `ThrottlerModule`), `@bunest/security/auth`, `@bunest/security/authz`
- [x] `@bunest/orm` (12 dialect trên `bun:sqlite`, `Bun.SQL`, `fetch()` và `Bun.connect()`, cùng các subpath `./plugin`, `./store`, `./postgres`, `./mysql`, `./testing`), `@bunest/elasticsearch`

### Giai đoạn 4 — Thời gian thực, Hệ thống Phân tán, AI & Giám sát _(Đã triển khai)_

- [x] `@bunest/core/ws`, `@bunest/graphql`, `@bunest/graphql/apollo`
- [x] `@bunest/messaging/events`, `@bunest/jobs/scheduler`, `@bunest/cache`, `@bunest/jobs/queues` (`QueueModule`, `BullModule`/`BullMQModule`), `@bunest/messaging/cqrs`, `@bunest/microservices`
- [x] `@bunest/resilience`, `@bunest/resilience/locks`, `@bunest/resilience/idempotency`, `@bunest/messaging/outbox`, `@bunest/messaging/webhooks`, `@bunest/workflows`
- [x] `@bunest/ai`, `@bunest/ai/mcp`
- [x] `@bunest/observability` (`ObservabilityModule`, `TerminusModule`/`HealthModule`, `DevtoolsModule`)

### Giai đoạn 5 — AOP tầng Service, Hợp nhất Zero-Dep & Declarative Repository _(Đã triển khai)_

- [x] `MethodAspectWeaver` trong `DIContainer` không chi phí dư thừa (`WeakMap` bỏ qua trong `O(1)` cho các class không gắn decorator, `ADR-014`)
- [x] Declarative repository biên dịch một lần trong `@bunest/orm` (`@Repository`/`CrudRepository`) với derived finder, `@Transactional` và `OrmMigrationRunner`
- [x] Bộ máy validate/transform DTO không phụ thuộc ngoài (`ADR-015`), hợp nhất thành 19 package theo 6 lĩnh vực (`ADR-016`), 19/19 package không runtime dependency & cách ly 2 adapter `node:*` (`ADR-017`), cùng kiến trúc magic/plugin tùy biến (`ADR-018`)
- [x] Bộ benchmark đối đầu trực tiếp 8 mục tiêu công khai có thể tái lập so sánh Bunest với `Bun.serve()` thuần và NestJS v12 trên Bun & Node.js

---

## 5. Các Mốc Lịch sử Trước khi Hợp nhất

Một số tài liệu cũ trong kho mã nguồn và mục lịch sử của `CHANGELOG.md` có nhắc tới các mốc tiền phát hành nội bộ (`v0.1`, `v0.2`, `v0.5`, `v0.8`) cũng như cấu trúc workspace lớn hơn trước khi hợp nhất (**22 → 53 → 35/37** package trước `ADR-016`). Đây là **các giai đoạn phát triển nội bộ trong lịch sử**, không phải các tag npm hay dòng phiên bản phát hành riêng lẻ:

| Nhãn lịch sử | Tag npm đã phát hành? | Ý nghĩa trước đây | Tương đương hiện tại ở `0.1.0` |
| --- | --- | --- | --- |
| **Nội bộ `v0.1` / `v0.2`** | Không (mốc nội bộ) | Nền tảng 22 package ban đầu + tương đồng NestJS v12 (`DiscoveryService`, API Versioning, `RouterModule`, Durable DI, `StandardSchemaV1`, v.v.) | Đã hợp nhất vào `@bunest/core`, `@bunest/validation` và các package lõi |
| **Nội bộ `v0.5` (53 → 35/37 pkg)** | Không (mốc nội bộ) | Mở rộng toàn bộ hệ sinh thái NestJS v12 (53 package gồm cả các facade `@nestjs/*` mỏng, sau đó tinh gọn còn 35/37 trước `ADR-016`) | Đã hợp nhất theo `ADR-016` thành **19 package theo lĩnh vực** với ESM subpath có thể tree-shake (`@bunest/core/*`, `@bunest/security/*`, `@bunest/messaging/*`, `@bunest/jobs/*`, `@bunest/resilience/*`, `@bunest/orm/*`, `@bunest/ai/*`) |
| **Nội bộ `v0.8`** | Không (mốc nội bộ) | AOP tầng service (`ADR-014`), declarative repository `@bunest/orm`, validation không dependency ngoài (`ADR-015`) và 19/19 package 0 external runtime dep (`ADR-017`) | Phát hành làm nền tảng của **`0.1.0 Production Preview`** |

---

## 6. Chính sách Trung thực Benchmark

Bunest không bao giờ công bố các tuyên bố tiếp thị kiểu _"nhanh hơn X lần"_ thiếu kiểm chứng. Mọi benchmark được công bố cho Bunest đều phải minh bạch:

1. Phiên bản Bun chính xác, hệ điều hành, CPU, RAM và phiên bản các package.
2. Số lượng route, kích thước payload, mức độ đồng thời (concurrency), keep-alive, thời gian khởi động (warmup) và thời lượng đo.
3. Cấu hình middleware/validation/logging tương đương giữa các framework.
4. Thông lượng (req/s), độ trễ `p50`/`p95`/`p99`, CPU, bộ nhớ/RSS và tỷ lệ lỗi—kèm script có thể tái lập được commit trong kho mã nguồn.
