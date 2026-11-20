# @bunest/cqrs

Command Query Responsibility Segregation (CQRS) for Bunest: typed `CommandBus`, `QueryBus`, `EventBus`, `AggregateRoot`, `EventPublisher`, `UnhandledExceptionBus`, and `@Saga()` workflows with zero external runtime dependencies and zero RxJS.

## Features

- **Typed Commands & Queries**: Extend `Command<TResult>` and `Query<TResult>` for automatic return-type inference on `CommandBus.execute()` and `QueryBus.execute()`.
- **Domain Events & Aggregates**: `EventBus`, `AggregateRoot`, `EventPublisher`, `WithAggregateRoot()`, and `@Publishable()` for dispatching domain events cleanly from entities.
- **Zero-RxJS Sagas & Streams**: `@Saga()` workflows and `SubscribableStream` (native `Subscribable` + `AsyncIterable` per ADR-008) with configurable saga error handling (`UnhandledExceptionBus`).
- **Automatic DI Discovery**: `CqrsExplorer` discovers `@CommandHandler()`, `@QueryHandler()`, `@EventsHandler()`, and `@Saga()` providers automatically.

## Installation

```bash
bun add @bunest/cqrs
```

## Quick Start

```ts
import { Module } from "@bunest/common";
import {
  Command,
  CommandBus,
  CommandHandler,
  CqrsModule,
  type ICommandHandler,
} from "@bunest/cqrs";

export class CreateOrderCommand extends Command<{ orderId: string }> {
  constructor(public readonly itemId: string) {
    super();
  }
}

@CommandHandler(CreateOrderCommand)
export class CreateOrderHandler
  implements ICommandHandler<CreateOrderCommand, { orderId: string }>
{
  async execute(command: CreateOrderCommand) {
    return { orderId: `ord_${command.itemId}` };
  }
}

@Module({
  imports: [CqrsModule.forRoot()],
  providers: [CreateOrderHandler],
})
export class OrdersModule {
  constructor(readonly commandBus: CommandBus) {}
}
```

## Key Exports

- **Module & Buses**: `CqrsModule`, `CqrsExplorer`, `CommandBus`, `QueryBus`, `EventBus`, `UnhandledExceptionBus`, `EventPublisher`, `AggregateRoot`, `AggregateRootStorage`, `AsyncContext`
- **Base Classes & Streams**: `Command`, `Query`, `SubscribableStream`, `DefaultPubSub`, `DefaultCommandPubSub`, `DefaultQueryPubSub`, `DefaultUnhandledExceptionPubSub`, `DefaultEventIdProvider`
- **Decorators & Mixins**: `@CommandHandler()`, `@QueryHandler()`, `@EventsHandler()`, `@Saga()`, `@Publishable()`, `WithAggregateRoot()`
- **Exceptions**: `CommandHandlerNotFoundException`, `DuplicateCommandHandlerException`, `InvalidCommandHandlerException`, `QueryHandlerNotFoundException`, `DuplicateQueryHandlerException`, `InvalidQueryHandlerException`, `InvalidEventsHandlerException`, `InvalidSagaException`, `UnsupportedSagaScopeException`
- **Tokens**: `CQRS_MODULE_OPTIONS`, `COMMAND_METADATA`, `COMMAND_HANDLER_METADATA`, `QUERY_METADATA`, `QUERY_HANDLER_METADATA`, `EVENT_METADATA`, `EVENTS_HANDLER_METADATA`, `SAGA_METADATA`, `RESULT_TYPE_SYMBOL`, `ASYNC_CONTEXT_ATTRIBUTE`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
