import { BunestFactory } from "@bunest/core";
import { TcpServer } from "@bunest/microservices";
import {
  createMathGatewayModule,
  createMathServerModule,
} from "./app.module";

const tcpHost = Bun.env.TCP_HOST ?? "127.0.0.1";
const tcpPort = Number(Bun.env.TCP_PORT ?? 8877);
const httpPort = Number(Bun.env.PORT ?? 3000);

const tcpServer = new TcpServer({ host: tcpHost, port: tcpPort });
const workerCtx = await BunestFactory.createApplicationContext(
  createMathServerModule(tcpServer),
);
await workerCtx.init();

const httpApp = await BunestFactory.create(
  createMathGatewayModule(tcpHost, tcpServer.port!),
);
await httpApp.listen(httpPort);

console.log(`TCP microservice listening on ${tcpHost}:${tcpServer.port}`);
console.log(`HTTP gateway listening on http://localhost:${httpPort}`);
