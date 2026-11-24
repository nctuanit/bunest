import { afterEach, beforeEach, expect } from "bun:test";
import {
  Controller,
  Injectable,
  Module,
} from "../../../../../packages/core/src/common";
import {
  DiscoveryService,
  MetadataScanner,
  ModuleRef,
  NestFactory,
  type BunestMicroserviceApplication,
} from "../../../../../packages/core/src";
import {
  ClientsModule,
  MessagePattern,
  MicroserviceHost,
  Payload,
  TcpClientProxy,
  Transport,
  createTransportServer,
  type TransportConfig,
} from "../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../_helpers";

function allocateEphemeralPort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
    },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

@Controller()
class RpcController {
  @MessagePattern({ cmd: "sum" })
  sumPayload(@Payload() payload: number[]) {
    return payload.reduce((a, b) => a + b, 0);
  }
}

describeConformance(
  "RPC Async transport",
  {
    upstreamPath: "integration/microservices/e2e/sum-rpc-async.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Uses NestFactory.createMicroservice async server factory resolving RpcOptionsProvider from DI, ephemeral port allocation, and Promise-based TcpClientProxy.send().",
  },
  () => {
    let app: BunestMicroserviceApplication<MicroserviceHost> | undefined;
    let client: TcpClientProxy | undefined;

    beforeEach(async () => {
      const port = allocateEphemeralPort();

      @Injectable()
      class RpcOptionsProvider {
        getOptions(): TransportConfig {
          return {
            transport: Transport.TCP,
            options: {
              port,
              host: "127.0.0.1",
            },
          };
        }
      }

      @Module({
        imports: [
          ClientsModule.register([
            {
              name: "RPC_CLIENT",
              transport: Transport.TCP,
              options: {
                port,
                host: "127.0.0.1",
              },
            },
          ]),
        ],
        controllers: [RpcController],
        providers: [RpcOptionsProvider],
      })
      class RpcModule {}

      app = await NestFactory.createMicroservice(
        RpcModule,
        async (ctx) => {
          const optionsProvider = ctx.get(RpcOptionsProvider);
          const server = createTransportServer(optionsProvider.getOptions());
          return new MicroserviceHost(
            ctx.get(ModuleRef),
            server,
            ctx.get(DiscoveryService),
            ctx.get(MetadataScanner),
          );
        },
        { logger: false },
      );

      await app.listen();
      client = app.get<TcpClientProxy>("RPC_CLIENT", { strict: false });
    });

    afterEach(async () => {
      await client?.close();
      client = undefined;
      await app?.close();
      app = undefined;
    });

    itAdapted(
      ["ADR-001", "ADR-008"],
      "/POST",
      async () => {
        const retData = await client!.send<number>(
          { cmd: "sum" },
          [1, 2, 3, 4, 5],
        );
        expect(retData).toBe(15);
      },
      "Promise-based TcpClientProxy.send()",
    );
  },
);
