# gRPC Microservice (`04-grpc`)

Bunest counterpart of NestJS's [`sample/04-grpc`](https://github.com/nestjs/nest/tree/master/sample/04-grpc), powered by zero-dependency `@bunest/microservices` gRPC framing over native `Bun.serve()`:

- **Unary RPC (`@GrpcMethod("HeroService", "FindOne")`)**: Supports request/response `GrpcMetadata` and structured `GrpcException(GrpcStatus.NOT_FOUND)`
- **Server-Streaming RPC (`@GrpcStreamMethod("HeroService", "FindMany")`)**: Native `async *` generator streaming multiple heroes over 5-byte gRPC wire frames
- **HTTP Gateway (`ClientsModule` + `GrpcClientProxy`)**: Bridges `GET /hero/:id` and `GET /hero` to the live gRPC service

## Run

```bash
bun run --cwd examples/grpc dev
bun run --cwd examples/grpc test
```
