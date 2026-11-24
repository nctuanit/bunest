# Interceptors

An interceptor is a class implementing `BunestInterceptor` that wraps route execution using an **onion model**. Interceptors let you:

- Bind extra logic **before** and **after** method execution (logging, latency metrics, tracing).
- Transform the return value produced by a handler (envelope wrapping, class serialization).
- Short-circuit execution without invoking the handler (response caching).
- Catch and remap exceptions thrown during parameter extraction, pipes, or handler invocation.

## Native Promise Onion Model (Zero RxJS)

Unlike NestJS on Node.js, Bunest core **does not require RxJS** ([ADR-008](/architecture/execution-pipeline)). Instead, `CallHandler.handle()` returns a standard native `Promise<T>`:

```ts
export interface CallHandler<T = unknown> {
  handle(): Promise<T>;
}

export interface BunestInterceptor<T = unknown, R = unknown> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Promise<R> | R;
}
```

> tip **Why Promises Instead of RxJS?** Using native `async/await` eliminates `rxjs` bundle overhead, avoids observable subscription leaks, integrates cleanly with Bun's async performance, and makes interceptor code immediately readable to every TypeScript developer.

## Timing & Logging Interceptor

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

## Response Mapping Interceptor

Wrap plain JSON payloads into a consistent `{ data }` envelope while leaving native Web `Response`, streams, and files untouched:

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

## Short-Circuiting (Cache Interceptor)

Skipping `next.handle()` bypasses parameter extraction, pipes, and the route handler completely:

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

## Binding & Onion Execution Order

Bind interceptors via `@UseInterceptors(...)` on controllers/methods or globally via `APP_INTERCEPTOR`:

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

Interceptors execute in strict **onion order**:

```text
Entry (before): Global -> Controller -> Method
  └─ Inner call: Stage 7 (Param Extract) -> Stage 8 (Pipes) -> Stage 9 (Handler)
Exit  (after):  Method -> Controller -> Global
```

Looking to exclude sensitive fields like `passwordHash` from responses? See [`ClassSerializerInterceptor`](/techniques/serialization).
