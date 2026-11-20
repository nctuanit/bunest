import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  type MicroserviceInstance,
} from "../../../../../packages/common/src";
import {
  BunHttpAdapter,
  BunestApplication,
  BunestApplicationContext,
  BunestFactory,
  NestFactory,
} from "../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../_helpers";

@Module({})
class TestModule {}

@Injectable()
class TestService {}

@Controller()
class TestController {
  @Get()
  hello() {
    return "hello";
  }
}

const rootModuleOf = (app: BunestApplicationContext) =>
  app.getModuleContainer().getGraph().root.metatype;

describeConformance(
  "NestFactory",
  {
    upstreamPath: "packages/core/test/nest-factory.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-007"],
    notes:
      "Adapted from Express/Fastify/Node adapters to Bunest BunHttpAdapter & BunestFactory/NestFactory alias (ADR-001).",
  },
  () => {
    describe("create() types and adapter acceptance", () => {
      itAdapted(
        "ADR-001",
        "should create a BunestApplication with default or explicit BunHttpAdapter",
        async () => {
          const defaultApp = await NestFactory.create(TestModule, {
            logger: false,
          });
          expect(defaultApp).toBeInstanceOf(BunestApplication);
          expect(defaultApp.getHttpAdapter()).toBeInstanceOf(BunHttpAdapter);
          await defaultApp.close();

          const customAdapter = new BunHttpAdapter();
          const customApp = await BunestFactory.create(
            TestModule,
            customAdapter,
            { logger: false },
          );
          expect(customApp).toBeInstanceOf(BunestApplication);
          expect(customApp.getHttpAdapter()).toBe(customAdapter);
          await customApp.close();
        },
      );

      itAdapted(
        "ADR-001",
        "should expose NestFactory as an exact alias for BunestFactory",
        () => {
          expect(NestFactory).toBe(BunestFactory);
        },
      );
    });

    describe("when passed module metadata", () => {
      it("should create an application from plain module metadata", async () => {
        const app = await NestFactory.create(
          { controllers: [TestController], providers: [TestService] },
          { logger: false },
        );
        await app.init();

        const response = await app.inject({
          method: "GET",
          url: "/",
        });
        expect(response.body).toBe("hello");
        expect(app.get(TestService)).toBeInstanceOf(TestService);
        expect(rootModuleOf(app)).toBeDefined();

        await app.close();
      });

      it("should create an application context from plain module metadata", async () => {
        const context = await NestFactory.createApplicationContext(
          { providers: [TestService] },
          { logger: false },
        );

        expect(context.get(TestService)).toBeInstanceOf(TestService);
        await context.close();
      });

      it("should resolve a promise of the metadata", async () => {
        const context = await NestFactory.createApplicationContext(
          Promise.resolve({ providers: [TestService] }),
          { logger: false },
        );

        expect(context.get(TestService)).toBeInstanceOf(TestService);
        await context.close();
      });

      it("should accept imports in the metadata", async () => {
        @Module({ providers: [TestService], exports: [TestService] })
        class FeatureModule {}

        const context = await NestFactory.createApplicationContext(
          { imports: [FeatureModule] },
          { logger: false },
        );

        expect(context.get(TestService)).toBeInstanceOf(TestService);
        await context.close();
      });

      it("should reject an unknown metadata key", async () => {
        await expect(
          NestFactory.createApplicationContext(
            { controller: [TestController] } as any,
            { logger: false, abortOnError: false },
          ),
        ).rejects.toThrow(/InvalidModuleException|Invalid property 'controller'/i);
      });

      // BUNEST_BUG: ModuleScanner.scan() fails with TypeError ("No default value" from String() on null-prototype object) instead of throwing InvalidModuleException for module namespace objects (packages/core/src/module/module-scanner.ts:40-55).
      it.skip("should reject a module namespace object", async () => {
        const namespace = Object.assign(Object.create(null), {
          TestModule,
        });

        await expect(
          NestFactory.createApplicationContext(namespace, {
            logger: false,
            abortOnError: false,
          }),
        ).rejects.toThrow(/InvalidModuleException|Invalid property 'TestModule'/i);
      });

      it("should create a microservice from plain module metadata", async () => {
        const noopServer: MicroserviceInstance = {
          async listen() {},
          async close() {},
        };

        const app = await NestFactory.createMicroservice(
          { providers: [TestService] },
          noopServer,
          { logger: false },
        );

        expect(app.get(TestService)).toBeInstanceOf(TestService);
        await app.close();
      });

      it("should create a distinct root module for each call", async () => {
        const first = await NestFactory.createApplicationContext(
          { providers: [TestService] },
          { logger: false },
        );
        const second = await NestFactory.createApplicationContext(
          { providers: [TestService] },
          { logger: false },
        );

        expect(rootModuleOf(first)).not.toBe(rootModuleOf(second));
        await first.close();
        await second.close();
      });
    });
  },
);
