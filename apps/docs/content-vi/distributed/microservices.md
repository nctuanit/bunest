# Microservices

**`@bunest/microservices`** đạt 100% tương thích `@nestjs/microservices` v12 (**144/144** exports theo ADR) với 0 phụ thuộc ngoài — hỗ trợ request-response (`@MessagePattern`), hướng sự kiện (`@EventPattern`), gRPC (`@GrpcService`, `@GrpcMethod`, `@GrpcStreamMethod`, `@GrpcStreamCall`), ứng dụng lai HTTP + microservice (`app.connectMicroservice()`), `*RecordBuilder`, `PreRequestHook` và `CustomTransportStrategy`.

## Cài đặt

```bash
bun add @bunest/microservices
```

## Các Transport được hỗ trợ

| Transport | Enum | Mô tả |
| --- | --- | --- |
| **TCP** | `Transport.TCP` | TCP socket thuần Bun với framing JSON theo độ dài |
| **InMemory** | `Transport.IN_MEMORY` | Transport nội bộ không qua mạng cho kiểm thử và modular monolith |
| **gRPC** | `Transport.GRPC` | Handler gRPC dạng unary và streaming (`@GrpcMethod`, `@GrpcStreamCall`) |
| **Redis / NATS / RabbitMQ / Kafka / MQTT** | `Transport.REDIS`, `NATS`, `RMQ`, `KAFKA`, `MQTT` | Broker transport cắm rút linh hoạt qua interface có kiểu |

## Message & Event Handlers

Dùng `@MessagePattern()` cho RPC request-response và `@EventPattern()` cho sự kiện bất đồng bộ. Lấy dữ liệu bằng `@Payload()` và ngữ cảnh transport bằng `@Ctx()`:

@@filename(math.controller.ts)

```ts
import { Controller, ParseArrayPipe } from "@bunest/core";
import {
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
  type TcpContext,
} from "@bunest/microservices";

@Controller()
export class MathController {
  @MessagePattern({ cmd: "sum" })
  accumulate(
    @Payload(new ParseArrayPipe({ items: Number })) numbers: number[],
    @Ctx() ctx: TcpContext,
  ): number {
    return numbers.reduce((a, b) => a + b, 0);
  }

  @EventPattern("user.created")
  async handleUserCreated(@Payload() data: { id: string; email: string }) {
    console.log("Khởi tạo tài nguyên cho", data.email);
  }
}
```

## Ứng dụng Lai (Hybrid Application)

@@filename(main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { MicroserviceHost } from "@bunest/microservices";
import { AppModule } from "./app.module";

// Chạy song song HTTP trên :3000 và TCP microservice trên :4001
// AppModule imports MicroserviceModule.forRoot({ transport: Transport.TCP, options: { port: 4001 } }).
const app = await BunestFactory.create(AppModule);
app.connectMicroservice(app.get(MicroserviceHost));

await app.startAllMicroservices();
await app.listen(3000);
```

## Gọi Service khác với `ClientsModule`

@@filename(orders.module.ts)

```ts
import { Inject, Injectable, Module } from "@bunest/core";
import {
  ClientsModule,
  Transport,
  type ClientProxy,
} from "@bunest/microservices";

@Injectable()
export class OrdersClient {
  constructor(
    @Inject("MATH_SERVICE") private readonly client: ClientProxy,
  ) {}

  async computeTotal(items: number[]): Promise<number> {
    return this.client.send<number>({ cmd: "sum" }, items);
  }

  async notifyCreated(id: string, email: string): Promise<void> {
    await this.client.emit("user.created", { id, email });
  }
}

@Module({
  imports: [
    ClientsModule.register([
      {
        name: "MATH_SERVICE",
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port: 4001 },
      },
    ]),
  ],
  providers: [OrdersClient],
})
export class OrdersModule {}
```

## Xử lý lỗi (`RpcException`) & Custom Transport

- Ném `new RpcException("Invalid payload")` trong handler và bắt lỗi RPC bằng `@UseFilters()` + `BaseRpcExceptionFilter`.
- Cài đặt `CustomTransportStrategy` (`listen()` + `close()`) để tích hợp message bus tùy chỉnh.
