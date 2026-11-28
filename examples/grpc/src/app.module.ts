import { Module } from "@bunest/core";
import {
  ClientsModule,
  GrpcServer,
  MicroserviceModule,
  Transport,
} from "@bunest/microservices";
import { HeroGrpcController } from "./hero/hero-grpc.controller";
import { HeroHttpController } from "./hero/hero-http.controller";
import { HERO_GRPC_CLIENT } from "./hero/hero.interface";

export function createHeroGrpcServerModule(server: GrpcServer) {
  @Module({
    imports: [MicroserviceModule.forRoot({ server })],
    controllers: [HeroGrpcController],
  })
  class HeroGrpcServerModule {}

  return HeroGrpcServerModule;
}

export function createHeroHttpGatewayModule(grpcUrl: string) {
  @Module({
    imports: [
      ClientsModule.registerAsync([
        {
          name: HERO_GRPC_CLIENT,
          useFactory: () => ({
            transport: Transport.GRPC,
            options: {
              package: "hero",
              url: grpcUrl,
            },
          }),
        },
      ]),
    ],
    controllers: [HeroHttpController],
  })
  class HeroHttpGatewayModule {}

  return HeroHttpGatewayModule;
}
