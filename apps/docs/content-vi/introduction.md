# Viết REST API bằng TypeScript trên Bun

**Bunest** mang đến cho các nhóm phát triển backend TypeScript bộ định tuyến `@Controller()`, dependency injection qua constructor chặt chẽ và validation DTO an toàn mặc định theo phong cách NestJS ngay trên **Bun** (`>= 1.4.5`)—không cần Express, Fastify hay RxJS.

**[Chạy API đầu tiên ->](/overview/first-steps)**

Đoạn mã dưới đây là **trích đoạn controller** từ `examples/hello-world/src/app.module.ts`, sử dụng đúng endpoint `/health` mà bạn sẽ khởi chạy và kiểm chứng trong [Các bước đầu tiên](/overview/first-steps):

@@filename(examples/hello-world/src/app.module.ts)

```ts
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(@Query("name") name?: string) {
    return this.appService.getGreeting(name);
  }

  @Get("/health")
  getHealth() {
    return { status: "ok" };
  }
}
```

```bash
curl http://localhost:3000/health
```

```json
{"status":"ok"}
```

## Chọn lộ trình đọc tiếp theo

- **[Đến từ NestJS](/architecture/migration-from-nestjs)** — Xem những phần tương đồng 1:1 (`@Module()`, `@Controller()`, `@Injectable()`, guard, pipe, filter) và những điểm thay đổi trên Bun (`Bun.serve()` gốc, interceptor thuần Promise thay cho RxJS và hệ sinh thái `@bunest/*` tinh gọn).
- **[Cách request đi qua framework](/architecture/execution-pipeline)** — Tìm hiểu pipeline thực thi HTTP 11 bước được biên dịch một lần lúc khởi động thành các closure gốc của `Bun.serve({ routes })` với zero reflection trên mỗi request.

## Tổng quan nhanh

@@component(hero-cards)

## Pipeline & Kiến trúc

- **[Pipeline thực thi 11 bước](/architecture/execution-pipeline)** — Vòng đời request chuẩn từ khớp route qua middleware, guard, interceptor onion thuần Promise, trích xuất tham số, validation pipe, thực thi handler, chuẩn hóa response và exception filter.
- **[Hybrid Bun.serve Router](/architecture/hybrid-router)** — Cách controller biên dịch thành Zig closure gốc của `Bun.serve({ routes })` kết hợp radix router dự phòng có kiểm soát cùng cơ chế phát hiện trùng route fail-fast.
- **[Chuẩn hóa Response](/architecture/response-serialization)** — Trả thẳng Web `Response` gốc, `Bun.file()` zero-copy, SSE stream và tuân thủ RFC 9110 cho body rỗng.
- **[Validation an toàn mặc định](/techniques/validation)** — `ValidationPipe` mặc định bật `whitelist: true`, `forbidNonWhitelisted: true`, chặn prototype pollution và hỗ trợ Standard Schema.

## Bản ghi Quyết định Kiến trúc (ADRs)

> info **Cam kết kiến trúc** Bunest **chỉ hỗ trợ Bun** (`Bun >= 1.4.5`, [ADR-001 đến ADR-018](/architecture/adrs)). Các package lõi vận hành trực tiếp trên Web Standards (`Request`, `Response`, `Headers`, `ReadableStream`, WebCrypto) và API gốc của Bun (`Bun.serve`, `Bun.SQL`, `bun:sqlite`, `Bun.file`, `Bun.password`, `bun:test`) với **0 runtime dependency bên ngoài** trên toàn bộ 19 package (`ADR-017`).

Xem toàn bộ [Chỉ mục ADR & RFC](/architecture/adrs) để tra cứu các hợp đồng thiết kế bắt buộc cho legacy decorator (`ADR-002`), định tuyến biên dịch lúc bootstrap (`ADR-011`), chặn rò rỉ scope nghiêm ngặt (`ADR-012`), AOP tầng Service (`ADR-014`) và hợp nhất 6 lĩnh vực package (`ADR-016`).

## Benchmark

Bunest không công bố các tuyên bố tiếp thị kiểu _"nhanh hơn X lần"_ thiếu kiểm chứng. Mọi kết quả đều tuân thủ bộ benchmark đối đầu 8 mục tiêu có thể tái lập (công khai rõ phiên bản Bun, OS, phần cứng, mức đồng thời, độ trễ `p50`/`p95`/`p99`, RSS và tỷ lệ lỗi) được ghi rõ trong [Chính sách Trung thực Benchmark](/ecosystem/roadmap).

## Chính sách Hỗ trợ & Hệ sinh thái

- **Phiên bản hiện tại:** **`0.1.0` Production Preview** đồng bộ phiên bản trên toàn bộ **19 package `@bunest/*`** cho **Bun `>= 1.4.5`**.
- **Phạm vi Production Preview:** REST API trên Linux + Bun `1.4.5` với `@bunest/core`, `@bunest/validation`, `@bunest/orm` (PostgreSQL qua `Bun.SQL`, migration tường minh) và `@bunest/observability`.
- **Khám phá thêm:** Đọc [Lộ trình Triển khai & Phạm vi Hỗ trợ](/ecosystem/roadmap), duyệt đủ 19 package tại [Packages & Monorepo](/ecosystem/packages), hoặc xem hướng dẫn vận hành tại [Triển khai & Production](/recipes/deployment).
