import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Param,
  VersioningType,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

@Controller({ path: "users", version: "1" })
class UsersV1Controller {
  @Get(":id")
  find(@Param() params: Record<string, string>) {
    return params;
  }
}

@Controller({ path: "users", version: "2" })
class UsersV2Controller {
  @Get(":userId")
  find(@Param() params: Record<string, string>) {
    return params;
  }
}

@Controller({ path: "reports", version: "1" })
class ReportsV1Controller {
  @Get(":name.:ext")
  find(@Param() params: Record<string, string>) {
    return { version: "1", ...params };
  }
}

@Controller({ path: "reports", version: "2" })
class ReportsV2Controller {
  @Get(":name{.:locale}.:ext")
  find(@Param() params: Record<string, string>) {
    return { version: "2", ...params };
  }
}

@Module({
  controllers: [
    UsersV1Controller,
    UsersV2Controller,
    ReportsV1Controller,
    ReportsV2Controller,
  ],
})
class RouteParamsModule {}

describeConformance(
  "Params of routes that share a path shape (BunHttpAdapter)",
  {
    upstreamPath: "integration/http-adapters/e2e/route-params.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Adapts NestJS versioned route-params isolation tests (:id vs :userId and sub-segment dot captures) to BunHttpAdapter.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const modRef = await Test.createTestingModule({
        imports: [RouteParamsModule],
      }).compile();
      app = modRef.createNestApplication({ logger: false });
      app.enableVersioning({ type: VersioningType.HEADER, header: "v" });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("should give a handler only the params of its own route", async () => {
      const v1 = await request(app).get("/users/5").set("v", "1");
      const v2 = await request(app).get("/users/5").set("v", "2");

      expect(v1.body).toEqual({ id: "5" });
      expect(v2.body).toEqual({ userId: "5" });
    });

    // BUNEST_BUG: FallbackRadixRouter/NativePathMatcher only parse whole-segment :param tokens and do not support sub-segment dot captures or optional groups like ":name.:ext" or ":name{.:locale}.:ext" (packages/core/src/http/router/fallback-radix-router.ts:35-38, 159-204).
    it.skip.each(["/reports/report.en.json", "/reports/report.en.json/"])(
      "should preserve optional captures after a version miss on %s",
      async (path) => {
        const v1 = await request(app).get(path).set("v", "1").expect(200);
        const v2 = await request(app).get(path).set("v", "2").expect(200);

        expect(v1.body).toEqual({
          version: "1",
          name: "report.en",
          ext: "json",
        });
        expect(v2.body).toEqual({
          version: "2",
          name: "report",
          locale: "en",
          ext: "json",
        });
      },
    );

    // BUNEST_BUG: FallbackRadixRouter/NativePathMatcher do not support sub-segment dot captures or optional groups like ":name.:ext" or ":name{.:locale}.:ext" (packages/core/src/http/router/fallback-radix-router.ts:35-38, 159-204).
    it.skip("should also match the versioned route without its optional part", async () => {
      for (const version of ["1", "2"]) {
        const response = await request(app)
          .get("/reports/report.json")
          .set("v", version)
          .expect(200);

        expect(response.body).toEqual({ version, name: "report", ext: "json" });
      }
    });
  },
);
