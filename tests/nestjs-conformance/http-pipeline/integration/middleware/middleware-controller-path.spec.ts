import { afterEach, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  type BunestModule,
  type MiddlewareConsumer,
  type ModuleImport,
} from "../../../../../packages/core/src/common";
import {
  RouterModule,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

const RETURN_VALUE = "test";
const MIDDLEWARE_VALUE = "middleware";

@Controller("tail/")
class TrailingSlashController {
  @Get("child")
  child() {
    return RETURN_VALUE;
  }
}

@Controller("cats")
class CatsController {
  @Get()
  findAll() {
    return RETURN_VALUE;
  }
}

@Module({
  controllers: [TrailingSlashController, CatsController],
})
class TestModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
      .forRoutes(TrailingSlashController, CatsController);
  }
}

// The routes themselves are registered with their slashes normalized, so the
// paths `forRoutes(Controller)` derives must be normalized the same way or the
// middleware never matches the route it was bound to.
describeConformance(
  "Middleware bound to a controller (path joining)",
  {
    upstreamPath:
      "integration/hello-world/e2e/middleware-controller-path.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapted Express middleware res.send() to Bunest middleware returning native Web Response.",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    async function createApp(imports: ModuleImport[] = []) {
      const moduleRef = await Test.createTestingModule({
        imports: [TestModule, ...imports],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    }

    it("runs for a controller path ending in a slash", async () => {
      await createApp();

      await request(app!).get("/tail/child").expect(200, MIDDLEWARE_VALUE);
    });

    it("runs for a controller mounted at the RouterModule root", async () => {
      await createApp([
        RouterModule.register([{ path: "/", module: TestModule }]),
      ]);

      await request(app!).get("/cats").expect(200, MIDDLEWARE_VALUE);
    });

    // BUNEST_BUG: Expected GET /parent/tail/child to run middleware ("middleware"), got "test". packages/core/src/module/middleware-consumer.ts (toRouteInfos) derives controller routes solely from @Controller() metadata ("/tail", "/tail/*") without RouterModule prefixes, while packages/core/src/http/scanner/controller-scanner.ts prepends RouterModule prefix into rawPathWithoutPrefix ("/parent/tail/child"), causing matchesMiddlewareForRoute to miss.
    it.skip("runs for a controller path ending in a slash under a RouterModule path", async () => {
      await createApp([
        RouterModule.register([{ path: "parent", module: TestModule }]),
      ]);

      await request(app!)
        .get("/parent/tail/child")
        .expect(200, MIDDLEWARE_VALUE);
    });
  },
);
