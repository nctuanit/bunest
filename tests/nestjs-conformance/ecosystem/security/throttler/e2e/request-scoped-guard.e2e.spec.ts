import "reflect-metadata";
import { afterAll, beforeAll, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Scope,
  UseGuards,
} from "../../../../../../packages/common/src";
import {
  ThrottlerGuard,
  ThrottlerModule,
} from "../../../../../../packages/security/src";
import {
  createTestApp,
  describeConformance,
  type TestAppContext,
} from "../../../../_helpers/index";

@Injectable({ scope: Scope.REQUEST })
class RequestScopedGuard extends ThrottlerGuard {}

@Controller()
class RequestScopedController {
  @UseGuards(RequestScopedGuard)
  @Get()
  get() {
    return "ok";
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 1 }])],
  controllers: [RequestScopedController],
})
class RequestScopedModule {}

describeConformance(
  "Request-Scoped ThrottlerGuard E2E",
  {
    upstreamPath:
      "throttler/test/request-scoped/request-scoped-guard.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Upstream commit 849929b4df (@nestjs/throttler@6.8.0). Verifies a Scope.REQUEST ThrottlerGuard subclass attached via @UseGuards() shares the underlying singleton ThrottlerStorage across requests.",
  },
  () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
      ctx = await createTestApp(
        {
          imports: [RequestScopedModule],
        },
        { silentLogger: true },
      );
    });

    afterAll(async () => {
      await ctx.close();
    });

    it("should apply the limit, which is shared between the guard instances", async () => {
      await ctx.request().get("/").expect(200);
      await ctx.request().get("/").expect(429);
    });
  },
);
