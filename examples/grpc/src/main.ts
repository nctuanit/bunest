import { BunestFactory } from "@bunest/core";
import { GrpcServer } from "@bunest/microservices";
import {
  createHeroGrpcServerModule,
  createHeroHttpGatewayModule,
} from "./app.module";

const grpcPort = Number(Bun.env.GRPC_PORT ?? 50051);
const httpPort = Number(Bun.env.PORT ?? 3000);

const grpcServer = new GrpcServer({
  host: "127.0.0.1",
  port: grpcPort,
  package: "hero",
});
const grpcCtx = await BunestFactory.createApplicationContext(
  createHeroGrpcServerModule(grpcServer),
);
await grpcCtx.init();

const httpApp = await BunestFactory.create(
  createHeroHttpGatewayModule(grpcServer.url!),
);
await httpApp.listen(httpPort);

console.log(`Hero gRPC server listening on ${grpcServer.url}`);
console.log(`HTTP gateway listening on http://localhost:${httpPort}`);
