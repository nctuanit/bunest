import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from "../../../../../packages/core/src/common";
import {
  NestFactory,
  type BunestApplication,
  type BunestMicroserviceApplication,
} from "../../../../../packages/core/src";
import {
  MicroserviceHost,
  MicroserviceModule,
  MicroserviceTransportServer,
  Transport,
  type CustomTransportStrategy,
} from "../../../../../packages/microservices/src";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";

class NoopTransport
  extends MicroserviceTransportServer
  implements CustomTransportStrategy
{
  readonly transport = Transport.IN_MEMORY;

  async listen(callback?: () => void): Promise<void> {
    this.listening = true;
    callback?.();
  }

  async close(): Promise<void> {
    this.listening = false;
  }

  override unwrap<T>(): T {
    return null as T;
  }
}

@Injectable()
class HooksTracker implements OnModuleInit, OnApplicationBootstrap {
  moduleInit = 0;
  applicationBootstrap = 0;

  onModuleInit() {
    this.moduleInit++;
  }

  onApplicationBootstrap() {
    this.applicationBootstrap++;
  }
}

const createHooksModule = () => {
  @Module({
    imports: [MicroserviceModule.forRoot({ strategy: new NoopTransport() })],
    providers: [HooksTracker],
  })
  class HooksMicroserviceModule {}

  return HooksMicroserviceModule;
};

describeConformance(
  "Init hooks",
  {
    upstreamPath: "integration/microservices/e2e/init-hooks.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Uses Bunest MicroserviceTransportServer/CustomTransportStrategy with NestFactory.createMicroservice and hybrid BunestApplication.",
  },
  () => {
    describe("of a microservice", () => {
      let microservice:
        BunestMicroserviceApplication<MicroserviceHost> | undefined;

      afterEach(async () => {
        await microservice?.close();
        microservice = undefined;
      });

      itAdapted(
        "ADR-001",
        "should be called once by init()",
        async () => {
          const Mod = createHooksModule();
          microservice = await NestFactory.createMicroservice(
            Mod,
            (ctx) => ctx.get(MicroserviceHost),
            { logger: false },
          );

          await microservice.init();
          await microservice.listen();

          expect(microservice.get(HooksTracker)).toMatchObject({
            moduleInit: 1,
            applicationBootstrap: 1,
          });
        },
        "NestFactory.createMicroservice + MicroserviceHost",
      );

      itAdapted(
        "ADR-001",
        "should be called once by listen()",
        async () => {
          const Mod = createHooksModule();
          microservice = await NestFactory.createMicroservice(
            Mod,
            (ctx) => ctx.get(MicroserviceHost),
            { logger: false },
          );

          await microservice.listen();

          expect(microservice.get(HooksTracker)).toMatchObject({
            moduleInit: 1,
            applicationBootstrap: 1,
          });
        },
        "NestFactory.createMicroservice + MicroserviceHost",
      );
    });

    describe("of a hybrid application with a deferred microservice", () => {
      let moduleRef: TestingModule | undefined;
      let app: BunestApplication | undefined;

      beforeEach(async () => {
        moduleRef = await Test.createTestingModule({
          providers: [HooksTracker],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        app.connectMicroservice(
          new NoopTransport(),
          // deferInitialization is checked by the skipped conformance test below
          { deferInitialization: true } as Record<string, unknown>,
        );
      });

      afterEach(async () => {
        await app?.close();
        await moduleRef?.close();
        app = undefined;
        moduleRef = undefined;
      });

      it("should be called once, by the application, when the microservice starts first", async () => {
        await app!.startAllMicroservices();
        expect(app!.get(HooksTracker)).toMatchObject({
          moduleInit: 0,
          applicationBootstrap: 0,
        });

        await app!.init();
        expect(app!.get(HooksTracker)).toMatchObject({
          moduleInit: 1,
          applicationBootstrap: 1,
        });
      });

      it("should be called once when the application starts first", async () => {
        await app!.init();
        await app!.startAllMicroservices();

        expect(app!.get(HooksTracker)).toMatchObject({
          moduleInit: 1,
          applicationBootstrap: 1,
        });
      });
    });
  },
);
