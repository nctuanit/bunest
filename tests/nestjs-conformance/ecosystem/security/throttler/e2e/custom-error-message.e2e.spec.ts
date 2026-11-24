import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Controller, Get, Module } from "../../../../../../packages/core/src/common";
import { APP_GUARD } from "../../../../../../packages/core/src";
import {
  SkipThrottle,
  ThrottlerGuard,
  ThrottlerModule,
  seconds,
} from "../../../../../../packages/security/src";
import {
  createTestApp,
  describeConformance,
  type TestAppContext,
} from "../../../../_helpers/index";

@Controller()
class CustomErrorMessageController {
  @SkipThrottle({ other: true })
  @Get("default")
  defaultRoute() {
    return { success: true };
  }

  @SkipThrottle({ default: true })
  @Get("other")
  otherRoute() {
    return { success: true };
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot({
      errorMessage: (context, throttlerLimitDetail) =>
        `${context.getClass().name}-${context.getHandler().name} ${throttlerLimitDetail.tracker} ${throttlerLimitDetail.totalHits}`,
      throttlers: [
        {
          name: "default",
          ttl: seconds(3),
          limit: 2,
        },
        {
          name: "other",
          ttl: seconds(3),
          limit: 2,
        },
      ],
    }),
  ],
  controllers: [CustomErrorMessageController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
class CustomErrorMessageThrottlerModule {}

describeConformance(
  "Custom Error Message Throttler E2E",
  {
    upstreamPath:
      "throttler/test/error-message/custom-error-message.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Upstream commit 849929b4df (@nestjs/throttler@6.8.0). Adapted to Bunest zero-socket TestClient (tracker IP defaults to 127.0.0.1 instead of Node IPv6 ::1).",
  },
  () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
      ctx = await createTestApp(
        {
          imports: [CustomErrorMessageThrottlerModule],
        },
        { silentLogger: true },
      );
    });

    afterAll(async () => {
      await ctx.close();
    });

    describe.each([
      {
        route: "default",
        errorMessage: "CustomErrorMessageController-defaultRoute 127.0.0.1 3",
      },
      {
        route: "other",
        errorMessage: "CustomErrorMessageController-otherRoute 127.0.0.1 3",
      },
    ])("Custom-error-message Route - $route", ({ route, errorMessage }) => {
      it("should receive a custom exception", async () => {
        const limit = 2;
        for (let i = 0; i < limit; i++) {
          await ctx.request().get(`/${route}`).expect(200);
        }

        const res = await ctx.request().get(`/${route}`).expect(429);
        expect(JSON.stringify(res.body)).toContain(errorMessage);
      });
    });
  },
);
