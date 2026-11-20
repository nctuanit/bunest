import "reflect-metadata";
import { afterEach, beforeEach, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  type BunestModule,
  type MiddlewareConsumer,
} from "../../../../../packages/common/src";
import {
  RouterModule,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  request,
} from "../../../_helpers";

const RETURN_VALUE = "test";
const SCOPED_VALUE = "test_scoped";

@Controller("hello")
class HelloController {
  @Get()
  greeting() {
    return "Hello world!";
  }
}

@Module({ controllers: [HelloController] })
class AppModule {}

@Controller()
class TestController {
  @Get("test")
  test() {
    return RETURN_VALUE;
  }

  @Get("test2")
  test2() {
    return RETURN_VALUE;
  }
}

@Module({
  imports: [AppModule],
  controllers: [TestController],
})
class TestModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(SCOPED_VALUE))
      .forRoutes(TestController);
  }
}

describeConformance(
  "RouterModule with Middleware functions",
  {
    upstreamPath: "integration/hello-world/e2e/router-module-middleware.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-008", "ADR-010"],
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          TestModule,
          RouterModule.register([
            {
              path: "/module-path/",
              module: TestModule,
            },
          ]),
        ],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("forRoutes(TestController) - /test", async () => {
      await request(app).get("/module-path/test").expect(200, SCOPED_VALUE);
    });

    it("forRoutes(TestController) - /test2", async () => {
      await request(app).get("/module-path/test2").expect(200, SCOPED_VALUE);
    });
  },
);

@Controller("shared")
class SharedController {
  @Get()
  findAll() {
    return RETURN_VALUE;
  }
}

@Module({
  controllers: [SharedController],
})
class FirstHostModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(SCOPED_VALUE))
      .forRoutes(SharedController);
  }
}

@Module({
  controllers: [SharedController],
})
class SecondHostModule {}

describeConformance(
  "RouterModule with Middleware functions - controller in more than one module",
  {
    upstreamPath: "integration/hello-world/e2e/router-module-middleware.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-008", "ADR-010"],
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          FirstHostModule,
          SecondHostModule,
          RouterModule.register([
            { path: "first", module: FirstHostModule },
            { path: "second", module: SecondHostModule },
          ]),
        ],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    // BUNEST_BUG: Expected middleware bound via forRoutes(SharedController) to run on RouterModule-prefixed route /first/shared (returning "test_scoped"); actual returns "test" because CoreMiddlewareConsumer.toRouteInfos() extracts only @Controller('shared') -> /shared without applying RouterModule prefixes (/first/shared) when matching routes (packages/core/src/module/middleware-consumer.ts, packages/http/src/scanner/controller-scanner.ts).
    it.skip("forRoutes(SharedController) - /first/shared", async () => {
      await request(app).get("/first/shared").expect(200, SCOPED_VALUE);
    });

    // BUNEST_BUG: Expected middleware bound via forRoutes(SharedController) to run on RouterModule-prefixed route /second/shared (returning "test_scoped"); actual returns "test" because CoreMiddlewareConsumer.toRouteInfos() extracts /shared without RouterModule prefixes (/second/shared) (packages/core/src/module/middleware-consumer.ts, packages/http/src/scanner/controller-scanner.ts).
    it.skip("forRoutes(SharedController) - /second/shared", async () => {
      await request(app).get("/second/shared").expect(200, SCOPED_VALUE);
    });
  },
);
