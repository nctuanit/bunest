# Chuyển đổi từ NestJS

Bunest chủ ý giữ nguyên mô hình tư duy của NestJS—`@Module`, `@Controller`, `@Get/@Post`, `@Body/@Param/@Query`, `@Injectable`, Guards, Pipes, Interceptors, Exception Filters và `ValidationPipe`—trong khi loại bỏ hoàn toàn gánh nặng của Node.js, Express/Fastify và RxJS bắt buộc.

## So sánh đối chiếu

| Khía cạnh | NestJS (Node.js) | Bunest (Bun Native) |
| --- | --- | --- |
| **Runtime** | Node.js (+ adapter Express / Fastify) | **Chỉ Bun** (`>= 1.4.5`, `Bun.serve()` gốc) |
| **Đối tượng HTTP** | Express `req`/`res` hoặc Fastify `request`/`reply` | **`Request`** & **`Response`** Web chuẩn gốc + `ResponseContext` |
| **Interceptors** | RxJS `Observable<T>` (`next.handle().pipe(...)`) | **`Promise<T>` gốc** (`await next.handle()`) — không dùng RxJS |
| **SSE (`@Sse`)** | RxJS `Observable<MessageEvent>` | **`AsyncIterable<SseMessageEvent>`** / `AsyncGenerator` gốc |
| **Streaming tệp** | `StreamableFile` + `fs.createReadStream()` | Trả về trực tiếp **`Bun.file(path)`** (zero-copy `sendfile`) |
| **DI `Scope.REQUEST`** | Tự lan truyền phạm vi âm thầm lên cây phụ thuộc | **Báo lỗi sớm `ScopeLeakException`** lúc khởi động (chọn tham gia tường minh) |
| **Mặc định `ValidationPipe`** | `whitelist: false`, `forbidNonWhitelisted: false` | **`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`** + chống prototype-pollution |
| **Định dạng lỗi** | Thay đổi theo adapter / thông báo thô của `class-validator` | Thống nhất `{ statusCode, error, message, details, timestamp, path }` |
| **Import TypeScript** | Thường dựa vào `emitDecoratorMetadata` không bật `verbatimModuleSyntax` | **`verbatimModuleSyntax: true`** (value-import cho class, `import type` cho interface) |
| **Kiểm thử & E2E** | `@nestjs/testing` + Jest + Supertest | **`@bunest/testing`** + **`bun:test`** gốc + **`request(app)`** không mở socket / `TestClient` / `app.inject()` / `app.listen(0)` |

## Chuyển đổi các mẫu phổ biến

### 1. Imports & Factory

@@filename(main.ts)
@@tab(Bunest)

```ts
import { BunestFactory } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
app.useGlobalPipes(new ValidationPipe());
await app.listen(3000);
```

@@switch
@@tab(NestJS)

```ts
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";

const app = await NestFactory.create(AppModule);
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
);
await app.listen(3000);
```

### 2. Interceptors (RxJS &rarr; `async/await`)

@@filename(timing.interceptor.ts)
@@tab(Bunest (Native Promise))

```ts
import {
  Injectable,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core";

@Injectable()
export class TimingInterceptor implements BunestInterceptor {
  async intercept(_ctx: ExecutionContext, next: CallHandler) {
    const start = performance.now();
    const data = await next.handle();
    return { data, tookMs: +(performance.now() - start).toFixed(2) };
  }
}
```

@@switch
@@tab(NestJS (RxJS))

```ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from "@nestjs/common";
import { map } from "rxjs/operators";

@Injectable()
export class TimingInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler) {
    const start = performance.now();
    return next.handle().pipe(
      map((data) => ({
        data,
        tookMs: +(performance.now() - start).toFixed(2),
      })),
    );
  }
}
```

### 3. Xử lý phản hồi với `@Res()`

Trong NestJS chạy trên Express, inject `@Res()` đưa route vào chế độ thủ công đặc thù của thư viện (`res.status(200).json(...)`). Trong Bunest, `@Res()` inject một builder **`ResponseContext`** gọn nhẹ (giống `@Res({ passthrough: true })` của NestJS), vì vậy bạn thay đổi trạng thái/header/cookie và vẫn **return** giá trị bình thường—hoặc trả về trực tiếp `new Response(...)` để toàn quyền kiểm soát.

