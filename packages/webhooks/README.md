# @bunest/webhooks

Production-grade outbound and inbound webhooks for **Bunest** with 100% `@nestjs/webhooks` API parity and zero external runtime dependencies. Includes transactional dispatch, SSRF-guarded HTTP delivery, AES-256-GCM secret management, inbound signature verification, and PostgreSQL/MySQL stores.

## Features

- **Transactional Outbound Delivery**: Dispatch events inside your database transaction via `@bunest/outbox`, with automatic fan-out to subscribed `WebhookEndpoints`, leased background `WebhookWorker`, per-endpoint serialization, exponential backoff with jitter, `Retry-After` throttling, 410 Gone / prolonged-failure auto-disable, and Standard Webhooks HMAC-SHA256 signing.
- **SSRF-Guarded `HttpWebhookTransport`**: Native Bun `fetch()` delivery with DNS resolution and IP pinning blocking private, loopback, link-local, cloud metadata, and reserved IPv4/IPv6 ranges (including IPv4-mapped, NAT64, and 6to4 embeddings), redirect refusal, and response byte caps.
- **Encrypted Secret Management**: AES-256-GCM secret sealing at rest with endpoint-ID AAD binding, multi-key rotation, and zero-downtime secret rotation overlap windows.
- **Inbound Verification & Deduplication**: `@VerifyWebhook()`, `@IncomingWebhook()`, `@WebhookPayload()`, and `WebhookVerifier` supporting Standard Webhooks, Stripe, GitHub, and custom `WebhookSignatureScheme` implementations with `timingSafeEqual`, timestamp tolerance checks, and `OutboxInbox` deduplication.
- **Observability**: Zero-RxJS `WebhooksEvents.events$` (`Subscribable & AsyncIterable`) plus `node:diagnostics_channel` (`nestjs:webhooks:*`).

## Installation

```bash
bun add @bunest/webhooks
```

## Quick Start

```ts
import { Controller, Injectable, Module, Post } from "@bunest/common";
import {
  InMemoryWebhookStore,
  IncomingWebhook,
  VerifyWebhook,
  WebhookPayload,
  Webhooks,
  WebhooksModule,
} from "@bunest/webhooks";

@Injectable()
export class BillingService {
  constructor(private readonly webhooks: Webhooks) {}

  async notifyInvoicePaid(tx: unknown, invoiceId: string) {
    await this.webhooks.dispatch(tx, {
      event: "invoice.paid",
      payload: { invoiceId },
    });
  }
}

@Controller("webhooks")
export class InboundWebhooksController {
  @Post("stripe")
  @VerifyWebhook({ scheme: "stripe", secret: process.env.STRIPE_WEBHOOK_SECRET! })
  handleStripe(
    @IncomingWebhook() meta: { id: string; timestamp: Date },
    @WebhookPayload() payload: Record<string, unknown>,
  ) {
    return { received: meta.id, type: payload.type };
  }
}

@Module({
  imports: [
    WebhooksModule.forRoot({
      store: new InMemoryWebhookStore(),
    }),
  ],
  controllers: [InboundWebhooksController],
  providers: [BillingService],
})
export class AppModule {}
```

## Key Exports

- **Module & Services**: `WebhooksModule`, `Webhooks`, `WebhookEndpoints`, `WebhookDeliveries`, `WebhookWorker`, `WebhookVerifier`, `WebhooksStorage`, `WebhooksEvents`, `WEBHOOKS_MODULE_OPTIONS`, `WEBHOOKS_OUTBOX_TOPIC`
- **Inbound Decorators & Schemes**: `VerifyWebhook`, `IncomingWebhook`, `WebhookPayload`, `WebhookSignatureScheme`
- **Transports & Stores**: `WebhookTransport`, `HttpWebhookTransport`, `InMemoryWebhookTransport`, `InMemoryWebhookStore`, `SentWebhook`
- **Errors**: `WebhooksError`, `InvalidWebhookEndpointError`, `NonRetryableWebhookError`, `WebhookDeliveryNotFoundError`, `WebhookDeliveryTimeoutError`, `WebhookDestinationBlockedError`, `WebhookEndpointNotFoundError`, `WebhookResponseError`, `WebhookVerificationError`

## Subpath Exports

- `@bunest/webhooks/postgres` — `PostgresWebhookStore` and PostgreSQL migration schema powered by `@bunest/store-kit/postgres`.
- `@bunest/webhooks/mysql` — `MySqlWebhookStore` and MySQL migration schema powered by `@bunest/store-kit/mysql`.
- `@bunest/webhooks/testing` — `webhookEndpointStoreContract()`, `webhookDeliveryStoreContract()`, and `signWebhook()` helper for testing `@VerifyWebhook()` routes.

## CLI

`@bunest/webhooks` ships the `nest-webhooks` migration CLI powered by `@bunest/store-kit`:

```bash
bunx nest-webhooks migrate --url postgres://localhost:5432/app
bunx nest-webhooks status --url postgres://localhost:5432/app
bunx nest-webhooks sql --dialect postgres
```

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
