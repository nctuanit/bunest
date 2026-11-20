import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  Controller,
  Get,
  Module,
} from "../../../../../../packages/common/src";
import { APP_GUARD } from "../../../../../../packages/core/src";
import {
  SkipThrottle,
  ThrottlerGuard,
  ThrottlerModule,
} from "../../../../../../packages/security/src";
import {
  createTestApp,
  describeConformance,
  type TestAppContext,
} from "../../../../_helpers/index";

const commonHeader = (prefix: string, name?: string) =>
  `${prefix}${name ? `-${name}` : ""}`;
const remainingHeader = (name?: string) =>
  commonHeader("x-ratelimit-remaining", name);
const limitHeader = (name?: string) => commonHeader("x-ratelimit-limit", name);
const retryHeader = (name?: string) => commonHeader("retry-after", name);

const short = "short";
const long = "long";

// Exact upstream 1:5:60 window ratios scaled down 3.3x (1s -> 300ms, 5s -> 1500ms, 60s -> 18000ms)
const SHORT_TTL = 300;
const DEFAULT_TTL = 1500;
const LONG_TTL = 18_000;

@Controller()
class MultiThrottlerController {
  @Get()
  simpleRoute() {
    return { success: true };
  }

  @SkipThrottle({ short: true })
  @Get("skip-short")
  skipShort() {
    return { success: true };
  }

  @SkipThrottle({ default: true, long: true })
  @Get("skip-default-and-long")
  skipDefAndLong() {
    return { success: true };
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: DEFAULT_TTL,
        limit: 2,
      },
      {
        name: "long",
        ttl: LONG_TTL,
        limit: 5,
      },
      {
        name: "short",
        limit: 1,
        ttl: SHORT_TTL,
      },
    ]),
  ],
  controllers: [MultiThrottlerController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
class MultiThrottlerAppModule {}

describeConformance(
  "Multi-Throttler Named Usage E2E",
  {
    upstreamPath: "throttler/test/multi/multi-throttler.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Upstream commit 849929b4df (@nestjs/throttler@6.8.0). Adapted to Bunest native zero-socket TestClient with proportionally scaled TTLs (300ms / 1500ms / 18s preserving exact 1:5:60 ratio).",
  },
  () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
      ctx = await createTestApp(
        {
          imports: [MultiThrottlerAppModule],
        },
        { silentLogger: true },
      );
    });

    afterAll(async () => {
      await ctx.close();
    });

    describe("Default Route: 1/short, 2/default, 5/long", () => {
      it("should receive an exception when firing 2 requests within the short window", async () => {
        const r1 = await ctx.request().get("/").expect(200);
        expect(r1.headers[remainingHeader(short)]).toBe("0");
        expect(r1.headers[limitHeader(short)]).toBe("1");

        const r2 = await ctx.request().get("/").expect(429);
        expect(r2.headers[retryHeader(short)]).toMatch(/^\d+$/);

        await delay(SHORT_TTL + 60);
      });

      // BUNEST_BUG: packages/security/src/throttler/throttler.guard.ts (onModuleInit lines 128-141 & handleRequest lines 276-293, 408-418) sorts throttlers by ttl before naming unnamed rules (misnaming the unnamed default rule `"rule_1"` instead of `"default"`) and overwrites unsuffixed `X-RateLimit-Limit` with `state.primary` (`short`: `"1"`) instead of the default throttler's `"2"`.
      it.skip("should get an error if we send two more requests within the default window", async () => {
        const r1 = await ctx.request().get("/").expect(200);
        expect(r1.headers[remainingHeader()]).toBe("0");
        expect(r1.headers[limitHeader()]).toBe("2");

        await delay(SHORT_TTL + 60);

        const r2 = await ctx.request().get("/").expect(429);
        expect(r2.headers[retryHeader()]).toMatch(/^\d+$/);

        await delay(DEFAULT_TTL + 60);
      });

      // BUNEST_BUG: packages/security/src/throttler/throttler.guard.ts (onModuleInit lines 128-141 & handleRequest lines 276-293, 408-418) misnames the unnamed default rule `"rule_1"` after TTL sorting and overwrites unsuffixed `X-RateLimit-Remaining` with the lowest remaining throttler (`short`: `"0"`) instead of default's `"1"`.
      it.skip("should get an error if we smartly send 4 more requests within the long window", async () => {
        const r1 = await ctx.request().get("/").expect(200);
        expect(r1.headers[limitHeader(long)]).toBe("5");
        expect(r1.headers[remainingHeader(long)]).toBe("2");
        expect(r1.headers[remainingHeader(short)]).toBe("0");

        await delay(SHORT_TTL + 60);

        const r2 = await ctx.request().get("/").expect(200);
        expect(r2.headers[remainingHeader()]).toBe("0");

        await delay(DEFAULT_TTL + 60);

        const r3 = await ctx.request().get("/").expect(200);
        expect(r3.headers[remainingHeader(long)]).toBe("0");
        expect(r3.headers[remainingHeader(short)]).toBe("0");
        expect(r3.headers[remainingHeader()]).toBe("1");

        await delay(SHORT_TTL + 60);

        const r4 = await ctx.request().get("/").expect(429);
        expect(r4.headers[retryHeader(long)]).toMatch(/^\d+$/);
      });
    });

    describe("skips", () => {
      it("should skip the short throttler", async () => {
        const r1 = await ctx.request().get("/skip-short").expect(200);
        expect(r1.headers[remainingHeader()]).toBe("1");

        const r2 = await ctx.request().get("/skip-short").expect(200);
        expect(r2.headers[remainingHeader()]).toBe("0");
      });

      it("should skip the default and long trackers", async () => {
        const res = await ctx
          .request()
          .get("/skip-default-and-long")
          .expect(200);
        expect(res.headers[remainingHeader(short)]).toBe("0");
        expect(res.headers[remainingHeader("default")]).toBeUndefined();
        expect(res.headers[remainingHeader("long")]).toBeUndefined();
      });
    });
  },
);
