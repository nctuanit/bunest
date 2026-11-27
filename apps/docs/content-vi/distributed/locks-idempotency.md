# Khóa phân tán & Idempotency

`@bunest/resilience` cung cấp hai subpath xử lý đồng thời và khử trùng lặp request cho môi trường production đa instance:

- **`@bunest/resilience/locks`** — Khóa phân tán có thời hạn thuê (leased distributed lock) kèm fencing token đơn điệu, service aspect `@WithLock()`, `@OnOneInstance()`, `@WithoutOverlapping()` và `LeaderElection` (kèm helper `./testing`).
- **`@bunest/resilience/idempotency`** — `@Idempotent()` khử trùng lặp retry an toàn cho các HTTP route, GraphQL mutation và microservice handler (kèm helper `./testing`).

## Cài đặt

@@tab(@bunest/resilience/locks)

```bash
bun add @bunest/resilience
```

@@switch
@@tab(@bunest/resilience/idempotency)

```bash
bun add @bunest/resilience
```

## Khóa phân tán (`@bunest/resilience/locks`)

Đăng ký `LocksModule.forRoot()` với `InMemoryLockStore` (dev/test) hoặc một adapter store phân tán, và bảo vệ các đoạn xử lý quan trọng bằng `@WithLock()`:

@@filename(inventory.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { WithLock } from "@bunest/resilience/locks";

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

Dùng `@OnOneInstance()` và `@WithoutOverlapping()` trên các tác vụ định kỳ để đảm bảo thực thi đơn lẻ trên toàn cụm, hoặc inject `LeaderElection` cho mô hình worker active-standby.

## Idempotency cho Request (`@bunest/resilience/idempotency`)

Đăng ký `IdempotencyModule.forRoot()` và gắn `@Idempotent()` cho các endpoint thay đổi trạng thái để khi client retry với cùng header `Idempotency-Key`, hệ thống phát lại phản hồi ban đầu mà không thực thi lại tác dụng phụ:

@@filename(charges.controller.ts)

```ts
import { Body, Controller, Post } from "@bunest/core";
import { Idempotent } from "@bunest/resilience/idempotency";

@Controller("charges")
export class ChargesController {
  @Post()
  @Idempotent({ ttl: 24 * 60 * 60 * 1000 })
  createCharge(@Body() body: { orderId: string; amount: number }) {
    return { chargeId: crypto.randomUUID(), ...body };
  }
}
```
