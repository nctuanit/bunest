# Microservices — TCP (`03-microservices`)

Bunest counterpart of NestJS's [`sample/03-microservices`](https://github.com/nestjs/nest/tree/master/sample/03-microservices), powered by `@bunest/microservices` over native `Bun.listen()` / `Bun.connect()` TCP sockets:

- **TCP Worker (`MicroserviceModule.forRoot`)**: Handles `@MessagePattern({ cmd: "sum" })`, `@MessagePattern({ cmd: "multiply" })`, and `@EventPattern("math.computed")`
- **HTTP Gateway (`ClientsModule.registerAsync`)**: Exposes `POST /math/sum`, `POST /math/multiply`, and `POST /math/notify`, forwarding over `Transport.TCP`
- **Structured RPC Errors**: Propagates `RpcException` cleanly across the TCP wire

## Run

```bash
bun run --cwd examples/microservices-tcp dev
bun run --cwd examples/microservices-tcp test
```
