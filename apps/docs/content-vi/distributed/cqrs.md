# CQRS

**`@bunest/messaging/cqrs`** triển khai mẫu Command Query Responsibility Segregation chạy native trên Bun không dùng RxJS và không có dependency runtime bên ngoài—bao gồm `CqrsModule`, `CommandBus`, `QueryBus`, `EventBus`, `AggregateRoot`, `EventPublisher` và `@Saga()`.

## Cài đặt

```bash
bun add @bunest/messaging
```

## Thiết lập Module

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

## Command, Query & Event

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

## Aggregate & Saga

- Kế thừa `AggregateRoot` và gọi `this.apply(new OrderCreatedEvent(id))`, sau đó hợp nhất và commit domain event thông qua `EventPublisher.mergeObjectContext(aggregate)`.
- Điều phối các chuỗi phản ứng từ sự kiện sang lệnh kéo dài bằng các phương thức `@Saga()` lắng nghe domain event và gửi command tiếp theo lên `CommandBus`.
