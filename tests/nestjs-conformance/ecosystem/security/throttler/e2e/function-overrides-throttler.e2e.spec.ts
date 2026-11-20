import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  Controller,
  Get,
  Module,
  type ExecutionContext,
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

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

const commonHeader = (prefix: string, name?: string) =>
  `${prefix}${name ? `-${name}` : ""}`;
const remainingHeader = (name?: string) =>
  commonHeader("x-ratelimit-remaining", name);
const limitHeader = (name?: string) => commonHeader("x-ratelimit-limit", name);
const retryHeader = (name?: string) => commonHeader("retry-after", name);

const custom = "custom";
const WINDOW_MS = 350;

@Controller()
class FunctionOverridesThrottlerController {
  @SkipThrottle({ custom: true })
  @Get()
  simpleRoute() {
    return { success: true };
  }

  @SkipThrottle({ custom: true })
  @Get("1")
  simpleRouteOne() {
    return { success: true };
  }

  @SkipThrottle({ default: true })
  @Get("custom")
  simpleRouteTwo() {
    return { success: true };
  }

  @SkipThrottle({ default: true })
  @Get("custom/1")
  simpleRouteThree() {
    return { success: true };
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: "default",
        ttl: WINDOW_MS,
        limit: 2,
      },
      {
        name: "custom",
        ttl: WINDOW_MS,
        limit: 2,
        getTracker: () => "customTrackerString",
        generateKey: (
          _context: ExecutionContext,
          trackerString: string,
          throttlerName: string,
        ) => {
          if (trackerString !== "customTrackerString") {
            throw new Error(
              `Expected customTrackerString, received ${trackerString}`,
            );
          }
          // Share a single rate-limit bucket across all endpoints using the custom throttler
          return md5(`${throttlerName}-${trackerString}`);
        },
      },
    ]),
  ],
  controllers: [FunctionOverridesThrottlerController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
class FunctionOverridesThrottlerModule {}

describeConformance(
  "Function-Overrides-Throttler E2E",
  {
    upstreamPath:
      "throttler/test/function-overrides/function-overrides-throttler.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Upstream commit 849929b4df (@nestjs/throttler@6.8.0). Adapted to Bunest native zero-socket TestClient with scaled 350ms TTL window (upstream 3s).",
  },
  () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
      ctx = await createTestApp(
        {
          imports: [FunctionOverridesThrottlerModule],
        },
        { silentLogger: true },
      );
    });

    afterAll(async () => {
      await ctx.close();
    });

    describe("Default Routes", () => {
      it("should receive an exception when firing 3 requests within the window to the same endpoint", async () => {
        const r1 = await ctx.request().get("/").expect(200);
        expect(r1.headers[remainingHeader()]).toBe("1");
        expect(r1.headers[limitHeader()]).toBe("2");

        const r2 = await ctx.request().get("/1").expect(200);
        expect(r2.headers[remainingHeader()]).toBe("1");
        expect(r2.headers[limitHeader()]).toBe("2");

        const r3 = await ctx.request().get("/").expect(200);
        expect(r3.headers[remainingHeader()]).toBe("0");

        const r4 = await ctx.request().get("/").expect(429);
        expect(r4.headers[retryHeader()]).toMatch(/^\d+$/);

        const r5 = await ctx.request().get("/1").expect(200);
        expect(r5.headers[remainingHeader()]).toBe("0");

        const r6 = await ctx.request().get("/").expect(429);
        expect(r6.headers[retryHeader()]).toMatch(/^\d+$/);

        await delay(WINDOW_MS + 60);

        const r7 = await ctx.request().get("/").expect(200);
        expect(r7.headers[remainingHeader()]).toBe("1");
        expect(r7.headers[limitHeader()]).toBe("2");
      });
    });

    describe("Custom Routes", () => {
      it("should receive an exception when firing 3 requests within the window to any endpoint", async () => {
        const r1 = await ctx.request().get("/custom").expect(200);
        expect(r1.headers[remainingHeader(custom)]).toBe("1");
        expect(r1.headers[limitHeader(custom)]).toBe("2");

        const r2 = await ctx.request().get("/custom/1").expect(200);
        expect(r2.headers[remainingHeader(custom)]).toBe("0");
        expect(r2.headers[limitHeader(custom)]).toBe("2");

        const r3 = await ctx.request().get("/custom").expect(429);
        expect(r3.headers[retryHeader(custom)]).toMatch(/^\d+$/);

        const r4 = await ctx.request().get("/custom/1").expect(429);
        expect(r4.headers[retryHeader(custom)]).toMatch(/^\d+$/);

        await delay(WINDOW_MS + 60);

        const r5 = await ctx.request().get("/custom").expect(200);
        expect(r5.headers[remainingHeader(custom)]).toBe("1");
        expect(r5.headers[limitHeader(custom)]).toBe("2");

        const r6 = await ctx.request().get("/custom/1").expect(200);
        expect(r6.headers[remainingHeader(custom)]).toBe("0");
        expect(r6.headers[limitHeader(custom)]).toBe("2");
      });
    });
  },
);
