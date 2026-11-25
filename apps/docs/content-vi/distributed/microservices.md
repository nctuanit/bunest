# Microservices

**`@bunest/microservices`** cung cấp độ tương thích 100% với `@nestjs/microservices` v12 theo tinh chỉnh ADR (**144/144** export) mà không có bất kỳ dependency runtime bên ngoài nào—hỗ trợ request-response (`@MessagePattern`), hướng sự kiện (`@EventPattern`), gRPC (`@GrpcMethod`, `@GrpcStreamMethod`, `@GrpcStreamCall`), ứng dụng lai HTTP + microservice (`app.connectMicroservice()`), `*RecordBuilder`, `PreRequestHook` và `CustomTransportStrategy`.

## Cài đặt

```bash
bun add @bunest/microservices
```

## Các Transport được hỗ trợ

| Transport                                  | Enum                                              | Mô tả                                                                             |
| ------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| **TCP**                                    | `Transport.TCP`                                   | Transport socket TCP native của Bun với đóng khung JSON kèm tiền tố độ dài        |
| **InMemory**                               | `Transport.IN_MEMORY`                             | Transport nội tiến trình không qua mạng cho unit/integration test và modular monolith |
| **gRPC**                                   | `Transport.GRPC`                                  | Service handler gRPC dạng unary và streaming (`@GrpcMethod`, `@GrpcStreamCall`)   |
| **Redis / NATS / RabbitMQ / Kafka / MQTT** | `Transport.REDIS`, `NATS`, `RMQ`, `KAFKA`, `MQTT` | Transport broker có thể cắm thêm, nhận các interface client định kiểu sẵn         |

## Ứng dụng lai & Message Handler

@@filename(math.controller.ts)

```ts
import { Controller } from "@bunest/core";
import { EventPattern, MessagePattern, Payload } from "@bunest/microservices";

@Controller()
export class MathController {
  @MessagePattern({ cmd: "sum" })
  accumulate(@Payload() numbers: number[]): number {
    return numbers.reduce((a, b) => a + b, 0);
  }

  @EventPattern("user.created")
  async handleUserCreated(@Payload() data: { id: string; email: string }) {
    // Handle asynchronous domain event
  }
}
```

@@filename(main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { Transport } from "@bunest/microservices";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
app.connectMicroservice({
  transport: Transport.TCP,
  options: { host: "127.0.0.1", port: 4001 },
});

await app.startAllMicroservices();
await app.listen(3000);
```

## Gọi Service với `ClientsModule`

Đăng ký `ClientsModule.register([{ name: "MATH_SERVICE", transport: Transport.TCP, options: { port: 4001 } }])`, inject `ClientProxy` và gọi `send({ cmd: "sum" }, [1, 2, 3])` hoặc `emit("user.created", payload)`.
