# @bunest/resilience

Bun-native resilience policies and NestJS v12-compatible entrypoint decorators for **Bunest** with zero external runtime dependencies and zero RxJS. Provides composable retry, timeout, circuit breaker, bulkhead, outbound rate limit, and fallback policies.

## Features

- **Composable Policies**: `RetryPolicy` (exponential/linear/custom backoff with full/equal/none jitter), `TimeoutPolicy` (cooperative `AbortSignal`), `CircuitBreakerPolicy` (closed/open/half-open with count or time sliding windows), `BulkheadPolicy` (concurrency and bounded queue with queue timeout), `OutboundRateLimitPolicy` (continuous token bucket), `FallbackPolicy`, and explicit composition via `ResiliencePolicy.wrap(...)`.
- **Module & Named Presets**: `ResilienceModule.forRoot(...)` / `forRootAsync(...)` and `ResilienceService` (`preset`, `create`, `circuitBreaker`, `bulkhead`, `circuitBreakers`, `bulkheads`).
- **Entrypoint & Method Decorators**: `@Resilience()`, `@Retry()`, `@Timeout()`, `@CircuitBreaker()`, `@Bulkhead()`, `@Fallback()`, and `@Signal()`.
- **Context & Observability**: `AsyncLocalStorage`-backed `ResilienceContext` (`signal`, `attempt`, `run`) and zero-RxJS `ResilienceEvents` (`events$` `Subscribable & AsyncIterable`, plus `node:diagnostics_channel` `nestjs:resilience:<type>` channels).

## Installation

```bash
bun add @bunest/resilience
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  CircuitBreaker,
  ResilienceModule,
  Retry,
  Signal,
  Timeout,
} from "@bunest/resilience";

@Injectable()
export class PaymentsGateway {
  @Retry({ maxAttempts: 3, backoff: { type: "exponential", delay: "100ms" } })
  @CircuitBreaker({
    name: "payments",
    failureThreshold: 5,
    openDuration: "30s",
  })
  @Timeout("2s")
  async charge(amount: number, @Signal() signal?: AbortSignal) {
    const res = await fetch("https://payments.example.com/charge", {
      method: "POST",
      body: JSON.stringify({ amount }),
      signal,
    });
    return res.json();
  }
}

@Module({
  imports: [ResilienceModule.forRoot()],
  providers: [PaymentsGateway],
})
export class AppModule {}
```

## Key Exports

- **Module & Service**: `ResilienceModule`, `ResilienceService`, `ResilienceContext`, `ResilienceEvents`, `ResilienceMethodAspectHandler`, `RESILIENCE_MODULE_OPTIONS`, `RESILIENCE_METHOD_ASPECT`
- **Policies**: `ResiliencePolicy`, `RetryPolicy`, `TimeoutPolicy`, `CircuitBreakerPolicy`, `BulkheadPolicy`, `OutboundRateLimitPolicy`, `FallbackPolicy`, `isClientError`
- **Decorators**: `Resilience`, `Retry`, `Timeout`, `CircuitBreaker`, `Bulkhead`, `Fallback`, `Signal`
- **Errors**: `ResilienceError`, `ResilienceTimeoutError`, `CircuitOpenError`, `BulkheadFullError`, `OutboundRateLimitError`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
