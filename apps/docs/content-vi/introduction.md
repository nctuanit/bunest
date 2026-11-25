# Giới thiệu

**Bunest** là một framework TypeScript theo hướng tiến bộ (progressive) giúp xây dựng các ứng dụng server-side nhanh, có tính module hóa cao và dễ bảo trì trực tiếp trên **Bun**.

@@component(hero-cards)

## Triết lý thiết kế

Trong hệ sinh thái Bun, lập trình viên thường phải đánh đổi: `Bun.serve()` thuần và các router gọn nhẹ mang lại tốc độ vượt trội, trong khi các ứng dụng doanh nghiệp lại cần một kiến trúc có sẵn cho dependency injection, đóng gói module, validate DTO, guard, interceptor, xử lý lỗi tập trung, lưu trữ dữ liệu, bảo mật, messaging, AI và observability.

**Bunest kết nối cả hai thế giới đó.** Framework mang **mô hình kiến trúc NestJS v12** đã được kiểm chứng—`@Module()`, `@Controller()`, `@Injectable()`, parameter decorator, guard, pipe, interceptor, exception filter cùng hệ sinh thái tinh gọn gồm **19 package thuộc 6 lĩnh vực**—lên trực tiếp runtime gốc của Bun mà không cần Express, Fastify, các lớp tương thích Node HTTP hay phụ thuộc bắt buộc vào RxJS.

> info **Cam kết kiến trúc** Bunest **chỉ hỗ trợ Bun** (`Bun >= 1.4.5`, [ADR-001 & ADR-016](/architecture/adrs)). Các package lõi hoạt động trực tiếp trên Web Standards (`Request`, `Response`, `Headers`, `ReadableStream`, `Blob`, WebCrypto) và các API gốc của Bun (`Bun.serve`, `Bun.file`, `Bun.S3Client`, `Bun.RedisClient`, `Bun.password`, `Bun.CryptoHasher`, `Bun.Cookie`, `Bun.CSRF`, `bun:sqlite`, `Bun.SQL`, `bun:test`, `Bun.build`).

## Trải nghiệm nhanh

Nếu bạn từng làm việc với NestJS, Bunest sẽ mang lại cảm giác quen thuộc ngay lập tức—nhưng mọi route chỉ được biên dịch một lần khi khởi động (bootstrap) thành các closure `Bun.serve({ routes })` gốc với **zero reflection trên mỗi request**:

@@filename(users.controller.ts)

```ts
import { Body, Controller, Get, Param, Post, Query } from "@bunest/core";
import { CreateUserDto } from "./create-user.dto";
import { UsersService } from "./users.service";

@Controller("/users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.users.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateUserDto, @Query("notify") notify?: string) {
    return this.users.create(dto, notify === "true");
  }
}
```

Và với **Service-Layer AOP & Declarative Repositories** ([ADR-014](/architecture/adrs)), các tác vụ cross-cutting trên các service `@Injectable()` hoàn toàn không cần boilerplate:

@@filename(billing.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { Cacheable, CacheEvict } from "@bunest/cache";
import { EmitEvent } from "@bunest/messaging/events";
import { Retry } from "@bunest/resilience";
import { WithLock } from "@bunest/resilience/locks";
import { Span, Timed } from "@bunest/observability";
import { Transactional } from "@bunest/orm";

@Injectable()
export class BillingService {
  constructor(private readonly users: UserRepository) {}

  @Span("users.lookup")
  @Cacheable({ key: (email: string) => `user:${email}`, ttl: 60_000 })
  findByEmail(email: string) {
    return this.users.findByEmail(email);
  }

  @Timed("users.provision")
  @WithLock((email: string) => `provision:${email}`, { ttl: 5_000 })
  @Transactional()
  @CacheEvict({ key: (email: string) => `user:${email}` })
  @EmitEvent("user.provisioned", { async: true })
  @Retry({ maxAttempts: 3 })
  async provision(email: string, role: string) {
    return this.users.save({ email, role, active: true });
  }
}
```

## Các nguyên tắc thiết kế cốt lõi

1. **Runtime gốc của Bun** — Không dùng adapter `express`, `fastify` hay `node:http` trong lõi. Hỗ trợ sẵn zero-copy `Bun.file()`, trả thẳng Web `Response` và Zig routing qua `Bun.serve({ routes })`.
2. **Legacy TypeScript decorators** — Sử dụng `experimentalDecorators: true` và `emitDecoratorMetadata: true` để constructor DI, parameter decorator và DTO của `@bunest/validation` (cùng `class-validator` + `class-transformer`) hoạt động mượt mà mà không cần AST plugin tùy chỉnh.
3. **Biên dịch một lần lúc bootstrap** — Quét module, kiểm tra đồ thị DI, phát hiện trùng route, phát hiện rò rỉ scope, biên dịch SQL cho declarative repository và biên dịch execution plan đều chạy **một lần duy nhất lúc khởi động**. Hot path không gọi bất kỳ `Reflect.getMetadata()` nào.
4. **Đảm bảo fail-fast chặt chẽ** — Route trùng lặp (kể cả khi chỉ đổi tên param như `/users/:id` và `/users/:userId`), thiếu provider, export mơ hồ, dependency vòng tròn và rò rỉ scope từ singleton sang request đều báo lỗi ngay lập tức trước khi `Bun.serve()` mở port.
5. **Mặc định an toàn (Secure defaults)** — `ValidationPipe` mặc định bật `whitelist: true`, `forbidNonWhitelisted: true`, `forbidUnknownValues: true`, chặn prototype pollution, bảo vệ CSRF theo Fetch-Metadata, header Helmet-8, WebCrypto JWT/JWKS và cấu trúc JSON lỗi chuẩn hóa không bao giờ làm lộ stack trace ở môi trường production.
6. **Hệ sinh thái tinh gọn 19 package, 6 lĩnh vực, 100% không phụ thuộc ngoài** — Từ lõi HTTP/DI/Config/WS/I18n (tích hợp sẵn Reflect metadata shim) và validation gốc không dependency đến `@bunest/orm` thống nhất trên Bun (12 dialect + SQL Store Kit), engine GraphQL Oct 2021 / Apollo không dependency, CLI phân tích TS AST gốc, Microservices, Messaging (Events/CQRS/Outbox/Webhooks), Jobs (Queues/Scheduler), Workflows, Resilience/Locks/Idempotency, Security/Auth/Authz, AI/MCP và Observability—với **19/19 package (100%) có 0 runtime dependency ngoài từ npm** và **0 import `node:*` trên toàn repo** ngoài 2 kernel adapter được cô lập trong `@bunest/core` ([ADR-017](/architecture/adrs)).

## Yêu cầu trước khi bắt đầu

- Đã cài đặt **Bun** `>= 1.4.5` trên máy
- **TypeScript** bật chế độ legacy decorator (`experimentalDecorators` + `emitDecoratorMetadata`)

Sẵn sàng xây dựng ứng dụng Bunest đầu tiên? Hãy chuyển thẳng tới [Các bước đầu tiên](/overview/first-steps) hoặc khám phá toàn bộ 19 package tại [Packages & Monorepo](/ecosystem/packages).