### 4. Kiểm thử & E2E (`@nestjs/testing` + Supertest &rarr; `@bunest/testing` + `bun:test`)

`@nestjs/testing` chính thức gắn chặt với `NestContainer` nội bộ của `@nestjs/core`, Node `http.Server` và RxJS. Hãy đổi import sang **`@bunest/testing`** để giữ nguyên quy trình `Test.createTestingModule()`, `overrideProvider`/`Guard`/`Pipe`/`Interceptor`/`Filter`/`Module`, `useMocker`, `ContextIdFactory` và `createNestApplication()`—kèm `request(app)` kiểu Supertest không cần socket tích hợp sẵn (hoặc `createNodeHttpServer(app)` nếu bạn vẫn muốn dùng npm `supertest`):

@@filename(users.e2e.spec.ts)
@@tab(Bunest (@bunest/testing + bun:test))

```ts
import { describe, it } from "bun:test";
import { ValidationPipe } from "@bunest/core";
import { Test, createAutoMocker, request } from "@bunest/testing";
import { UsersModule } from "../src/users/users.module";

describe("Users (E2E)", () => {
  it("GET /users", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UsersModule],
    })
      .useMocker(createAutoMocker())
      .compile();

    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();

    await request(app)
      .get("/users")
      .expect(200)
      .expect([{ id: "1" }]);
    await app.close();
  });
});
```

@@switch
@@tab(NestJS (@nestjs/testing + Jest + Supertest))

```ts
import { Test } from "@nestjs/testing";
import { ValidationPipe } from "@nestjs/common";
import * as request from "supertest";
import { UsersModule } from "../src/users/users.module";

describe("Users (E2E)", () => {
  it("GET /users", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UsersModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();

    await request(app.getHttpServer())
      .get("/users")
      .expect(200)
      .expect([{ id: "1" }]);
    await app.close();
  });
});
```

Xem đầy đủ [Hướng dẫn Kiểm thử & E2E](/fundamentals/testing) về auto-mocking, `request.agent(app)` có trạng thái, `TestClient`, `app.inject()`, kiểm thử SSE (`readSseEvents`) và `createNodeHttpServer(app)`.

## Danh sách kiểm tra chuyển đổi

- [x] Cập nhật import từ `@nestjs/common` & `@nestjs/core` sang `@bunest/core` (và `@bunest/validation` cho `ValidationPipe` / `ClassSerializerInterceptor`).
- [x] Cập nhật import kiểm thử từ `@nestjs/testing` & `supertest` sang `@bunest/testing` (`Test`, `request`, `TestClient`, `createAutoMocker`, `CapturingLogger`) chạy trên `bun:test`, và đổi tên các tệp E2E từ `*.e2e-spec.ts` sang `*.e2e.spec.ts` để `bun test` tự động phát hiện.
- [x] Loại bỏ mã thừa `reflect-metadata` (tùy chọn): `@bunest/core` tự động cài đặt shim Reflect Metadata không phụ thuộc ngoài tích hợp sẵn ([ADR-017](/architecture/adrs)); tùy chọn chuyển đổi các DTO decorator từ `class-validator`/`class-transformer` sang `@bunest/validation/validator` và `@bunest/validation/transformer` ([ADR-015](/architecture/adrs)).
- [x] Bật `verbatimModuleSyntax: true` trong `tsconfig.json`; dùng `import type` cho interface và value import cho các DI service & class DTO.
- [x] Thay các interceptor dùng `.pipe(map(...))` của RxJS bằng `async/await next.handle()`.
- [x] Thay các lời gọi `res.status().send()` của Express bằng `ResponseContext` hoặc `new Response(...)` gốc.
- [x] Kiểm tra mọi provider dùng `Scope.REQUEST`—gắn chú thích tường minh cho các consumer trung gian để đáp ứng cổng kiểm tra `ScopeLeakException` báo lỗi sớm của Bunest.
