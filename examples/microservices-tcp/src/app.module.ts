import { Module } from "@bunest/core";
import {
  ClientsModule,
  MicroserviceModule,
  TcpServer,
  Transport,
} from "@bunest/microservices";
import { MathGatewayController } from "./gateway/math-gateway.controller";
import { MathRpcController } from "./math/math-rpc.controller";
import { MATH_SERVICE } from "./math/math.constants";

export function createMathServerModule(server: TcpServer) {
  @Module({
    imports: [MicroserviceModule.forRoot({ server })],
    controllers: [MathRpcController],
  })
  class MathServerModule {}

  return MathServerModule;
}

export function createMathGatewayModule(host: string, port: number) {
  @Module({
    imports: [
      ClientsModule.registerAsync([
        {
          name: MATH_SERVICE,
          useFactory: () => ({
            transport: Transport.TCP,
            options: { host, port },
          }),
        },
      ]),
    ],
    controllers: [MathGatewayController],
  })
  class MathGatewayModule {}

  return MathGatewayModule;
}
