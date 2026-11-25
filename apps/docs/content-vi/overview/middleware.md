# Middleware

Middleware thực thi ở **Giai đoạn 4 (Stage 4)** của [Execution Pipeline 11 giai đoạn](/architecture/execution-pipeline)—sau bước tiền xử lý CORS/bảo mật và **trước** guard, interceptor, trích xuất tham số và route handler.

Khác với Express middleware, middleware của Bunest hoạt động trực tiếp trên Web `Request` và `ResponseContext` của Bunest—hoàn toàn không dùng lớp tương thích Node HTTP.

## Middleware dạng Class (`BunestMiddleware`)

Triển khai interface `BunestMiddleware` trên một class `@Injectable()` khi middleware của bạn cần constructor DI:

@@filename(logger.middleware.ts)

```ts
import {
  Injectable,
  Logger,
  type BunestMiddleware,
  type NextFunction,
  type ResponseContext,
} from "@bunest/core";

@Injectable()
export class RequestLoggerMiddleware implements BunestMiddleware {
  private readonly logger = new Logger("HTTP");

  async use(req: Request, res: ResponseContext, next: NextFunction) {
    const start = performance.now();
    const requestId = crypto.randomUUID();
    res.header("X-Request-Id", requestId);

    const result = await next();
    const ms = (performance.now() - start).toFixed(2);
    this.logger.log(`${req.method} ${new URL(req.url).pathname} (${ms}ms)`);
    return result;
  }
}
```

## Functional Middleware

Khi không cần DI dependency nào, hãy dùng `MiddlewareFunction` gọn nhẹ:

@@filename(timing.middleware.ts)

```ts
import type { MiddlewareFunction } from "@bunest/core";

export const poweredByMiddleware: MiddlewareFunction = async (
  _req,
  res,
  next,
) => {
  res.header("X-Runtime", "Bun");
  return next();
};
```

## Áp dụng Middleware trong Modules

Các module cần gắn middleware sẽ triển khai `BunestModule` và phương thức `configure(consumer: MiddlewareConsumer)` của nó:

@@filename(app.module.ts)

```ts
import {
  Module,
  RequestMethod,
  type BunestModule,
  type MiddlewareConsumer,
} from "@bunest/core";
import { RequestLoggerMiddleware } from "./middleware/logger.middleware";
import { poweredByMiddleware } from "./middleware/timing.middleware";
import { UsersController } from "./users/users.controller";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [UsersModule],
})
export class AppModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestLoggerMiddleware, poweredByMiddleware)
      .exclude({ path: "users/health", method: RequestMethod.GET })
      .forRoutes(UsersController);
  }
}
```

`forRoutes()` chấp nhận chuỗi route (`"users"`, `"users/*"`), các object `RouteInfo` (`{ path: "users", method: RequestMethod.POST }`) hoặc các controller class (`UsersController`).

## Global Middleware

Đăng ký middleware áp dụng cho mọi route trên toàn cục qua `app.use(...)`:

@@filename(main.ts)

```ts
const app = await BunestFactory.create(AppModule);
app.use(poweredByMiddleware);
await app.listen(3000);
```

## Ngắt mạch (Short-Circuiting) & Gắn trước lúc Bootstrap

- **Ngắt mạch (Short-circuiting):** Trả về một `new Response(...)` gốc từ middleware sẽ lập tức dừng các giai đoạn phía sau (bỏ qua guard, interceptor, pipe và handler) trong khi vẫn áp dụng các CORS header đã cấu hình.
- **Xử lý ngoại lệ:** Ném một `HttpException` bên trong middleware sẽ chuyển thẳng tới Exception Filters.
- **Không so khớp đường dẫn lúc chạy:** Vì các route gốc của Bun bỏ qua `fetch()`, Bunest phân giải trước chuỗi middleware khớp với từng route **ngay lúc bootstrap** và gắn trực tiếp vào closure route đã biên dịch.
