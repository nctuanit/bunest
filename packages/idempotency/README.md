# @bunest/idempotency

Idempotency-Key support for Bunest with 100% `@nestjs/idempotency` API parity and zero external runtime dependencies. Mark any HTTP route, GraphQL mutation, or microservice handler with `@Idempotent()` so retries carrying the same idempotency key execute once and replay the stored result.

## Features

- **Single Decorator**: `@Idempotent(options?)` on handler methods or controllers/resolvers.
- **Pluggable Store Registry**: Register custom stores via `IdempotencyStorage.registerSource(store)` or use `InMemoryIdempotencyStore` in development and testing.
- **Deterministic Request Fingerprinting**: Canonical JSON + SHA-256 over scope, method/URL (or GraphQL field / RPC pattern), and payload. Reusing a key for a different request returns `422 Unprocessable Entity` (`IDEMPOTENCY_KEY_REUSED`).
- **In-Flight Lock Fencing & Heartbeat Renewal**: Concurrent duplicate calls receive `409 Conflict` (`IDEMPOTENCY_KEY_IN_USE`) with a `Retry-After` header. Long-running handlers automatically renew locks every `lockTtl / 3` up to `maxLockHold`.
- **At-Rest Response Encryption**: Optional AES-256-GCM sealing with HKDF-SHA256 key derivation, AAD bound to the store key, and multi-key rotation (`encryption.keys`).
- **Zero-RxJS Observability**: `IdempotencyEvents.events$` supports both `.subscribe(...)` and `for await`, and publishes to `node:diagnostics_channel` (`nestjs:idempotency:replayed`, `nestjs:idempotency:rejected`, `nestjs:idempotency:lock-lost`).
- **Runner-Agnostic Store Contract Suite**: `@bunest/idempotency/testing` exports `idempotencyStoreContract` to verify any custom `IdempotencyStore`.

## Installation

```bash
bun add @bunest/idempotency
```

## Quick Start

```ts
import { Body, Controller, Module, Post } from "@bunest/common";
import { IdempotencyModule, Idempotent } from "@bunest/idempotency";

@Controller("payments")
export class PaymentsController {
  @Post()
  @Idempotent({ required: true, ttl: "24h" })
  create(@Body() dto: { amount: number }) {
    return { receiptId: crypto.randomUUID(), amount: dto.amount };
  }
}

@Module({
  imports: [IdempotencyModule.forRoot()],
  controllers: [PaymentsController],
})
export class AppModule {}
```

## Key Exports

- **Module & Decorator**: `IdempotencyModule` (`forRoot`, `forRootAsync`), `IDEMPOTENCY_MODULE_OPTIONS`, `@Idempotent()`
- **Storage & Stores**: `IdempotencyStorage`, `InMemoryIdempotencyStore`
- **Events & Errors**: `IdempotencyEvents`, `IdempotencyStoreTimeoutError`

## Subpath Exports

- **`@bunest/idempotency/testing`**: `idempotencyStoreContract` (runner-agnostic compliance suite for custom `IdempotencyStore` implementations)

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
