# Microservices

**`@bunest/microservices`** provides 100% ADR-adjusted `@nestjs/microservices` v12 parity (**144/144** exports) with zero external runtime dependencies—supporting request-response (`@MessagePattern`), event-driven (`@EventPattern`), gRPC (`@GrpcService`, `@GrpcMethod`, `@GrpcStreamMethod`, `@GrpcStreamCall`), hybrid HTTP + microservice apps (`app.connectMicroservice()`), `*RecordBuilder`, `PreRequestHook`, and `CustomTransportStrategy`.

## Installation

```bash
bun add @bunest/microservices
```

## Supported Transports

| Transport | Enum | Description |
| --- | --- | --- |
| **TCP** | `Transport.TCP` | Native Bun TCP socket transport with length-prefixed JSON framing |
| **InMemory** | `Transport.IN_MEMORY` | Zero-network in-process transport for unit/integration tests and modular monoliths |
| **gRPC** | `Transport.GRPC` | Unary and streaming gRPC service handlers (`@GrpcMethod`, `@GrpcStreamCall`) |
| **Redis / NATS / RabbitMQ / Kafka / MQTT** | `Transport.REDIS`, `NATS`, `RMQ`, `KAFKA`, `MQTT` | Pluggable broker transports accepting typed client interfaces |

## Message & Event Handlers

Use `@MessagePattern()` for request-response RPC calls and `@EventPattern()` for fire-and-forget domain events. Extract validated payloads with `@Payload()` and transport metadata with `@Ctx()`:

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
    console.log("Provisioning resources for", data.email);
  }
}
```

## Standalone vs Hybrid Applications

@@filename(main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { Transport } from "@bunest/microservices";
import { AppModule } from "./app.module";

// Hybrid app: serves HTTP on :3000 AND TCP microservice on :4001
const app = await BunestFactory.create(AppModule);
app.connectMicroservice({
  transport: Transport.TCP,
  options: { host: "127.0.0.1", port: 4001 },
});

await app.startAllMicroservices();
await app.listen(3000);
```

## Calling Services with `ClientsModule`

Register typed clients in any consuming module and call `send()` (request-response) or `emit()` (event):

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

## Error Handling (`RpcException`) & Custom Transports

- Throw `new RpcException("Invalid payload")` inside handlers and catch RPC errors with `@UseFilters()` + `BaseRpcExceptionFilter`.
- Implement `CustomTransportStrategy` (`listen()` + `close()`) to plug in proprietary message buses or WebSocket RPC protocols.
