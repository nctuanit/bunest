# @bunest/events

Typed event emitter for Bunest with wildcard matching, async emission, error isolation, `@OnEvent()` DI discovery, and `@EmitEvent()` AOP method emission with zero external runtime dependencies.

## Features

- **Wildcard & Typed Event Matching**: `EventEmitterService` (aliased as `EventEmitter2`) supports hierarchical delimiters, single/multi-segment wildcards (`matchEventName`), listener priorities, `once()`, `waitFor()`, and `emitAsync()`.
- **Declarative Listeners**: `@OnEvent()` decorator with automatic DI discovery via `EventEmitterExplorer`, `@EventPayload()` parameter extraction, and `EventEmitterReadinessWatcher`.
- **Declarative AOP Emission**: `@EmitEvent()` method decorator (`EmitEventAspect`) emits domain events automatically after method execution.
- **Error Isolation**: Configurable error handling prevents one failing listener from breaking other subscribers.

## Installation

```bash
bun add @bunest/events
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  EventEmitterModule,
  EventEmitterService,
  OnEvent,
} from "@bunest/events";

@Injectable()
export class OrderListeners {
  @OnEvent("order.created")
  handleOrderCreated(payload: { orderId: string }) {
    console.log("Order created:", payload.orderId);
  }
}

@Injectable()
export class OrdersService {
  constructor(private readonly events: EventEmitterService) {}

  async createOrder(orderId: string) {
    await this.events.emitAsync("order.created", { orderId });
  }
}

@Module({
  imports: [EventEmitterModule.forRoot({ wildcard: true })],
  providers: [OrderListeners, OrdersService],
})
export class AppModule {}
```

## Key Exports

- **Module & Services**: `EventEmitterModule` (`forRoot`), `EventEmitterService`, `EventEmitter2`, `EventEmitterExplorer`, `EventEmitterReadinessWatcher`
- **Decorators**: `@OnEvent()`, `@EventPayload()`, `@EmitEvent()`, `EmitEventAspect`
- **Utilities & Metadata Helpers**: `matchEventName`, `getOnEventMetadata`, `getEventParamMetadata`
- **Tokens**: `EVENT_EMITTER_OPTIONS`, `ON_EVENT_METADATA`, `EVENT_LISTENER_METADATA`, `EVENT_PARAMS_METADATA`, `EVENT_PAYLOAD`, `DEFAULT_LISTENER_PRIORITY`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
