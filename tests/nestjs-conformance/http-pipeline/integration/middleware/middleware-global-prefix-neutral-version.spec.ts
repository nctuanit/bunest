import { afterEach, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  VERSION_NEUTRAL,
  VersioningType,
  type BunestModule,
  type MiddlewareConsumer,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

const RETURN_VALUE = "metrics";
const MIDDLEWARE_VALUE = "middleware";

// The path starts with a segment that reads like a version segment
@Controller({ path: "v1/metrics", version: [VERSION_NEUTRAL, "1"] })
class MetricsController {
  @Get()
  find() {
    return RETURN_VALUE;
  }
}

@Module({ controllers: [MetricsController] })
class MetricsModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req, _res, _next) => new Response(MIDDLEWARE_VALUE))
      .forRoutes(MetricsController);
  }
}

describeConformance(
  "Middleware - version-neutral route excluded from the global prefix (BunHttpAdapter)",
  {
    upstreamPath:
      "integration/hello-world/e2e/middleware-global-prefix-neutral-version.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Collapsed Express/Fastify adapter matrix to canonical BunHttpAdapter; adapted Express middleware res.end() to native Web Response.",
  },
  () => {
    let app: BunestApplication | undefined;

    const createApp = async (exclude: string[]) => {
      const moduleRef = await Test.createTestingModule({
        imports: [MetricsModule],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      app.setGlobalPrefix("api", { exclude });
      app.enableVersioning({ type: VersioningType.URI });
      await app.init();
    };

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it(`should keep the version-neutral path "/v1/metrics" under the prefix when "metrics" is excluded`, async () => {
      await createApp(["metrics"]);
      await request(app!).get("/api/v1/metrics").expect(200, MIDDLEWARE_VALUE);
      await request(app!).get("/v1/metrics").expect(404);
    });

    it(`should take the version-neutral path "/v1/metrics" out of the prefix when "v1/metrics" is excluded`, async () => {
      await createApp(["v1/metrics"]);
      await request(app!).get("/v1/metrics").expect(200, MIDDLEWARE_VALUE);
      await request(app!).get("/v1/v1/metrics").expect(200, MIDDLEWARE_VALUE);
      await request(app!).get("/api/v1/metrics").expect(404);
    });
  },
);
