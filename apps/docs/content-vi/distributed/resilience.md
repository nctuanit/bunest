# Độ tin cậy & Chịu lỗi (Resilience)

**`@bunest/resilience`** cung cấp bộ chính sách chịu lỗi zero-dependency — **Retry**, **Timeout**, **Circuit Breaker**, **Bulkhead**, **Outbound Rate Limit** và **Fallback** — hoạt động đồng nhất trên **cả** entrypoint (HTTP/GraphQL/WebSocket/Microservice) **lẫn** method của `@Injectable()` service qua `MethodAspectWeaver`, đảm bảo không bao giờ bị bọc trùng (zero double-wrapping).

## Cài đặt

```bash
bun add @bunest/resilience
```

## Cấu hình Module

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ResilienceModule } from "@bunest/resilience";

@Module({
  imports: [ResilienceModule.forRoot()],
})
export class AppModule {}
```

## Bảng tra cứu Policy Decorators

| Decorator | Công dụng | Tùy chọn chính |
| --- | --- | --- |
| `@Retry(options)` | Thử lại khi gặp lỗi tạm thời với backoff cố định/hàm mũ + jitter | `attempts`, `delayMs`, `backoff`, `retryIf` |
| `@Timeout(options)` | Hủy tác vụ quá hạn và truyền `AbortSignal` xuống bên dưới | `timeoutMs` |
| `@CircuitBreaker(options)` | Ngắt mạch khi lỗi liên tiếp để chặn hiệu ứng domino | `failureRateThreshold`, `openDuration`, `halfOpenMaxCalls` |
| `@Bulkhead(options)` | Giới hạn số lời gọi song song và hàng đợi để cô lập dịch vụ chậm | `maxConcurrent`, `maxQueue` |
| `@Fallback(handler)` | Trả về giá trị dự phòng khi các policy phía trên thất bại | `(err, ...args) => ...` |
| `@Signal()` | Inject `AbortSignal` do `@Timeout()` quản lý vào tham số hàm | — |
| `@Resilience(policy)` | Áp dụng một bộ policy tái sử dụng theo tên | tên policy hoặc object cấu hình |

## Kết hợp Policy trên Service Method

Xếp chồng decorator từ ngoài vào trong (Fallback → Circuit Breaker → Retry → Timeout → Bulkhead) và truyền `@Signal()` trực tiếp vào `fetch()`:

@@filename(payment-gateway.service.ts)

```ts
import { Injectable } from "@bunest/core";
import {
  Bulkhead,
  CircuitBreaker,
  Fallback,
  Retry,
  Signal,
  Timeout,
} from "@bunest/resilience";

@Injectable()
export class PaymentGatewayService {
  @Fallback(() => ({ status: "queued_offline" }))
  @CircuitBreaker({ failureRateThreshold: 50, openDuration: 30_000 })
  @Retry({ attempts: 3, backoff: { delay: 200, factor: 2 } })
  @Timeout(2_000)
  @Bulkhead({ maxConcurrent: 20, maxQueue: 50 })
  async charge(
    orderId: string,
    amountCents: number,
    @Signal() signal?: AbortSignal,
  ) {
    const res = await fetch("https://payments.example.com/charge", {
      method: "POST",
      signal,
      body: JSON.stringify({ orderId, amountCents }),
    });
    if (!res.ok) throw new Error(`Gateway error ${res.status}`);
    return res.json();
  }
}
```

## Hủy tác vụ chủ động với `@Signal()`

Khi `@Timeout()` hết hạn, `AbortController` gắn với lời gọi sẽ kích hoạt `abort()`. Việc truyền `@Signal()` vào `fetch()`, `Bun.SQL` hay tác vụ async giúp hủy ngay kết nối đang treo thay vì để rò rỉ tài nguyên ngầm.

> info **Không bọc trùng (No Double-Wrapping)** Khi đặt resilience decorator trực tiếp lên HTTP controller route, `ResilienceMethodAspectHandler` sẽ tự nhận diện entrypoint và nhường cho `ResilienceInterceptor` để retry, timeout và bulkhead chỉ chạy **đúng một lần**.
