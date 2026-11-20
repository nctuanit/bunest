# Events

**`@bunest/events`** provides an in-process, zero-dependency event emitter built for Bunest with `@OnEvent()`, wildcard (`*` / `**`) matching, synchronous and `emitAsync()` dispatch, declarative `@EmitEvent()` service aspects, and `@EventPayload()` parameter pipes/guards/interceptors.

## Installation

```bash
bun add @bunest/events
```

## Module Setup

Register `EventEmitterModule.forRoot()` in `AppModule`:

@@filename(app.module.ts)
```ts
import { Module } from "@bunest/core";
import { EventEmitterModule } from "@bunest/events";

@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: ".",
      maxListeners: 20,
    }),
  ],
})
export class AppModule {}
```

## Emitting & Listening to Events

Inject `EventEmitter2` to dispatch events imperatively, and decorate listener methods with `@OnEvent()`:

@@filename(orders.listener.ts)
```ts
import { Injectable, Logger } from "@bunest/core";
import { EventPayload, OnEvent } from "@bunest/events";

export interface OrderCreatedEvent {
  orderId: string;
  totalCents: number;
}

@Injectable()
export class OrdersListener {
  private readonly logger = new Logger(OrdersListener.name);

  @OnEvent("order.created", { async: true })
  async handleOrderCreated(@EventPayload() payload: OrderCreatedEvent) {
    this.logger.log(`Order created: ${payload.orderId}`);
  }

  @OnEvent("order.*")
  auditAnyOrderEvent(payload: unknown) {
    this.logger.debug("Audit order event", payload);
  }
}
```

## Declarative `@EmitEvent()` Aspect ([ADR-014](/architecture/adrs))

Instead of injecting `EventEmitter2` manually in every service, decorate methods with `@EmitEvent()` so the method's resolved return value is emitted automatically on success (and never emitted if the method throws):

@@filename(orders.service.ts)
```ts
import { Injectable } from "@bunest/core";
import { EmitEvent } from "@bunest/events";

@Injectable()
export class OrdersService {
  @EmitEvent("order.created", { async: true })
  async createOrder(totalCents: number) {
    return { orderId: crypto.randomUUID(), totalCents };
  }
}
```

## Wildcards & Listener Options

| Option | Description |
|---|---|
| `wildcard: true` | Enables single-segment `*` and multi-segment `**` pattern matching |
| `delimiter: "."` | Namespace separator for event names |
| `async: true` | Runs the listener asynchronously without blocking the emitter |
| `priority` | Deterministic listener execution priority (higher runs first) |
| `prependListener` | Inserts the listener at the head of the handler list |
