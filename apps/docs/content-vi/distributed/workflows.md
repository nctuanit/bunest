# Durable Workflows

**`@bunest/workflows`** cho phép viết các quy trình nghiệp vụ chạy dài, chịu lỗi và phục hồi sau sự cố bằng code TypeScript `async` thuần — hỗ trợ deterministic replay, durable timers, external signals, compensating sagas, child workflows, cron schedules, mã hóa payload AES-256-GCM (`AesGcmPayloadCodec`) và 0 phụ thuộc runtime ngoài.

## Cài đặt

```bash
bun add @bunest/workflows
```

## Các Subpath Exports

| Subpath | Mục đích |
| --- | --- |
| `@bunest/workflows` | `@Workflow`, `WorkflowsModule`, `WorkflowClient`, `InMemoryWorkflowStore`, `AesGcmPayloadCodec`, `ManualWorkflowClock` |
| `@bunest/workflows/postgres` | Durable workflow store cho PostgreSQL trên `Bun.SQL` |
| `@bunest/workflows/mysql` | Durable workflow store cho MySQL / MariaDB trên `Bun.SQL` |
| `@bunest/workflows/cqrs` | Cầu nối `@StartOn` & `@SignalOn` với [`@bunest/messaging/cqrs`](/distributed/cqrs) |
| `@bunest/workflows/testing` | Bộ test replay tất định và tua nhanh thời gian (time-travel) |
| `@bunest/workflows/core` | Engine thực thi durable độc lập framework |

## Cấu hình Module

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { WorkflowsModule } from "@bunest/workflows";
import { OrderFulfillmentWorkflow } from "./order-fulfillment.workflow";

@Module({
  imports: [
    WorkflowsModule.forRoot({}),
  ],
  providers: [OrderFulfillmentWorkflow],
})
export class AppModule {}
```

## Viết Durable Workflow

Dùng `@Workflow("name")` để đăng ký workflow. Mọi side effect đặt trong `ctx.step(name, fn)` sẽ chỉ thực thi đúng một lần và **được replay từ lịch sử đã lưu** nếu tiến trình khởi động lại:

@@filename(order-fulfillment.workflow.ts)

```ts
import { Injectable } from "@bunest/core";
import { Workflow, type WorkflowContext } from "@bunest/workflows";

@Injectable()
@Workflow("order-fulfillment")
export class OrderFulfillmentWorkflow {
  async run(ctx: WorkflowContext, input: { orderId: string; email: string }) {
    // Bước 1: Đã lưu bền vững — không chạy lại khi replay
    const reservation = await ctx.step("reserve-inventory", async () => {
      return { reserved: true, orderId: input.orderId };
    });

    // Durable timer — vẫn sống sót qua restart & deploy
    await ctx.sleep("wait-grace-period", 60_000);

    // Bước 2: Gửi xác nhận
    await ctx.step("send-confirmation", async () => {
      return { sentTo: input.email, reservation };
    });

    return { status: "completed", orderId: input.orderId };
  }
}
```

## Kích hoạt từ CQRS (`@StartOn`, `@SignalOn`)

- `@StartOn(OrderPlacedEvent)` — tự động khởi chạy workflow khi command/event tương ứng được phát ra.
- `@SignalOn(PaymentApprovedEvent)` — gửi tín hiệu ngoài vào workflow đang chờ.

## Mã hóa Payload & Kiểm thử tất định

- **Mã hóa dữ liệu lưu trữ**: Truyền `codec: new AesGcmPayloadCodec({ key })` trong `WorkflowsModule.forRoot()` để mã hóa input/output trước khi ghi xuống SQL.
- **Test tua nhanh thời gian**: Dùng `ManualWorkflowClock` và `@bunest/workflows/testing` để kiểm thử các timer kéo dài nhiều ngày chỉ trong vài mili-giây.

> info **Durable AI Agents** Kết hợp `@bunest/workflows` với [`@bunest/ai/workflows`](/ai/ai-sdk) để xây dựng vòng lặp AI agent đa bước có bước duyệt từ con người và khôi phục an toàn khi crash.
