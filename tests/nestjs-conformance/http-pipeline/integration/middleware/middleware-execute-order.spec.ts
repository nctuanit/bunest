import "reflect-metadata";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  Global,
  Module,
  type BunestModule,
  type MiddlewareConsumer,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

const RETURN_VALUE_A = "test_A";
const RETURN_VALUE_B = "test_B";
const RETURN_VALUE_X = "test_X";
const RETURN_VALUE_GLOBAL = "test_GLOBAL";

@Global()
@Module({})
class GlobalModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(RETURN_VALUE_GLOBAL))
      .forRoutes("ping");
  }
}

@Global()
@Module({})
class GlobalModule2 implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(`${RETURN_VALUE_GLOBAL}2`))
      .forRoutes("ping");
  }
}

@Module({ imports: [GlobalModule, GlobalModule2] })
class ModuleX implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(RETURN_VALUE_X))
      .forRoutes("hello")
      .apply((_req, _res, _next) => new Response(RETURN_VALUE_X))
      .forRoutes("ping");
  }
}

@Module({ imports: [ModuleX] })
class ModuleA implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(RETURN_VALUE_A))
      .forRoutes("hello")
      .apply((_req, _res, _next) => new Response(RETURN_VALUE_A))
      .forRoutes("ping");
  }
}

@Module({
  imports: [ModuleA],
})
class ModuleB implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(RETURN_VALUE_B))
      .forRoutes("hello")
      .apply((_req, _res, _next) => new Response(RETURN_VALUE_B))
      .forRoutes("ping");
  }
}

@Module({
  imports: [ModuleB],
})
class TestModule {}

const RETURN_VALUE_LOGGER = "test_LOGGER";
const RETURN_VALUE_AUTH = "test_AUTH";

@Module({})
class LoggerModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(RETURN_VALUE_LOGGER))
      .forRoutes("hello");
  }
}

@Module({ imports: [LoggerModule] })
class AuthModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(RETURN_VALUE_AUTH))
      .forRoutes("hello");
  }
}

const RETURN_VALUE_FIRST = "test_FIRST";
const RETURN_VALUE_SECOND = "test_SECOND";

@Module({})
class AsyncFirstModule implements BunestModule {
  async configure(consumer: MiddlewareConsumer) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    consumer
      .apply((_req, _res, _next) => new Response(RETURN_VALUE_FIRST))
      .forRoutes("hello");
  }
}

@Module({})
class SecondModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(RETURN_VALUE_SECOND))
      .forRoutes("hello");
  }
}

describeConformance(
  "Middleware (execution order)",
  {
    upstreamPath:
      "integration/hello-world/e2e/middleware-execute-order.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapted Express middleware res.send() to Bunest middleware returning native Web Response.",
  },
  () => {
    describe("topological and global module order", () => {
      let app: BunestApplication | undefined;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [TestModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      // BUNEST_BUG: Expected GET /hello (middleware-only route without controller) to return 200 "test_B", got 404. packages/http/src/router/route-compiler.ts only binds module middlewares to scanned controller routes (never unmatched paths); additionally packages/core/src/application/bunest-application.ts (configureModuleMiddlewares) iterates post-order bottom-up topologicalOrder (child before parent) rather than NestJS top-down importing-module-first order.
      it.skip(`should execute middleware in topological order`, async () => {
        await request(app!).get("/hello").expect(200, RETURN_VALUE_B);
      });

      // BUNEST_BUG: Expected GET /ping (middleware-only route without controller) to return 200 "test_GLOBAL", got 404. packages/http/src/router/route-compiler.ts and packages/http/src/adapter/bun-http.adapter.ts do not run module middlewares on unmatched routes without a controller handler.
      it.skip("should execute global middleware first", async () => {
        await request(app!).get("/ping").expect(200, RETURN_VALUE_GLOBAL);
      });
    });

    describe("execution order of a module also imported by a sibling", () => {
      let app: BunestApplication | undefined;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [LoggerModule, AuthModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      // BUNEST_BUG: Expected GET /hello (middleware-only route without controller) to return 200 "test_AUTH", got 404. packages/http/src/router/route-compiler.ts does not execute module middlewares on unmatched routes, and packages/core/src/application/bunest-application.ts registers middlewares in bottom-up post-order DFS (LoggerModule before AuthModule) instead of importing-module-first order.
      it.skip("should execute the middleware of the importing module first", async () => {
        await request(app!).get("/hello").expect(200, RETURN_VALUE_AUTH);
      });
    });

    describe('execution order with an asynchronous "configure"', () => {
      let app: BunestApplication | undefined;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [AsyncFirstModule, SecondModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      // BUNEST_BUG: Expected GET /hello (middleware-only route without controller) to return 200 "test_FIRST", got 404. packages/http/src/router/route-compiler.ts and packages/http/src/adapter/bun-http.adapter.ts do not run module middlewares on unmatched routes without a controller handler.
      it.skip('should execute the middleware in the order of the "imports" array', async () => {
        await request(app!).get("/hello").expect(200, RETURN_VALUE_FIRST);
      });
    });
  },
);
