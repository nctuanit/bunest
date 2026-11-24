# Service-Layer AOP

Introduced in **[ADR-014](/architecture/adrs)**, Bunest's **Service-Layer Method Aspect Weaver** brings zero-overhead Aspect-Oriented Programming (AOP) to `@Injectable()` services across all DI scopes (`SINGLETON`, `TRANSIENT`, `REQUEST`, and `useFactory`).

## Why Service-Layer AOP?

Traditional NestJS enhancers (`@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters`) only execute at transport entrypoints (HTTP, GraphQL, WebSockets, Microservices). Service-layer AOP lets you apply cross-cutting concerns directly on service methods:

- `@Transactional()` (`@bunest/orm`)
- `@Cacheable()` / `@CacheEvict()` / `@CachePut()` (`@bunest/cache`)
- `@Span()` / `@Trace()` / `@Timed()` / `@Counted()` (`@bunest/observability`)
- `@EmitEvent()` (`@bunest/messaging/events`)
- `@WithLock()` (`@bunest/resilience/locks`)
- `@WithCls()` (`@bunest/core`)
- `@Retry()` / `@Timeout()` / `@CircuitBreaker()` / `@Bulkhead()` / `@Fallback()` (`@bunest/resilience`)
- `@UseMiddleware()` & `@InheritMethodEnhancers()` (`@bunest/core`, `@bunest/core/http`)

> info **Zero Overhead on Undecorated Classes** `DIContainer` caches aspect presence in an O(1) `WeakMap<Function, boolean>`. Plain services without method aspects are never proxied or wrapped, and synchronous aspects wrapping synchronous methods return values directly without wrapping them in a `Promise`.

## Stacking Order

Stacked decorators on the same method execute **outer-to-inner in exact top-to-bottom declaration order** (class-level before method-level, base before derived, stably sorted by `order ?? 0` ascending):

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

## Writing Custom Method Aspects

Create your own reusable service decorators with `createMethodAspectDecorator()` from `@bunest/core`:

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

Register `AuditAspectHandler` as a provider in your module, then apply `@Audit("users.delete")` to any `@Injectable()` method or class.

## Semantic Execution Phases (`AspectPhase`)

Introduced in **[ADR-018](/architecture/adrs)**, `AspectPhase` provides named execution phases so stacked and composed aspects always run in a predictable outer-to-inner order regardless of decorator placement:

| Phase | Numeric Value | Role |
| --- | ---: | --- |
| `AspectPhase.OBSERVABILITY` | `-500` | Outermost tracing spans, timers, and counters |
| `AspectPhase.RESILIENCE` | `-400` | Retries, circuit breakers, timeouts, bulkheads |
| `AspectPhase.RATE_LIMIT` | `-350` | Rate limiting and quota gates |
| `AspectPhase.LOCK` | `-300` | Distributed / local locks (`@WithLock`) |
| `AspectPhase.TRANSACTION` | `-200` | Database transaction boundaries (`@Transactional`) |
| `AspectPhase.CACHE` | `-100` | Read-through / eviction caching (`@Cacheable`) |
| `AspectPhase.VALIDATION` | `-50` | Input/invariant checks |
| `AspectPhase.DEFAULT` | `0` | Default order for unphased aspects |
| `AspectPhase.EVENT` | `100` | Domain event emission after commit |
| `AspectPhase.AUDIT` | `200` | Innermost audit logging |

Pass either a phase value or `{ phase, order }` (which computes `phase + order` for fine-grained sub-phase ordering) to `createMethodAspectDecorator()`:

```ts
import { AspectPhase, createMethodAspectDecorator } from "@bunest/core";

export const Audit = (action: string) =>
  createMethodAspectDecorator(AuditAspectHandler, { action }, {
    phase: AspectPhase.AUDIT,
    order: 10,
  });
```

## Composable Aspect Pipelines (`defineAspectPipeline`)

Bundle multiple aspects or `{ token, options?, phase?, order? }` specs into a single reusable `ClassDecorator & MethodDecorator` — either as a static list or a parameterized factory:

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

## Strongly-Typed Aspects (`createTypedAspect`)

`createTypedAspect<TArgs, TReturn, TOptions>()` gives inline or DI-backed aspects full compile-time typing for `ctx.args` and `ctx.proceed(...)`. Pass `asyncOnly: true` to enforce at compile time that the decorator can only be applied to `Promise`-returning methods:

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

## Declarative Pointcuts (`AopModule` & `registerGlobalPointcuts`)

Apply aspects across matching classes and methods without decorating every method individually using **`PointcutRule`** with `AopModule.forRoot({ pointcuts })` (app-wide), `AopModule.forFeature({ pointcuts })` (module-scoped), or `registerGlobalPointcuts(...)`:

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

> tip **Fast-Path Preserved** `DIContainer` tracks pointcut rules with a monotonic version counter so classes matching neither decorator aspects nor pointcuts keep the O(1) `WeakMap<Function, boolean>` zero-wrapping fast-path.

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
