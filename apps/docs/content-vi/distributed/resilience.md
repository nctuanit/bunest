# Resilience

**`@bunest/resilience`** cung cấp các chính sách chịu lỗi không dependency ngoài—**Retry**, **Timeout**, **Circuit Breaker**, **Bulkhead**, **Outbound Rate Limit** và **Fallback**—hoạt động mượt mà trên **cả** các điểm vào transport (HTTP/GraphQL/WebSocket/Microservice handler) **lẫn** các phương thức service `@Injectable()` thông qua `MethodAspectWeaver`, đảm bảo không bao giờ bọc trùng (double-wrapping).

## Cài đặt

```bash
bun add @bunest/resilience
```

## Thiết lập Module

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ResilienceModule } from "@bunest/resilience";

@Module({
  imports: [ResilienceModule.forRoot()],
})
export class AppModule {}
```

## Chính sách khai báo ở tầng Service

Xếp chồng các resilience decorator trực tiếp lên phương thức service `@Injectable()`:

@@filename(payment-gateway.service.ts)

```ts
import { Injectable } from "@bunest/core";
import {
  Bulkhead,
  CircuitBreaker,
  Fallback,
  Retry,
  Timeout,
} from "@bunest/resilience";

@Injectable()
export class PaymentGatewayService {
  @Fallback({ fallback: () => ({ status: "queued_offline" }) })
  @CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 })
  @Retry({ maxAttempts: 3, delayMs: 200, backoff: "exponential" })
  @Timeout({ timeoutMs: 2_000 })
  @Bulkhead({ maxConcurrent: 20, maxQueue: 50 })
  async charge(orderId: string, amountCents: number) {
    const res = await fetch("https://payments.example.com/charge", {
      method: "POST",
      body: JSON.stringify({ orderId, amountCents }),
    });
    if (!res.ok) throw new Error(`Gateway error ${res.status}`);
    return res.json();
  }
}
```

> info **Không bọc trùng (No Double-Wrapping)** Khi đặt resilience decorator lên một route của HTTP controller, `ResilienceMethodAspectHandler` sẽ nhận diện điểm vào và nhường quyền thực thi cho `ResilienceInterceptor` để retry, timeout và bulkhead chỉ chạy **đúng một lần**.
