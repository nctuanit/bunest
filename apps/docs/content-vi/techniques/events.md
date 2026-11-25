# Sự kiện (Events)

**`@bunest/messaging/events`** cung cấp bộ phát sự kiện (event emitter) nội tiến trình không phụ thuộc ngoài được xây dựng cho Bunest với `@OnEvent()`, khớp ký tự đại diện (`*` / `**`), điều phối đồng bộ và `emitAsync()`, aspect dịch vụ khai báo `@EmitEvent()`, cùng các pipe/guard/interceptor cho tham số `@EventPayload()`.

## Cài đặt

```bash
bun add @bunest/messaging
```

## Thiết lập Module

Đăng ký `EventEmitterModule.forRoot()` trong `AppModule`:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { EventEmitterModule } from "@bunest/messaging/events";

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

## Phát & Lắng nghe sự kiện

Inject `EventEmitter2` để phát sự kiện trực tiếp, và gắn decorator `@OnEvent()` cho các phương thức lắng nghe:

@@filename(orders.listener.ts)

```ts
import { Injectable, Logger } from "@bunest/core";
import { EventPayload, OnEvent } from "@bunest/messaging/events";

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

## Aspect `@EmitEvent()` dạng khai báo

Thay vì phải inject `EventEmitter2` thủ công trong mọi service, bạn có thể gắn decorator `@EmitEvent()` lên phương thức để giá trị trả về đã phân giải của phương thức được tự động phát ra khi thành công (và không bao giờ phát nếu phương thức ném lỗi):

@@filename(orders.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { EmitEvent } from "@bunest/messaging/events";

@Injectable()
export class OrdersService {
  @EmitEvent("order.created", { async: true })
  async createOrder(totalCents: number) {
    return { orderId: crypto.randomUUID(), totalCents };
  }
}
```

## Ký tự đại diện & Tùy chọn Listener

| Tùy chọn          | Mô tả                                                              |
| ----------------- | ------------------------------------------------------------------ |
| `wildcard: true`  | Bật khớp mẫu một phân đoạn `*` và nhiều phân đoạn `**`             |
| `delimiter: "."`  | Ký tự phân tách namespace cho tên sự kiện                          |
| `async: true`     | Chạy listener bất đồng bộ mà không chặn bộ phát sự kiện            |
| `priority`        | Độ ưu tiên thực thi listener xác định (số lớn hơn chạy trước)      |
| `prependListener` | Chèn listener vào đầu danh sách handler                            |
