# Microservices

**`@bunest/microservices`** provides 100% ADR-adjusted `@nestjs/microservices` v12 parity (**144/144** exports) with zero external runtime dependencies—supporting request-response (`@MessagePattern`), event-driven (`@EventPattern`), gRPC (`@GrpcMethod`, `@GrpcStreamMethod`, `@GrpcStreamCall`), hybrid HTTP + microservice apps (`app.connectMicroservice()`), `*RecordBuilder`, `PreRequestHook`, and `CustomTransportStrategy`.

## Installation

```bash
bun add @bunest/microservices
```

## Supported Transports

| Transport | Enum | Description |
|---|---|---|
| **TCP** | `Transport.TCP` | Native Bun TCP socket transport with length-prefixed JSON framing |
| **InMemory** | `Transport.IN_MEMORY` | Zero-network in-process transport for unit/integration tests and modular monoliths |
| **gRPC** | `Transport.GRPC` | Unary and streaming gRPC service handlers (`@GrpcMethod`, `@GrpcStreamCall`) |
| **Redis / NATS / RabbitMQ / Kafka / MQTT** | `Transport.REDIS`, `NATS`, `RMQ`, `KAFKA`, `MQTT` | Pluggable broker transports accepting typed client interfaces |

## Hybrid Application & Message Handlers

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
import "reflect-metadata";
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

## Calling Services with `ClientsModule`

Register `ClientsModule.register([{ name: "MATH_SERVICE", transport: Transport.TCP, options: { port: 4001 } }])`, inject `ClientProxy`, and call `send({ cmd: "sum" }, [1, 2, 3])` or `emit("user.created", payload)`.
