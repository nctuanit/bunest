# Resilience

**`@bunest/resilience`** provides zero-dependency fault-tolerance policies—**Retry**, **Timeout**, **Circuit Breaker**, **Bulkhead**, **Outbound Rate Limit**, and **Fallback**—that work seamlessly on **both** transport entrypoints (HTTP/GraphQL/WebSocket/Microservice handlers) **and** `@Injectable()` service methods via `MethodAspectWeaver` ([ADR-014](/architecture/adrs)), with guaranteed zero double-wrapping.

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

## Declarative Service-Layer Policies

Stack resilience decorators directly on `@Injectable()` service methods:

@@filename(payment-gateway.service.ts)
```ts
import { Injectable } from "@bunest/core";
import {
  Bulkhead,
  CircuitBreaker,
  Fallback,
  Retry,
  Timeout,
} from "@bunest/resilience";

@Injectable()
export class PaymentGatewayService {
  @Fallback({ fallback: () => ({ status: "queued_offline" }) })
  @CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 })
  @Retry({ maxAttempts: 3, delayMs: 200, backoff: "exponential" })
  @Timeout({ timeoutMs: 2_000 })
  @Bulkhead({ maxConcurrent: 20, maxQueue: 50 })
  async charge(orderId: string, amountCents: number) {
    const res = await fetch("https://payments.example.com/charge", {
      method: "POST",
      body: JSON.stringify({ orderId, amountCents }),
    });
    if (!res.ok) throw new Error(`Gateway error ${res.status}`);
    return res.json();
  }
}
```

> info **No Double-Wrapping** When resilience decorators are placed on an HTTP controller route, `ResilienceMethodAspectHandler` detects the entrypoint and defers execution to `ResilienceInterceptor` so retries, timeouts, and bulkheads execute **exactly once**.
