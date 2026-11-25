# Resilience

**`@bunest/resilience`** provides zero-dependency fault-tolerance policies—**Retry**, **Timeout**, **Circuit Breaker**, **Bulkhead**, **Outbound Rate Limit**, and **Fallback**—that work seamlessly on **both** transport entrypoints (HTTP/GraphQL/WebSocket/Microservice handlers) **and** `@Injectable()` service methods via `MethodAspectWeaver`, with guaranteed zero double-wrapping.

## Installation

```bash
bun add @bunest/resilience
```

## Module Setup

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ResilienceModule } from "@bunest/resilience";

@Module({
  imports: [ResilienceModule.forRoot()],
})
export class AppModule {}
```

## Policy Reference

| Decorator | Purpose | Key Options |
| --- | --- | --- |
| `@Retry(options)` | Retries transient failures with fixed or exponential backoff + jitter | `maxAttempts`, `delayMs`, `backoff`, `retryIf` |
| `@Timeout(options)` | Aborts slow calls after a deadline and propagates an `AbortSignal` | `timeoutMs` |
| `@CircuitBreaker(options)` | Opens circuit after consecutive failures to stop cascading outages | `failureThreshold`, `resetTimeoutMs`, `halfOpenMaxCalls` |
| `@Bulkhead(options)` | Bounds concurrent executions and queue depth to isolate slow dependencies | `maxConcurrent`, `maxQueue` |
| `@Fallback(options)` | Returns a graceful degraded result when upstream policies fail | `fallback: (err, ...args) => ...` |
| `@Signal()` | Injects the cooperative `AbortSignal` managed by `@Timeout()` into a parameter | — |
| `@Resilience(policy)` | Applies a reusable named/composed policy bundle | policy name or config |

## Stacking Policies on Service Methods

Stack decorators from outer to inner (e.g., Fallback → Circuit Breaker → Retry → Timeout → Bulkhead) and pass `@Signal()` straight into `fetch()`:

@@filename(payment-gateway.service.ts)

```ts
import { Injectable } from "@bunest/core";
import {
  Bulkhead,
  CircuitBreaker,
  Fallback,
  Retry,
  Signal,
  Timeout,
} from "@bunest/resilience";

@Injectable()
export class PaymentGatewayService {
  @Fallback({ fallback: () => ({ status: "queued_offline" }) })
  @CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 })
  @Retry({ maxAttempts: 3, delayMs: 200, backoff: "exponential" })
  @Timeout({ timeoutMs: 2_000 })
  @Bulkhead({ maxConcurrent: 20, maxQueue: 50 })
  async charge(
    orderId: string,
    amountCents: number,
    @Signal() signal?: AbortSignal,
  ) {
    const res = await fetch("https://payments.example.com/charge", {
      method: "POST",
      signal,
      body: JSON.stringify({ orderId, amountCents }),
    });
    if (!res.ok) throw new Error(`Gateway error ${res.status}`);
    return res.json();
  }
}
```

## Cooperative Cancellation with `@Signal()`

When `@Timeout()` expires, it aborts the `AbortController` bound to that call. Passing `@Signal()` into `fetch()`, `Bun.SQL`, or downstream async work cancels the in-flight operation immediately instead of leaking background promises.

> info **No Double-Wrapping** When resilience decorators are placed on an HTTP controller route, `ResilienceMethodAspectHandler` detects the entrypoint and defers execution to `ResilienceInterceptor` so retries, timeouts, and bulkheads execute **exactly once**.
