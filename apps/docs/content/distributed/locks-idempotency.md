# Distributed Locks & Idempotency

Bunest provides two zero-dependency concurrency and deduplication packages for multi-instance production deployments:

- **`@bunest/locks`** — Leased distributed locks with monotonic fencing tokens, `@WithLock()` service aspect ([ADR-014](/architecture/adrs)), `@OnOneInstance()`, `@WithoutOverlapping()`, and `LeaderElection` (with `./testing` helpers).
- **`@bunest/idempotency`** — `@Idempotent()` safe retry deduplication for HTTP routes, GraphQL mutations, and microservice handlers (with `./testing` helpers).

## Installation

@@tab(@bunest/locks)
```bash
bun add @bunest/locks
```
@@switch
@@tab(@bunest/idempotency)
```bash
bun add @bunest/idempotency
```

## Distributed Locks (`@bunest/locks`)

Register `LocksModule.forRoot()` with `InMemoryLockStore` (dev/tests) or a distributed store adapter, and protect critical sections with `@WithLock()`:

@@filename(inventory.service.ts)
```ts
import { Injectable } from "@bunest/core";
import { WithLock } from "@bunest/locks";

@Injectable()
export class InventoryService {
  @WithLock((sku: string) => `inventory:${sku}`, {
    ttl: 5_000,
    waitTimeout: 2_000,
  })
  async reserveStock(sku: string, quantity: number) {
    // Runs exclusively across all instances for the same SKU
    return { sku, reserved: quantity };
  }
}
```

Use `@OnOneInstance()` and `@WithoutOverlapping()` on scheduled tasks to ensure cluster-wide single execution, or inject `LeaderElection` for active-standby workers.

## Idempotent Requests (`@bunest/idempotency`)

Register `IdempotencyModule.forRoot()` and decorate state-mutating endpoints with `@Idempotent()` so client retries carrying the same `Idempotency-Key` header replay the original response without re-executing side effects:

@@filename(charges.controller.ts)
```ts
import { Body, Controller, Post } from "@bunest/core";
import { Idempotent } from "@bunest/idempotency";

@Controller("charges")
export class ChargesController {
  @Post()
  @Idempotent({ ttlMs: 24 * 60 * 60 * 1000 })
  createCharge(@Body() body: { orderId: string; amount: number }) {
    return { chargeId: crypto.randomUUID(), ...body };
  }
}
```
