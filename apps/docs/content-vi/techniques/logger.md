# Logger

Bunest tích hợp sẵn **`Logger`** có cấu trúc, hỗ trợ các mức log (log levels), nhãn ngữ cảnh (context labels), chế độ xuất JSON cho các hệ thống thu thập log và **tự động ẩn thông tin nhạy cảm theo chiều sâu bất biến**.

## Sử dụng cơ bản

Khởi tạo `new Logger(ContextName)` bên trong bất kỳ service, controller, guard hoặc interceptor nào:

@@filename(orders.service.ts)

```ts
import { Injectable, Logger } from "@bunest/core";

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  create(orderId: string, payload: Record<string, unknown>) {
    this.logger.log(`Creating order ${orderId}`, payload);
    this.logger.debug("Order validation completed");
    this.logger.warn("Inventory threshold approaching limit");
  }
}
```

Kết quả đầu ra ở chế độ văn bản (text mode):

```text
[Bunest] 2026-11-20T03:00:00.000Z LOG [OrdersService] Creating order ord_42 {"sku":"BUN-1"}
```

## Chế độ JSON có cấu trúc & Tùy chọn tùy chỉnh

Truyền `LoggerOptions` để ghi log JSON cho máy đọc (lý tưởng cho Datadog, Loki, OpenTelemetry hoặc CloudWatch):

@@filename(logger.config.ts)

```ts
import { Logger, type LoggerOptions } from "@bunest/core";

const prodLogger = new Logger("Bootstrap", {
  json: true,
  timestamp: true,
  levels: ["fatal", "error", "warn", "log"],
  redactKeys: ["internalApiKey", "stripeSecret"],
  redactionMask: "[REDACTED]",
});

Logger.overrideLogger(prodLogger);
```

## Ẩn thông tin nhạy cảm theo chiều sâu tích hợp sẵn

Mọi đối tượng, mảng lồng nhau, `Headers`, `Map` và `Error` được ghi qua `Logger` đều được sao chép sâu (deep-clone) và che giấu **mà không làm thay đổi dữ liệu đầu vào gốc**. Các tham chiếu vòng (circular references) được định dạng an toàn thành `"[Circular]"`.

Theo mặc định (`DEFAULT_REDACT_KEYS`), Bunest tự động che các khóa khớp với (không phân biệt chữ hoa/thường hay dấu phân cách):

`password`, `passwd`, `secret`, `token`, `accessToken`, `refreshToken`, `apiKey`, `authorization`, `cookie`, `setCookie`, `privateKey`, `clientSecret`, `creditCard`, `ssn`, `jwt`, `bearer`, `sessionId`

```ts
const logger = new Logger("Auth", { json: true });
logger.log("Login attempt", {
  email: "ada@bunest.dev",
  password: "super-secret-value",
  headers: new Headers({ Authorization: "Bearer eyJ..." }),
});
// Output:
// {"timestamp":"...","level":"log","context":"Auth","message":"Login attempt",
//  "meta":{"email":"ada@bunest.dev","password":"[REDACTED]","headers":{"authorization":"[REDACTED]"}}}
```

> tip **Tùy chỉnh `LoggerService`** Triển khai interface `LoggerService` (`log`, `error`, `warn`, `debug?`, `verbose?`, `fatal?`) và truyền vào `Logger.overrideLogger(myLogger)` để định tuyến log của Bunest qua Pino, Winston hoặc OpenTelemetry.
