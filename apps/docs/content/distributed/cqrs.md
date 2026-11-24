# CQRS

**`@bunest/messaging/cqrs`** implements the Command Query Responsibility Segregation pattern natively on Bun with zero RxJS and zero external runtime dependencies—featuring `CqrsModule`, `CommandBus`, `QueryBus`, `EventBus`, `AggregateRoot`, `EventPublisher`, and `@Saga()`.

## Installation

```bash
bun add @bunest/messaging/cqrs
```

## Module Setup

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { CqrsModule } from "@bunest/messaging/cqrs";
import { CreateOrderHandler } from "./create-order.handler";

@Module({
  imports: [CqrsModule.forRoot()],
  providers: [CreateOrderHandler],
})
export class AppModule {}
```

## Commands, Queries & Events

@@filename(create-order.handler.ts)

```ts
import {
  Command,
  CommandHandler,
  EventBus,
  type ICommandHandler,
} from "@bunest/messaging/cqrs";

export class OrderCreatedEvent {
  constructor(public readonly orderId: string) {}
}

export class CreateOrderCommand extends Command<{ orderId: string }> {
  constructor(
    public readonly customerId: string,
    public readonly totalCents: number,
  ) {
    super();
  }
}

@CommandHandler(CreateOrderCommand)
export class CreateOrderHandler implements ICommandHandler<CreateOrderCommand> {
  constructor(private readonly eventBus: EventBus) {}

  async execute(command: CreateOrderCommand) {
    const orderId = crypto.randomUUID();
    this.eventBus.publish(new OrderCreatedEvent(orderId));
    return { orderId };
  }
}
```

## Aggregates & Sagas

- Extend `AggregateRoot` and call `this.apply(new OrderCreatedEvent(id))`, then merge and commit domain events through `EventPublisher.mergeObjectContext(aggregate)`.
- Coordinate long-lived event-to-command reactions using `@Saga()` methods that react to domain events and dispatch follow-up commands on `CommandBus`.
