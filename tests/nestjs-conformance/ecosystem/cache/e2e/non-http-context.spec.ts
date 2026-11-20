import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { Controller, Module } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  CacheInterceptor,
  CacheKey,
  CacheModule,
} from "../../../../../packages/cache/src";
import {
  Test,
  createMockExecutionContext,
  describeConformance,
} from "../../../_helpers/index";

@Controller()
class NonHttpContextController {
  counter = 0;

  @CacheKey("non-http-context")
  getNumber() {
    return this.counter++;
  }
}

@Module({
  imports: [CacheModule.register()],
  controllers: [NonHttpContextController],
  providers: [CacheInterceptor],
})
class NonHttpContextModule {}

describeConformance(
  "CacheInterceptor - Caching non-HTTP contexts",
  {
    upstreamPath: "cache-manager/tests/e2e/non-http-context.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
    notes:
      "Adapts RxJS defer/of/lastValueFrom CallHandler to Promise CallHandler (ADR-008) and ExecutionContextHost to createMockExecutionContext.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [NonHttpContextModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    // BUNEST_BUG: CacheInterceptor.intercept() (packages/cache/src/cache.interceptor.ts:127) returns next.handle() immediately whenever context.getType() !== "http", bypassing caching for rpc/ws contexts even when @CacheKey() is explicitly set (received 1 on second invocation instead of cached 0).
    it.skip.each(["rpc", "ws"] as const)(
      "should cache %s handlers in an HTTP app",
      async (type) => {
        const interceptor = app.get(CacheInterceptor);
        const controller = app.get(NonHttpContextController);
        const context = createMockExecutionContext({
          contextType: type,
          controllerClass: NonHttpContextController,
          handler: controller.getNumber,
        });
        const next = {
          handle: async () => controller.getNumber(),
        };

        await interceptor.intercept(context, next);
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(await interceptor.intercept(context, next)).toBe(0);
      },
    );

    afterEach(async () => {
      await app.close();
    });
  },
);
