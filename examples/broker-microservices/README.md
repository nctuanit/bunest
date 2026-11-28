# Resilient Broker Microservices (DLQ + CLS + Idempotency)

Demonstrates production distributed reliability with **zero external runtime dependencies**:

- **In-memory Broker Microservices (`@bunest/microservices`)**: `@MessagePattern()`, `@EventPattern()`, `InMemoryBroker`, `InMemoryClientProxy`, and **poison-message Dead-Letter Queue (`deadLetterHandler`)**
- **Automatic Cross-RPC CLS Propagation**: `ClsService` keys (`tenantId`, `correlationId`) cross the RPC boundary transparently
- **Resilience Policies (`@bunest/resilience`)**: `@Retry`, `@CircuitBreaker`, and `@Fallback` protecting downstream payment calls
- **HTTP Request Idempotency (`@bunest/resilience/idempotency`)**: `@Idempotent()` deduplicates retried `POST /orders` by `Idempotency-Key` header

## Run

```bash
bun run --cwd examples/broker-microservices dev
bun test examples/broker-microservices
```
