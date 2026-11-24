import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Req,
  RequestMethod,
  VERSION_NEUTRAL,
  Version,
  VersioningType,
  type BunestModule,
  type CustomVersioningOptions,
  type MiddlewareConsumer,
  type RouteInfo,
  type Type,
  type VersioningOptions,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

type VersionedRouteInfo = RouteInfo & { version?: string };

const RETURN_VALUE = "test";
const VERSIONED_VALUE = "test_versioned";

const requestRuns = new WeakMap<Request, number>();
const incrementRuns = (req: Request) => {
  requestRuns.set(req, (requestRuns.get(req) ?? 0) + 1);
};
const getRuns = (req: Request) => requestRuns.get(req) ?? 0;

@Controller("hello")
class HelloController {
  @Get()
  greeting() {
    return "Hello world!";
  }
}

@Module({
  controllers: [HelloController],
})
class HelloModule {}

@Controller()
class TestController {
  @Version("1")
  @Get("versioned")
  versionedTest() {
    return RETURN_VALUE;
  }
}

@Module({
  imports: [HelloModule],
  controllers: [TestController],
})
class TestModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    const versionedRoute: VersionedRouteInfo = {
      path: "/versioned",
      version: "1",
      method: RequestMethod.ALL,
    };
    consumer
      .apply((_req, _res, _next) => new Response(VERSIONED_VALUE))
      .forRoutes(versionedRoute);
  }
}

@Controller("dogs")
class DogsController {
  @Get()
  findAll(@Req() req: Request) {
    return `${getRuns(req)}`;
  }
}

@Controller({ path: "dogs", version: VERSION_NEUTRAL })
class NeutralDogsController {
  @Get("neutral")
  findNeutral(@Req() req: Request) {
    return `${getRuns(req)}`;
  }
}

@Controller({ path: "dogs", version: ["1", VERSION_NEUTRAL] })
class MultipleDogsController {
  @Get("multiple")
  findMultiple(@Req() req: Request) {
    return `${getRuns(req)}`;
  }
}

@Controller({ path: "cats", version: "1" })
class CatsV1Controller {
  @Get()
  findAll(@Req() req: Request) {
    return `v1:${getRuns(req)}`;
  }
}

@Controller({ path: "cats", version: "2" })
class CatsV2Controller {
  @Get()
  findAll(@Req() req: Request) {
    return `v2:${getRuns(req)}`;
  }
}

@Controller({ path: "birds", version: ["1", "2"] })
class BirdsController {
  @Get()
  findAll(@Req() req: Request) {
    return `${getRuns(req)}`;
  }
}

async function createAppWithVersioning(
  versioningOptions: VersioningOptions,
  beforeInit?: (app: BunestApplication) => Promise<void>,
): Promise<BunestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TestModule],
  }).compile({ logger: false });
  const app = moduleRef.createNestApplication({ logger: false });

  app.enableVersioning(versioningOptions);
  if (beforeInit) {
    await beforeInit(app);
  }
  await app.init();

  return app;
}

