# Durable Workflows

**`@bunest/workflows`** cho phép bạn viết các workflow chạy dài, chịu lỗi và bền bỉ dưới dạng hàm `async` TypeScript thuần—hỗ trợ deterministic replay, phục hồi sau sự cố, durable timer, tín hiệu bên ngoài, compensating saga, child workflow, lịch cron, mã hóa payload AES-256-GCM (`AesGcmPayloadCodec`) và không có dependency runtime bên ngoài.

## Cài đặt

```bash
bun add @bunest/workflows
```

## Subpath Export

| Subpath                      | Mục đích                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `@bunest/workflows`          | Các decorator cốt lõi, `WorkflowsModule`, `WorkflowClient`, `InMemoryWorkflowStore`, `AesGcmPayloadCodec`, `ManualWorkflowClock` |
| `@bunest/workflows/postgres` | Durable workflow store cho PostgreSQL qua `Bun.SQL`                                                                         |
| `@bunest/workflows/mysql`    | Durable workflow store cho MySQL / MariaDB qua `Bun.SQL`                                                                    |
| `@bunest/workflows/cqrs`     | Cầu nối tích hợp với command và event của [`@bunest/messaging/cqrs`](/distributed/cqrs)                                      |
| `@bunest/workflows/testing`  | Bộ kiểm thử deterministic workflow replay & du hành thời gian                                                               |
| `@bunest/workflows/core`     | Engine thực thi bền bỉ độc lập với framework                                                                                |

## Bắt đầu nhanh

@@filename(onboarding.workflow.ts)

```ts
import { Module } from "@bunest/core";
import { InMemoryWorkflowStore, WorkflowsModule } from "@bunest/workflows";

@Module({
  imports: [
    WorkflowsModule.forRoot({
      store: new InMemoryWorkflowStore(),
    }),
  ],
})
export class AppModule {}
```

Viết các bước workflow dưới dạng tác vụ bền bỉ tất định—nếu tiến trình khởi động lại giữa chừng, các bước đã hoàn thành sẽ được replay từ lịch sử đã lưu thay vì chạy lại tác dụng phụ.

> info **Durable AI Agents** Kết hợp `@bunest/workflows` với [`@bunest/ai/workflows`](/ai/ai-sdk) để xây dựng vòng lặp AI agent đa bước có phê duyệt công cụ thủ công (human-in-the-loop) và replay an toàn khi sập.
