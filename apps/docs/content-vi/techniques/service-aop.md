# AOP ở tầng Service

Được giới thiệu trong **[ADR-014](/architecture/adrs)**, **Service-Layer Method Aspect Weaver** của Bunest mang lại lập trình hướng khía cạnh (AOP) không chi phí phụ trợ cho các service `@Injectable()` trên mọi phạm vi DI (`SINGLETON`, `TRANSIENT`, `REQUEST` và `useFactory`).

## Tại sao dùng AOP ở tầng Service?

Các enhancer truyền thống của NestJS (`@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters`) chỉ thực thi tại các điểm vào của tầng giao vận (HTTP, GraphQL, WebSockets, Microservices). AOP ở tầng service cho phép bạn áp dụng các mối quan tâm cắt ngang (cross-cutting concerns) trực tiếp lên các phương thức service:

- `@Transactional()` (`@bunest/orm`)
- `@Cacheable()` / `@CacheEvict()` / `@CachePut()` (`@bunest/cache`)
- `@Span()` / `@Trace()` / `@Timed()` / `@Counted()` (`@bunest/observability`)
- `@EmitEvent()` (`@bunest/messaging/events`)
- `@WithLock()` (`@bunest/resilience/locks`)
- `@WithCls()` (`@bunest/core`)
- `@Retry()` / `@Timeout()` / `@CircuitBreaker()` / `@Bulkhead()` / `@Fallback()` (`@bunest/resilience`)
- `@UseMiddleware()` & `@InheritMethodEnhancers()` (`@bunest/core`, `@bunest/core/http`)

> info **Không phát sinh chi phí phụ trợ trên các class không gắn decorator** `DIContainer` lưu bộ nhớ đệm trạng thái tồn tại của aspect trong một `WeakMap<Function, boolean>` với độ phức tạp O(1). Các service thuần túy không có method aspect sẽ không bao giờ bị proxy hay bọc lại, và các aspect đồng bộ bọc phương thức đồng bộ sẽ trả về giá trị trực tiếp mà không bọc vào `Promise`.

## Thứ tự xếp chồng

Các decorator xếp chồng trên cùng một phương thức thực thi **từ ngoài vào trong theo đúng thứ tự khai báo từ trên xuống dưới** (cấp class trước cấp phương thức, lớp cơ sở trước lớp dẫn xuất, được sắp xếp ổn định theo `order ?? 0` tăng dần):