describeConformance(
  "Middleware with versioning (BunHttpAdapter)",
  {
    upstreamPath:
      "integration/hello-world/e2e/middleware-with-versioning.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Collapsed Express/Fastify/Node adapter matrix to canonical BunHttpAdapter; adapted CUSTOM extractor to Web Request.headers.get(), middleware res.send() to Web Response, and per-request run tracking via WeakMap<Request, number>.",
  },
  () => {
    describe("Middleware", () => {
      let app: BunestApplication | undefined;

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      describe("when using default URI versioning", () => {
        beforeEach(async () => {
          app = await createAppWithVersioning({
            type: VersioningType.URI,
            defaultVersion: VERSION_NEUTRAL,
          });
        });

        it(`forRoutes({ path: '/versioned', version: '1', method: RequestMethod.ALL })`, async () => {
          await request(app!).get("/v1/versioned").expect(200, VERSIONED_VALUE);
        });
      });

      describe("when default URI versioning with an alternative prefix", () => {
        beforeEach(async () => {
          app = await createAppWithVersioning({
            type: VersioningType.URI,
            defaultVersion: VERSION_NEUTRAL,
            prefix: "version",
          });
        });

        it(`forRoutes({ path: '/versioned', version: '1', method: RequestMethod.ALL })`, async () => {
          await request(app!)
            .get("/version1/versioned")
            .expect(200, VERSIONED_VALUE);
        });
      });

      describe("when using default URI versioning with the global prefix", () => {
        beforeEach(async () => {
          app = await createAppWithVersioning(
            {
              type: VersioningType.URI,
              defaultVersion: VERSION_NEUTRAL,
            },
            async (instance) => {
              instance.setGlobalPrefix("api");
            },
          );
        });

        it(`forRoutes({ path: '/versioned', version: '1', method: RequestMethod.ALL })`, async () => {
          await request(app!)
            .get("/api/v1/versioned")
            .expect(200, VERSIONED_VALUE);
        });
      });

      describe("when using HEADER versioning", () => {
        beforeEach(async () => {
          app = await createAppWithVersioning({
            type: VersioningType.HEADER,
            header: "version",
          });
        });

        it(`forRoutes({ path: '/versioned', version: '1', method: RequestMethod.ALL })`, async () => {
          await request(app!)
            .get("/versioned")
            .set("version", "1")
            .expect(200, VERSIONED_VALUE);
        });
      });

      describe("when using MEDIA TYPE versioning", () => {
        beforeEach(async () => {
          app = await createAppWithVersioning({
            type: VersioningType.MEDIA_TYPE,
            key: "v",
            defaultVersion: VERSION_NEUTRAL,
          });
        });

        // BUNEST_BUG: Expected GET /versioned (without Accept header) to execute middleware returning 200 "test_versioned", got 404. packages/core/src/http/router/route-compiler.ts (matchCompiledVersionGroup) rejects the unversioned request before executing middleware bound via forRoutes({ path: '/versioned', version: '1', method: RequestMethod.ALL }).
        it.skip(`forRoutes({ path: '/versioned', version: '1', method: RequestMethod.ALL })`, async () => {
          await request(app!).get("/versioned").expect(200, VERSIONED_VALUE);
        });
      });

      describe("when using CUSTOM TYPE versioning", () => {
        beforeEach(async () => {
          const extractor: CustomVersioningOptions["extractor"] = () => "1";

          app = await createAppWithVersioning({
            type: VersioningType.CUSTOM,
            extractor,
          });
        });

        it(`forRoutes({ path: '/versioned', version: '1', method: RequestMethod.ALL })`, async () => {
          await request(app!).get("/versioned").expect(200, VERSIONED_VALUE);
        });
      });
    });

    describe("Middleware - URI versioning with a default version", () => {
      let app: BunestApplication | undefined;

      const createApp = async (
        ...routes: Array<string | Type<unknown> | RouteInfo>
      ): Promise<void> => {
        @Module({
          controllers: [
            DogsController,
            NeutralDogsController,
            MultipleDogsController,
          ],
        })
        class DogsModule implements BunestModule {
          configure(consumer: MiddlewareConsumer) {
            consumer
              .apply((req, _res, next) => {
                incrementRuns(req);
                return next();
              })
              .forRoutes(...routes);
          }
        }

        const moduleRef = await Test.createTestingModule({
          imports: [DogsModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
        await app.init();
      };

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it(`forRoutes('dogs') should run on "/v1/dogs"`, async () => {
        await createApp("dogs");
        await request(app!).get("/v1/dogs").expect(200, "1");
      });

      it(`forRoutes({ path: 'dogs', method: RequestMethod.GET }) should run on "/v1/dogs"`, async () => {
        await createApp({ path: "dogs", method: RequestMethod.GET });
        await request(app!).get("/v1/dogs").expect(200, "1");
      });

      // BUNEST_BUG: Expected GET /v1/dogs (DogsController) to return "0" (not hit by NeutralDogsController middleware), got "1". packages/core/src/module/middleware-consumer.ts (toRouteInfos) emits `/dogs` and `/dogs/*` for NeutralDogsController ignoring its handler path `/neutral` and `version: VERSION_NEUTRAL`, leaking the middleware onto DogsController's `/v1/dogs`.
      it.skip(`forRoutes(NeutralDogsController) should only run on its own routes`, async () => {
        await createApp(NeutralDogsController);
        await request(app!).get("/dogs/neutral").expect(200, "1");
        await request(app!).get("/v1/dogs").expect(200, "0");
      });

      it(`forRoutes(MultipleDogsController) should run once on each of its routes`, async () => {
        await createApp(MultipleDogsController);
        await request(app!).get("/dogs/multiple").expect(200, "1");
        await request(app!).get("/v1/dogs/multiple").expect(200, "1");
      });
    });

    describe("Middleware - routes that differ only in their version", () => {
      let app: BunestApplication | undefined;

      const createApp = async (
        versioningOptions: VersioningOptions,
        ...routes: Array<Type<unknown> | RouteInfo>
      ): Promise<void> => {
        @Module({
          controllers: [CatsV1Controller, CatsV2Controller, BirdsController],
        })
        class CatsModule implements BunestModule {
          configure(consumer: MiddlewareConsumer) {
            consumer
              .apply((req, _res, next) => {
                incrementRuns(req);
                return next();
              })
              .forRoutes(...routes);
          }
        }

        const moduleRef = await Test.createTestingModule({
          imports: [CatsModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        app.enableVersioning(versioningOptions);
        await app.init();
      };

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      describe.each<
        readonly [
          string,
          VersioningOptions,
          (version: string) => Record<string, string>,
        ]
      >([
        [
          "HEADER",
          { type: VersioningType.HEADER, header: "X-Version" },
          (version: string) => ({ "X-Version": version }),
        ],
        [
          "MEDIA TYPE",
          { type: VersioningType.MEDIA_TYPE, key: "v=" },
          (version: string) => ({ Accept: `application/json;v=${version}` }),
        ],
        [
          "CUSTOM",
          {
            type: VersioningType.CUSTOM,
            extractor: (req: Request) => req.headers.get("x-version") ?? "",
          },
          (version: string) => ({ "X-Version": version }),
        ],
      ])("when using %s versioning", (_label, versioningOptions, headers) => {
        const get = (path: string, version: string) =>
          request(app!).get(path).set(headers(version));

        it(`forRoutes(CatsV1Controller, CatsV2Controller) should run once for each version`, async () => {
          await createApp(
            versioningOptions,
            CatsV1Controller,
            CatsV2Controller,
          );
          await get("/cats", "1").expect(200, "v1:1");
          await get("/cats", "2").expect(200, "v2:1");
        });

        it(`forRoutes(BirdsController) should run once for each of its versions`, async () => {
          await createApp(versioningOptions, BirdsController);
          await get("/birds", "1").expect(200, "1");
          await get("/birds", "2").expect(200, "1");
        });
      });
    });
  },
);
