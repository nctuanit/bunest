# Service-Layer AOP

Introduced in **[ADR-014](/architecture/adrs)**, Bunest's **Service-Layer Method Aspect Weaver** brings zero-overhead Aspect-Oriented Programming (AOP) to `@Injectable()` services across all DI scopes (`SINGLETON`, `TRANSIENT`, `REQUEST`, and `useFactory`).

## Why Service-Layer AOP?

Traditional NestJS enhancers (`@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters`) only execute at transport entrypoints (HTTP, GraphQL, WebSockets, Microservices). Service-layer AOP lets you apply cross-cutting concerns directly on service methods:

- `@Transactional()` (`@bunest/sqlite`, `@bunest/sql`)
- `@Cacheable()` / `@CacheEvict()` / `@CachePut()` (`@bunest/cache`)
- `@Span()` / `@Trace()` / `@Timed()` / `@Counted()` (`@bunest/observability`)
- `@EmitEvent()` (`@bunest/events`)
- `@WithLock()` (`@bunest/locks`)
- `@WithCls()` (`@bunest/core`)
- `@Retry()` / `@Timeout()` / `@CircuitBreaker()` / `@Bulkhead()` / `@Fallback()` (`@bunest/resilience`)
- `@UseMiddleware()` & `@InheritMethodEnhancers()` (`@bunest/common`, `@bunest/http`)

> info **Zero Overhead on Undecorated Classes** `DIContainer` caches aspect presence in an O(1) `WeakMap<Function, boolean>`. Plain services without method aspects are never proxied or wrapped, and synchronous aspects wrapping synchronous methods return values directly without wrapping them in a `Promise`.

## Stacking Order

Stacked decorators on the same method execute **outer-to-inner in exact top-to-bottom declaration order** (class-level before method-level, base before derived, stably sorted by `order ?? 0` ascending):

@@filename(orders.service.ts)
```ts
import { Injectable } from "@bunest/core";
import { CacheEvict } from "@bunest/cache";
import { EmitEvent } from "@bunest/events";
import { WithLock } from "@bunest/locks";
import { Span, Timed } from "@bunest/observability";
import { Retry } from "@bunest/resilience";
import { Transactional } from "@bunest/sqlite";

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

## Writing Custom Method Aspects

Create your own reusable service decorators with `createMethodAspectDecorator()` from `@bunest/common`:

@@filename(audit.aspect.ts)
```ts
import {
  Injectable,
  createMethodAspectDecorator,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/core";

@Injectable()
export class AuditAspectHandler implements MethodAspectHandler<{ action: string }> {
  async intercept(ctx: MethodAspectContext<{ action: string }>) {
    const started = performance.now();
    try {
      return await ctx.proceed();
    } finally {
      const ms = (performance.now() - started).toFixed(2);
      console.log(`[AUDIT] ${ctx.options?.action} (${String(ctx.methodName)}) took ${ms}ms`);
    }
  }
}

export const Audit = (action: string) =>
  createMethodAspectDecorator(AuditAspectHandler, { action });
```

Register `AuditAspectHandler` as a provider in your module, then apply `@Audit("users.delete")` to any `@Injectable()` method or class.

## Declarative HTTP Middleware (`@UseMiddleware`)

Apply HTTP middleware directly on controllers or route handlers without implementing `BunestModule.configure()`:

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
