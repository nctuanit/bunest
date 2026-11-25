# Transactional Outbox & Webhooks

Bunest ships two production-grade reliable messaging packages built on [`@bunest/orm/store`](/data/store-kit) with PostgreSQL (`./postgres`), MySQL (`./mysql`), in-memory (`./testing`), and CLI support:

- **`@bunest/messaging/outbox`** — Atomic transactional outbox, consumer inbox deduplication, leased relay worker, and dead-letter management (`OutboxDeadLetters`).
- **`@bunest/messaging/webhooks`** — Outbound webhook delivery (HMAC-SHA256 signing, SSRF `AddressPolicy`, AES-256-GCM secret sealing/rotation, exponential backoff, `429`/`410` handling) and inbound verification (Standard Webhooks, Stripe, GitHub, and custom verifiers).

## Installation

@@tab(@bunest/messaging/outbox)

```bash
bun add @bunest/messaging
```

@@switch
@@tab(@bunest/messaging/webhooks)

```bash
bun add @bunest/messaging
```

## Transactional Outbox (`@bunest/messaging/outbox`)

Write outbox records inside the same database transaction as your domain mutations, and let the leased relay publish them reliably:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { InMemoryOutboxStore, OutboxModule } from "@bunest/messaging/outbox";

@Module({
  imports: [
    OutboxModule.forRoot({
      store: new InMemoryOutboxStore(),
    }),
  ],
})
export class AppModule {}
```

Consume relayed messages idempotently with `@OnOutboxMessage("order.placed")` and inspect or replay failed messages via `OutboxDeadLetters`.

## Outbound & Inbound Webhooks (`@bunest/messaging/webhooks`)

Verify inbound webhooks with `@VerifyWebhook()` and send signed, SSRF-protected outbound deliveries through `WebhooksModule`:

@@filename(stripe-webhook.controller.ts)

```ts
import { Controller, Post } from "@bunest/core";
import { IncomingWebhook, VerifyWebhook } from "@bunest/messaging/webhooks";

@Controller("webhooks")
export class StripeWebhookController {
  @Post("stripe")
  @VerifyWebhook("stripe")
  handleStripe(
    @IncomingWebhook() event: { id: string; type: string; payload: unknown },
  ) {
    return { received: event.id };
  }
}
```

> info **Subpath Exports & CLIs** Both `@bunest/messaging/outbox` and `@bunest/messaging/webhooks` export `./postgres`, `./mysql`, and `./testing` subpaths plus CLI binaries for running SQL store migrations and inspecting delivery/outbox tables.
