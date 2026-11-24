import { afterEach, expect } from "bun:test";
import { Controller, Module } from "../../../../../packages/core/src/common";
import {
  NestFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  TcpServer,
} from "../../../../../packages/microservices/src";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";

@Controller()
class SumController {
  @MessagePattern({ cmd: "sum" })
  sum(data: number[]): number {
    return (data || []).reduce((a, b) => a + b, 0);
  }
}

@Module({
  controllers: [SumController],
})
class HybridAppModule {}

describeConformance(
  "Hybrid application shutdown hooks",
  {
    upstreamPath: "integration/microservices/e2e/hybrid-shutdown-hooks.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Connects a BunestMicroserviceApplication (backed by ephemeral port: 0 TcpServer + MicroserviceHost) to a hybrid BunestApplication and verifies SIGTERM process listeners are removed on app.close().",
  },
  () => {
    let moduleRef: TestingModule | undefined;
    let app: BunestApplication | undefined;

    afterEach(async () => {
      await app?.close();
      await moduleRef?.close();
      app = undefined;
      moduleRef = undefined;
    });

    itAdapted(
      "ADR-001",
      "should remove the process signal listeners registered by a connected microservice",
      async () => {
        const baseline = process.listenerCount("SIGTERM");

        moduleRef = await Test.createTestingModule({
          imports: [HybridAppModule],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });

        const tcpServer = new TcpServer({ host: "127.0.0.1", port: 0 });

        @Module({
          imports: [MicroserviceModule.forRoot({ server: tcpServer })],
          controllers: [SumController],
        })
        class TcpMicroserviceModule {}

        const microservice = await NestFactory.createMicroservice(
          TcpMicroserviceModule,
          (ctx) => ctx.get(MicroserviceHost),
          { logger: false },
        );

        app.connectMicroservice(microservice);

        microservice.enableShutdownHooks(["SIGTERM"]);
        expect(process.listenerCount("SIGTERM")).toBe(baseline + 1);

        await app.startAllMicroservices();
        await app.init();

        expect(tcpServer.isListening).toBe(true);
        expect(tcpServer.port).toBeGreaterThan(0);

        await app.close();
        await moduleRef.close();
        app = undefined;
        moduleRef = undefined;

        expect(tcpServer.isListening).toBe(false);
        expect(process.listenerCount("SIGTERM")).toBe(baseline);
      },
      "ephemeral port: 0 native TcpServer + BunestMicroserviceApplication",
    );
  },
);
