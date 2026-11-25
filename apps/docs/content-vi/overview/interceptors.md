# Interceptors

Interceptor là một class triển khai `BunestInterceptor` nhằm bọc quá trình thực thi route theo **mô hình củ hành (onion model)**. Interceptor cho phép bạn:

- Gắn thêm logic **trước** và **sau** khi thực thi method (ghi log, đo độ trễ, tracing).
- Biến đổi giá trị trả về từ handler (bọc dữ liệu theo envelope, serialize class).
- Ngắt mạch (short-circuit) quá trình thực thi mà không cần gọi handler (cache response).
- Bắt và ánh xạ lại các ngoại lệ phát sinh trong quá trình trích xuất tham số, chạy pipe hoặc gọi handler.

## Mô hình Onion với Promise gốc (Không RxJS)

Khác với NestJS trên Node.js, lõi Bunest **không yêu cầu RxJS**. Thay vào đó, `CallHandler.handle()` trả về một `Promise<T>` gốc chuẩn:

```ts
export interface CallHandler<T = unknown> {
  handle(): Promise<T>;
}

export interface BunestInterceptor<T = unknown, R = unknown> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Promise<R> | R;
}
```

> tip **Tại sao dùng Promise thay vì RxJS?** Sử dụng `async/await` gốc loại bỏ dung lượng bundle của `rxjs`, tránh rò rỉ observable subscription, tận dụng tối đa hiệu năng bất đồng bộ của Bun và giúp mã nguồn interceptor dễ đọc ngay với mọi lập trình viên TypeScript.

## Interceptor đo thời gian & ghi log

@@filename(logging.interceptor.ts)

```ts
import {
  Injectable,
  Logger,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core";

@Injectable()
export class LoggingInterceptor implements BunestInterceptor {
  private readonly logger = new Logger("Interceptor");

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const start = performance.now();
    const handlerName = `${context.getClass().name}.${context.getHandler().name}`;

    const result = await next.handle();

    const duration = (performance.now() - start).toFixed(2);
    this.logger.log(`${handlerName} completed in ${duration}ms`);
    return result;
  }
}
```

## Interceptor biến đổi Response

Bọc các JSON payload thông thường vào một envelope `{ data }` đồng nhất trong khi vẫn giữ nguyên Web `Response` gốc, stream và file:

@@filename(transform.interceptor.ts)

```ts
import {
  Injectable,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core";

@Injectable()
export class TransformInterceptor<T> implements BunestInterceptor<T, unknown> {
  async intercept(_context: ExecutionContext, next: CallHandler<T>) {
    const data = await next.handle();
    if (
      data instanceof Response ||
      data instanceof ReadableStream ||
      data instanceof Blob
    ) {
      return data;
    }
    return { data };
  }
}
```

## Ngắt mạch (Cache Interceptor)

Bỏ qua không gọi `next.handle()` sẽ bỏ qua hoàn toàn bước trích xuất tham số, pipe và route handler:

@@filename(cache.interceptor.ts)

```ts
import {
  Injectable,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core";

@Injectable()
export class SimpleCacheInterceptor implements BunestInterceptor {
  private readonly cache = new Map<string, unknown>();

  async intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest();
    if (req.method !== "GET") {
      return next.handle();
    }

    const key = new URL(req.url).pathname;
    if (this.cache.has(key)) {
      return this.cache.get(key); // Short-circuit!
    }

    const value = await next.handle();
    this.cache.set(key, value);
    return value;
  }
}
```

## Gắn Interceptor & Thứ tự thực thi Onion

Gắn interceptor qua `@UseInterceptors(...)` trên controller/method hoặc trên toàn cục qua `APP_INTERCEPTOR`:

@@filename(cats.controller.ts)

```ts
import { Controller, Get, UseInterceptors } from "@bunest/core";
import { LoggingInterceptor } from "./logging.interceptor";
import { TransformInterceptor } from "./transform.interceptor";

@UseInterceptors(LoggingInterceptor, TransformInterceptor)
@Controller("cats")
export class CatsController {
  @Get()
  findAll() {
    return [{ id: "1", name: "Milo" }];
  }
}
```

Interceptor thực thi theo **thứ tự củ hành (onion order)** nghiêm ngặt:

```text
Entry (before): Global -> Controller -> Method
  └─ Inner call: Stage 7 (Param Extract) -> Stage 8 (Pipes) -> Stage 9 (Handler)
Exit  (after):  Method -> Controller -> Global
```

Bạn cần loại bỏ các trường nhạy cảm như `passwordHash` khỏi response? Hãy xem [`ClassSerializerInterceptor`](/techniques/serialization).
