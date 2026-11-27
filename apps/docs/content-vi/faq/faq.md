# Câu hỏi thường gặp (FAQ)

Giải đáp thực tế cho các câu hỏi phổ biến về kiến trúc và vận hành khi xây dựng ứng dụng với Bunest.

## Làm sao lấy raw request body (ví dụ để xác thực chữ ký webhook Stripe/GitHub)?

Dùng trực tiếp parameter decorator `@RawBody()` trên handler của controller — không cần middleware body-parser phụ trợ:

@@filename(webhooks.controller.ts)

```ts
import { Controller, Headers, Post, RawBody } from "@bunest/core";

@Controller("webhooks")
export class WebhooksController {
  @Post("stripe")
  handleStripe(
    @RawBody() rawBody: Uint8Array,
    @Headers("stripe-signature") signature: string,
  ) {
    // Xác thực HMAC trực tiếp trên rawBody bytes
    return { bytes: rawBody.byteLength, hasSig: Boolean(signature) };
  }
}
```

> tip Nếu muốn xác thực chữ ký HMAC tự động (Standard Webhooks, Stripe, GitHub, tùy chỉnh), hãy dùng `@IncomingWebhook()` và `@WebhookPayload()` từ [`@bunest/messaging/webhooks`](/distributed/outbox-webhooks).

## Làm sao đặt global route prefix (và loại trừ một số route)?

Gọi `app.setGlobalPrefix("api")` trước `app.listen()`, kèm danh sách `exclude` cho các endpoint health hoặc metrics:

@@filename(main.ts)

```ts
app.setGlobalPrefix("api", {
  exclude: ["health/live", "health/ready", "metrics"],
});
```

## Có thể chạy HTTP, WebSockets và Microservices trong cùng một tiến trình (Hybrid App) không?

Có. Khởi tạo HTTP app chuẩn bằng `BunestFactory.create(AppModule)`, gắn thêm các microservice bằng `app.connectMicroservice(...)` rồi khởi chạy đồng thời:

@@filename(main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { MicroserviceHost } from "@bunest/microservices";
import { AppModule } from "./app.module";

// AppModule imports MicroserviceModule.forRoot({ transport: Transport.TCP, options: { port: 4001 } }).
const app = await BunestFactory.create(AppModule);
app.connectMicroservice(app.get(MicroserviceHost));

await app.startAllMicroservices();
await app.listen(3000);
```

Xem thêm tại [Microservices](/distributed/microservices) và [WebSockets](/apis/websockets).

## Thứ tự thực thi chính xác của một HTTP request là gì?

Mỗi HTTP request đi qua pipeline 11 giai đoạn đã biên dịch sẵn của Bunest:

1. **Route Match** (`Bun.serve` Zig router / fallback radix router)
2. **RequestContext Init** (+ `AsyncLocalStorage` nếu có `Scope.REQUEST`)
3. **Security & CORS** (preflight, `bodyLimit`, trust-proxy IP)
4. **Middleware** (Global → Module → Controller → Method)
5. **Guards** (Global → Controller → Method) — *chạy trước bước parse body!*
6. **Interceptors (Before)** (Global → Controller → Method)
7. **Parameter Extraction** (`@Param`, `@Query`, `@Body`, custom decorators)
8. **Pipes & Validation** (Global → Controller → Method → Parameter)
9. **Controller Handler**
10. **Interceptors (After)** (Method → Controller → Global)
11. **Response Serialization** (status, headers, cookies, streams, JSON)
- **Exception Filters** bao bọc toàn bộ giai đoạn 3–11 (Method → Controller → Global → Default).

Khám phá sơ đồ tương tác trực quan tại [Execution pipeline](/architecture/execution-pipeline).

## Vì sao constructor injection bị lỗi khi dùng `import type`?

Vì TypeScript xóa hoàn toàn `import type` lúc biên dịch nên `emitDecoratorMetadata` không thể ghi token constructor vào `design:paramtypes`. Luôn dùng **value-import** cho các DI class, DTO và entity:

```ts
// Đúng — sinh đầy đủ constructor metadata lúc runtime
import { UsersService } from "./users.service";

// Sai — bị xóa lúc runtime, gây lỗi BUNEST_E001
import type { UsersService } from "./users.service";
```

## Làm sao kết nối nhiều database cùng lúc?

Đăng ký nhiều `OrmModule.forRoot({ name: "analytics", ... })` với tên riêng rồi inject bằng `@InjectDataSource(name)` hoặc `@InjectRepository(Entity, name)`:

```ts
@Injectable()
export class ReportsService {
  constructor(
    @InjectDataSource("analytics") private readonly analyticsDb: DataSource,
  ) {}
}
```

## Vì sao Bunest không dùng RxJS trong Interceptors?

Bunest nhắm trực tiếp vào runtime Promise thuần của Bun và giữ nguyên tắc 0 external dependencies. Interceptor triển khai `intercept(ctx, next)` trong đó `next.handle()` trả về `Promise<T>` chuẩn, giúp viết `async/await` gọn gàng hơn và tránh chi phí cấp phát Observable. Xem thêm [Interceptors](/overview/interceptors) và [Chuyển từ NestJS](/architecture/migration-from-nestjs).
