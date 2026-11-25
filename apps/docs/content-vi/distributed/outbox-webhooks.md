# Transactional Outbox & Webhooks

Bunest đi kèm hai package nhắn tin tin cậy chuẩn production xây dựng trên [`@bunest/orm/store`](/data/store-kit) với hỗ trợ PostgreSQL (`./postgres`), MySQL (`./mysql`), in-memory (`./testing`) và CLI:

- **`@bunest/messaging/outbox`** — Transactional outbox nguyên tử, khử trùng lặp inbox phía consumer, relay worker có lease và quản lý dead-letter (`OutboxDeadLetters`).
- **`@bunest/messaging/webhooks`** — Gửi webhook ra ngoài (ký HMAC-SHA256, chính sách SSRF `AddressPolicy`, mã hóa/xoay vòng secret AES-256-GCM, exponential backoff, xử lý `429`/`410`) và xác thực webhook đến (Standard Webhooks, Stripe, GitHub và verifier tùy chỉnh).

## Cài đặt

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

Ghi bản ghi outbox trong cùng transaction cơ sở dữ liệu với các thay đổi domain, và để leased relay phát hành chúng một cách tin cậy:

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

Tiêu thụ các message đã relay một cách idempotent với `@OnOutboxMessage("order.placed")` và kiểm tra hoặc chạy lại các message lỗi thông qua `OutboxDeadLetters`.

## Webhook chiều đi & chiều đến (`@bunest/messaging/webhooks`)

Xác thực webhook đến bằng `@VerifyWebhook()` và gửi các lượt giao webhook có chữ ký, chống SSRF qua `WebhooksModule`:

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

> info **Subpath Export & CLI** Cả `@bunest/messaging/outbox` và `@bunest/messaging/webhooks` đều export các subpath `./postgres`, `./mysql` và `./testing` cùng các CLI binary để chạy migration SQL store và kiểm tra các bảng delivery/outbox.
