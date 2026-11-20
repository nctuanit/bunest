# @bunest/microservices

Bun-native microservice transports, RPC message/event patterns, and client proxies for **Bunest** with zero external runtime dependencies. Supports TCP, in-memory, gRPC, Redis, NATS, RabbitMQ, Kafka, and MQTT transports.

## Features

- **Multi-Transport Support**: Built-in `Transport` enum covering `TCP`, `REDIS`, `NATS`, `MQTT`, `GRPC`, `RMQ`, `KAFKA`, and `IN_MEMORY` servers and client proxies.
- **Declarative Pattern Routing**: `@MessagePattern()`, `@EventPattern()`, `@Payload()`, `@Ctx()`, and gRPC decorators (`@GrpcMethod()`, `@GrpcStreamMethod()`, `@GrpcStreamCall()`, `@GrpcService()`).
- **DI Client Management**: Register and inject typed `ClientProxy` instances via `ClientsModule.register()` / `registerAsync()`, `ClientProxyFactory`, and `@Client()`.
- **Custom Serialization & Framing**: `Serializer` / `Deserializer` interfaces, `FrameDecoder`, `JsonSocket`, gRPC framing/codecs, and broker record builders (`RedisRecordBuilder`, `NatsRecordBuilder`, `RmqRecordBuilder`, `MqttRecordBuilder`).
- **RPC Exceptions & Filters**: `RpcException`, `RpcTimeoutException`, `BaseRpcExceptionFilter`, and full gRPC status exceptions (`GrpcException`, `GrpcNotFoundException`, `GrpcExceptionFilter`, etc.).

## Installation

```bash
bun add @bunest/microservices
```

## Quick Start

```ts
import { Controller, Inject, Module } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  ClientProxy,
  ClientsModule,
  EventPattern,
  MessagePattern,
  Payload,
  Transport,
} from "@bunest/microservices";

@Controller()
export class MathController {
  @MessagePattern({ cmd: "sum" })
  sum(@Payload() data: number[]): number {
    return data.reduce((a, b) => a + b, 0);
  }

  @EventPattern("math.logged")
  handleLog(@Payload() payload: { total: number }) {
    console.log("Logged total:", payload.total);
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
  controllers: [MathController],
})
export class AppModule {
  constructor(@Inject("MATH_SERVICE") readonly client: ClientProxy) {}
}

const app = await BunestFactory.createMicroservice(AppModule, {
  transport: Transport.TCP,
  options: { host: "127.0.0.1", port: 4001 },
});
await app.listen();
```

## Key Exports

- **Modules & Host**: `ClientsModule`, `MicroserviceModule`, `MicroserviceHost`, `NestMicroservice`, `ClientProxyFactory`, `createClientProxy`, `createTransportServer`
- **Decorators**: `MessagePattern`, `EventPattern`, `Payload`, `Ctx`, `Client`, `GrpcMethod`, `GrpcStreamMethod`, `GrpcStreamCall`, `GrpcService`
- **Transports & Proxies**: `Transport`, `ClientProxy`, `Server`, `ServerTCP` / `ClientTCP`, `InMemoryServer` / `InMemoryClientProxy` / `InMemoryBroker`, `ServerRedis` / `ClientRedis`, `ServerNats` / `ClientNats`, `ServerRMQ` / `ClientRMQ`, `ServerKafka` / `ClientKafka`, `ServerMqtt` / `ClientMqtt`, `ServerGrpc` / `ClientGrpcProxy`
- **Contexts & Exceptions**: `RpcExecutionContext`, `BaseRpcContext`, `TcpContext`, `RedisContext`, `NatsContext`, `RmqContext`, `KafkaContext`, `MqttContext`, `GrpcContext`, `RpcException`, `RpcTimeoutException`, `BaseRpcExceptionFilter`, `GrpcException`, `GrpcExceptionFilter`, `GrpcStatus`
- **Record Builders & Codecs**: `RedisRecordBuilder`, `NatsRecordBuilder`, `RmqRecordBuilder`, `MqttRecordBuilder`, `IdentitySerializer`, `IdentityDeserializer`, `KafkaRequestSerializer`, `KafkaRequestDeserializer`, `FrameDecoder`, `JsonSocket`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