@@filename(orders.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { CacheEvict } from "@bunest/cache";
import { EmitEvent } from "@bunest/messaging/events";
import { WithLock } from "@bunest/resilience/locks";
import { Span, Timed } from "@bunest/observability";
import { Retry } from "@bunest/resilience";
import { Transactional } from "@bunest/orm";

@Injectable()
export class OrdersService {
  @Span("orders.place")
  @Timed("orders.place")
  @WithLock((orderId: string) => `order:${orderId}`, { ttl: 5_000 })
  @Transactional()
  @CacheEvict({ key: (orderId: string) => `order:${orderId}` })
  @EmitEvent("order.placed", { async: true })
  @Retry({ maxAttempts: 3 })
  async placeOrder(orderId: string) {
    // Pure business logic — no imperative wrappers!
    return { orderId, status: "placed" };
  }
}
```

## Viết Method Aspect tùy chỉnh

Tạo các service decorator tái sử dụng của riêng bạn bằng `createMethodAspectDecorator()` từ `@bunest/core`:

@@filename(audit.aspect.ts)

```ts
import {
  Injectable,
  createMethodAspectDecorator,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/core";

@Injectable()
export class AuditAspectHandler implements MethodAspectHandler<{
  action: string;
}> {
  async intercept(ctx: MethodAspectContext<{ action: string }>) {
    const started = performance.now();
    try {
      return await ctx.proceed();
    } finally {
      const ms = (performance.now() - started).toFixed(2);
      console.log(
        `[AUDIT] ${ctx.options?.action} (${String(ctx.methodName)}) took ${ms}ms`,
      );
    }
  }
}

export const Audit = (action: string) =>
  createMethodAspectDecorator(AuditAspectHandler, { action });
```

Đăng ký `AuditAspectHandler` như một provider trong module của bạn, sau đó áp dụng `@Audit("users.delete")` lên bất kỳ phương thức hoặc class `@Injectable()` nào.

## Các pha thực thi ngữ nghĩa (`AspectPhase`)

Được giới thiệu trong **[ADR-018](/architecture/adrs)**, `AspectPhase` cung cấp các pha thực thi được đặt tên để các aspect xếp chồng và kết hợp luôn chạy theo thứ tự từ ngoài vào trong có thể dự đoán được, bất kể vị trí đặt decorator:

| Pha | Giá trị số | Vai trò |
| --- | ---: | --- |
| `AspectPhase.OBSERVABILITY` | `-500` | Ngoài cùng: tracing span, timer và counter |
| `AspectPhase.RESILIENCE` | `-400` | Retry, circuit breaker, timeout, bulkhead |
| `AspectPhase.RATE_LIMIT` | `-350` | Giới hạn tốc độ (rate limiting) và cổng hạn mức (quota gates) |
| `AspectPhase.LOCK` | `-300` | Khóa phân tán / cục bộ (`@WithLock`) |
| `AspectPhase.TRANSACTION` | `-200` | Ranh giới giao dịch cơ sở dữ liệu (`@Transactional`) |
| `AspectPhase.CACHE` | `-100` | Bộ nhớ đệm read-through / eviction (`@Cacheable`) |
| `AspectPhase.VALIDATION` | `-50` | Kiểm tra đầu vào / bất biến |
| `AspectPhase.DEFAULT` | `0` | Thứ tự mặc định cho các aspect không chỉ định pha |
| `AspectPhase.EVENT` | `100` | Phát sự kiện miền (domain event) sau khi commit |
| `AspectPhase.AUDIT` | `200` | Trong cùng: ghi nhật ký kiểm toán (audit logging) |

Truyền một giá trị pha hoặc `{ phase, order }` (tính theo `phase + order` để sắp xếp chi tiết trong cùng pha) vào `createMethodAspectDecorator()`:

```ts
import { AspectPhase, createMethodAspectDecorator } from "@bunest/core";

export const Audit = (action: string) =>
  createMethodAspectDecorator(AuditAspectHandler, { action }, {
    phase: AspectPhase.AUDIT,
    order: 10,
  });
```

## Chuỗi Aspect có thể kết hợp (`defineAspectPipeline`)

Gom nhiều aspect hoặc các đặc tả `{ token, options?, phase?, order? }` thành một `ClassDecorator & MethodDecorator` duy nhất có thể tái sử dụng — dưới dạng danh sách tĩnh hoặc factory có tham số:

@@filename(pipelines.ts)

```ts
import { AspectPhase, defineAspectPipeline } from "@bunest/core";
import { Cacheable } from "@bunest/cache";
import { Span } from "@bunest/observability";
import { Retry } from "@bunest/resilience";
import { Transactional } from "@bunest/orm";

// Static pipeline reusable on classes or methods
export const TransactionalCommand = defineAspectPipeline([
  Span("command"),
  Retry({ maxAttempts: 3 }),
  Transactional(),
]);

// Parameterized pipeline factory
export const CachedQuery = defineAspectPipeline(
  (opts: { name: string; ttl: number }) => [
    Span(opts.name),
    Cacheable({ key: (id: string) => `${opts.name}:${id}`, ttl: opts.ttl }),
  ],
);

// Combine inline specs with explicit AspectPhase ordering
export const AuditedWrite = defineAspectPipeline([
  { token: AuditAspectHandler, options: { action: "write" }, phase: AspectPhase.AUDIT },
  Transactional(),
]);
```

## Aspect định kiểu chặt chẽ (`createTypedAspect`)

`createTypedAspect<TArgs, TReturn, TOptions>()` cung cấp kiểm tra kiểu đầy đủ tại thời điểm biên dịch cho `ctx.args` và `ctx.proceed(...)` đối với các aspect nội tuyến hoặc dựa trên DI. Truyền `asyncOnly: true` để bắt buộc ở thời điểm biên dịch rằng decorator chỉ có thể áp dụng cho các phương thức trả về `Promise`:

@@filename(typed-aspects.ts)

```ts
import { AspectPhase, Injectable, createTypedAspect } from "@bunest/core";

export const WithTenantTiming = createTypedAspect<
  [tenantId: string, ...rest: unknown[]],
  unknown,
  { slowMs: number }
>({
  phase: AspectPhase.OBSERVABILITY,
  asyncOnly: true, // Compile-time error if applied to a synchronous method!
  async intercept(ctx) {
    const [tenantId] = ctx.args;
    const start = performance.now();
    const result = await ctx.proceed();
    const elapsed = performance.now() - start;
    if (elapsed > ctx.options.slowMs) {
      console.warn(`[${tenantId}] ${String(ctx.methodName)} took ${elapsed.toFixed(1)}ms`);
    }
    return result;
  },
});

@Injectable()
export class BillingService {
  @WithTenantTiming({ slowMs: 250 })
  async charge(tenantId: string, amount: number): Promise<{ ok: boolean }> {
    return { ok: amount > 0 && tenantId.length > 0 };
  }
}
```

## Pointcut khai báo (`AopModule` & `registerGlobalPointcuts`)

Áp dụng aspect trên các class và phương thức khớp mẫu mà không cần gắn decorator thủ công lên từng phương thức bằng **`PointcutRule`** với `AopModule.forRoot({ pointcuts })` (toàn ứng dụng), `AopModule.forFeature({ pointcuts })` (phạm vi module), hoặc `registerGlobalPointcuts(...)`:

@@filename(app.module.ts)

```ts
import {
  AopModule,
  AspectPhase,
  Module,
  registerGlobalPointcuts,
  type PointcutRule,
} from "@bunest/core";
import { AuditAspectHandler } from "./audit.aspect";
import { OrdersService } from "./orders.service";

const serviceAuditRule: PointcutRule = {
  name: "audit-all-services",
  match: {
    className: /Service$/,
    methodName: /^(create|update|delete)/,
    excludeMethods: ["healthCheck"],
  },
  aspects: [
    {
      token: AuditAspectHandler,
      options: { action: "mutation" },
      phase: AspectPhase.AUDIT,
    },
  ],
};

@Module({
  imports: [
    AopModule.forRoot({
      pointcuts: [serviceAuditRule],
      providers: [AuditAspectHandler],
    }),
  ],
  providers: [OrdersService],
})
export class AppModule {}

// Programmatic global registration (returns a dispose function for teardown/tests):
// const dispose = registerGlobalPointcuts(serviceAuditRule);
```

> tip **Bảo toàn Fast-Path** `DIContainer` theo dõi các quy tắc pointcut bằng một bộ đếm phiên bản đơn điệu để các class không khớp cả decorator aspect lẫn pointcut vẫn giữ nguyên nhánh thực thi nhanh O(1) `WeakMap<Function, boolean>` không bọc proxy.

## HTTP Middleware khai báo (`@UseMiddleware`)

Áp dụng HTTP middleware trực tiếp lên controller hoặc route handler mà không cần triển khai `BunestModule.configure()`:

@@filename(admin.controller.ts)

```ts
import { Controller, Get, UseMiddleware } from "@bunest/core";
import { RequestIdMiddleware } from "./request-id.middleware";

@Controller("admin")
@UseMiddleware(RequestIdMiddleware)
export class AdminController {
  @Get("stats")
  getStats() {
    return { ok: true };
  }
}
```
