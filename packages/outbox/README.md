# @bunest/outbox

Transactional outbox, consumer inbox deduplication, leased relay, dead letters, and PostgreSQL/MySQL stores for **Bunest** with zero external runtime dependencies.

## Features

- **Atomic Outbox Publishing**: Enqueue messages inside your database transaction via `Outbox.add(tx, ...)` so business state and events commit or roll back together.
- **Per-Key Ordering & Leased Relay**: `OutboxRelay` claims due messages with fencing leases, preserves contiguous ordering per partition key, and retries with configurable backoff.
- **Consumer Inbox Deduplication**: `OutboxInbox` records processed message IDs transactionally to guarantee at-most-once side effects on the consumer side.
- **Dead-Letter Management**: Inspect, filter, requeue, and purge dead letters through `OutboxDeadLetters`.
- **Pluggable Transports & Stores**: `@OnOutboxMessage()` in-process handlers, `ClientProxyTransport`, `toKafkaRecord()`, `InMemoryOutboxStore`, plus PostgreSQL and MySQL SQL stores powered by `@bunest/store-kit`.

## Installation

```bash
bun add @bunest/outbox
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  InMemoryOutboxStore,
  OnOutboxMessage,
  Outbox,
  OutboxModule,
  type OutboxEnvelope,
} from "@bunest/outbox";

@Injectable()
export class OrdersService {
  constructor(private readonly outbox: Outbox) {}

  async placeOrder(tx: unknown, orderId: string) {
    await this.outbox.add(tx, {
      topic: "order.placed",
      key: orderId,
      payload: { orderId },
    });
  }
}

@Injectable()
export class OrderEventHandlers {
  @OnOutboxMessage("order.placed")
  async handleOrderPlaced(envelope: OutboxEnvelope<{ orderId: string }>) {
    console.log("Published order:", envelope.payload.orderId);
  }
}

@Module({
  imports: [
    OutboxModule.forRoot({
      store: new InMemoryOutboxStore(),
    }),
  ],
  providers: [OrdersService, OrderEventHandlers],
})
export class AppModule {}
```

## Key Exports

- **Module & Core Services**: `OutboxModule` (`forRoot`, `forRootAsync`), `Outbox`, `OutboxRelay`, `OutboxDeadLetters`, `OutboxInbox`, `OutboxStorage`, `OUTBOX_MODULE_OPTIONS`
- **Decorators & Transports**: `OnOutboxMessage`, `OutboxTransport`, `ClientProxyTransport`, `toKafkaRecord`
- **Stores & Events**: `InMemoryOutboxStore`, `OutboxEvents`
- **Errors**: `OutboxError`, `NonRetryableMessageError`, `OutboxNoHandlerError`, `OutboxPublishTimeoutError`, `OutboxTransactionRequiredError`

## Subpath Exports

- `@bunest/outbox/postgres` — `PostgresOutboxStore`, `OutboxSchemaError`, and PostgreSQL executor adapters from `@bunest/store-kit/postgres`.
- `@bunest/outbox/mysql` — `MySqlOutboxStore`, `OutboxSchemaError`, and MySQL executor adapters from `@bunest/store-kit/mysql`.
- `@bunest/outbox/testing` — `outboxStoreContract()` and `outboxInboxStoreContract()` runner-agnostic store compliance suites.

## CLI

`@bunest/outbox` ships the `nest-outbox` migration CLI powered by `@bunest/store-kit`:

```bash
bunx nest-outbox migrate --url postgres://localhost:5432/app
bunx nest-outbox status --url postgres://localhost:5432/app
bunx nest-outbox sql --dialect postgres
```

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
