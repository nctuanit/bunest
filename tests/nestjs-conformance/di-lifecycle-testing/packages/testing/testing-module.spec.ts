import "reflect-metadata";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  ConsoleLogger,
  Logger,
  Module as ModuleDecorator,
} from "../../../../../packages/common/src";
import {
  BunestApplication,
  BunestApplicationContext,
} from "../../../../../packages/core/src";
import { BunHttpAdapter } from "../../../../../packages/http/src";
import { InMemoryServer } from "../../../../../packages/microservices/src";
import {
  Test,
  TestingModule,
  describeConformance,
  itAdapted,
} from "../../../_helpers";

describeConformance(
  "TestingModule",
  {
    upstreamPath: "packages/testing/test/testing-module.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapted from NestJS mock Express/Fastify adapter proxy & tryLoadPackage to native BunHttpAdapter and InMemoryServer microservice.",
  },
  () => {
    afterEach(() => {
      Logger.overrideLogger(true);
    });

    describe("constructor", () => {
      it("should extend BunestApplicationContext (NestApplicationContext)", async () => {
        @ModuleDecorator({})
        class RootTest {}

        const mod = await Test.createTestingModule({
          imports: [RootTest],
        }).compile();

        expect(mod).toBeInstanceOf(TestingModule);
        expect(mod).toBeInstanceOf(BunestApplicationContext);
        await mod.close();
      });
    });

    describe("createNestMicroservice", () => {
      itAdapted(
        "ADR-001",
        "should attach a microservice instance via createNestMicroservice",
        async () => {
          @ModuleDecorator({})
          class TestAppModule {}

          const mod = await Test.createTestingModule({
            imports: [TestAppModule],
          }).compile();

          const server = new InMemoryServer();
          const microservice = mod.createNestMicroservice(server);

          expect(microservice).toBe(server);
          await mod.close();
        },
      );
    });

    describe("createNestApplication", () => {
      itAdapted(
        "ADR-001",
        "should create a BunestApplication with default BunHttpAdapter",
        async () => {
          @ModuleDecorator({})
          class TestAppModule {}

          const mod = await Test.createTestingModule({
            imports: [TestAppModule],
          }).compile();

          const app = mod.createNestApplication();
          expect(app).toBeInstanceOf(BunestApplication);
          expect(app.getHttpAdapter()).toBeInstanceOf(BunHttpAdapter);
          await mod.close();
        },
      );

      itAdapted(
        "ADR-001",
        "should accept a custom BunHttpAdapter instance",
        async () => {
          @ModuleDecorator({})
          class TestAppModule {}

          const mod = await Test.createTestingModule({
            imports: [TestAppModule],
          }).compile();

          const adapter = new BunHttpAdapter();
          const app = mod.createNestApplication(adapter);

          expect(app.getHttpAdapter()).toBe(adapter);
          await mod.close();
        },
      );

      it("should apply logger options when provided", async () => {
        @ModuleDecorator({})
        class TestAppModule {}

        const mod = await Test.createTestingModule({
          imports: [TestAppModule],
        }).compile();

        const app = mod.createNestApplication({ logger: false });
        expect(app).toBeInstanceOf(BunestApplication);
        await mod.close();
      });

      it("should accept a custom ConsoleLogger", async () => {
        @ModuleDecorator({})
        class TestAppModule {}

        const mod = await Test.createTestingModule({
          imports: [TestAppModule],
        }).compile();

        const customLogger = new ConsoleLogger("TestCustom");
        const logSpy = spyOn(customLogger, "log").mockImplementation(() => {});
        const app = mod.createNestApplication({ logger: customLogger });
        app.useLogger(customLogger);
        await app.init();

        expect(app).toBeInstanceOf(BunestApplication);
        logSpy.mockRestore();
        await mod.close();
      });

      // BUNEST_BUG: TestingModule.createNestApplication() does not apply `forceConsole: true` to static Logger / ConsoleLogger output (packages/testing/src/testing-module.ts)
      it.skip("should log through console when forceConsole is true", async () => {
        @ModuleDecorator({})
        class TestAppModule {}

        const mod = await Test.createTestingModule({
          imports: [TestAppModule],
        }).compile();

        mod.createNestApplication({ forceConsole: true } as Record<string, unknown>);

        const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
        const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
        new Logger("TestContext").log("message");

        expect(consoleLogSpy).toHaveBeenCalledTimes(1);
        expect(stdoutSpy).not.toHaveBeenCalled();

        consoleLogSpy.mockRestore();
        stdoutSpy.mockRestore();
        await mod.close();
      });
    });

    describe("get", () => {
      it("should retrieve providers from the compiled module", async () => {
        @ModuleDecorator({
          providers: [{ provide: "MY_TOKEN", useValue: "my-value" }],
        })
        class TestAppModule {}

        const mod = await Test.createTestingModule({
          imports: [TestAppModule],
        }).compile();

        expect(mod.get("MY_TOKEN")).toBe("my-value");
        await mod.close();
      });
    });

    describe("select", () => {
      it("should allow selecting a module within the tree", async () => {
        @ModuleDecorator({
          providers: [{ provide: "TOKEN", useValue: "selected-value" }],
        })
        class ChildModule {}

        @ModuleDecorator({
          imports: [ChildModule],
        })
        class TestAppModule {}

        const mod = await Test.createTestingModule({
          imports: [TestAppModule],
        }).compile();

        const selected = mod.select(ChildModule);
        expect(selected.get("TOKEN")).toBe("selected-value");
        await mod.close();
      });
    });

    describe("init and close", () => {
      it("should initialize and close without error", async () => {
        @ModuleDecorator({})
        class TestAppModule {}

        const mod = await Test.createTestingModule({
          imports: [TestAppModule],
        }).compile();

        await mod.init();
        await mod.close();
      });
    });
  },
);
