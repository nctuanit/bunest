import { expect, it } from "bun:test";
import {
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from "../../../../../packages/core/src/common";
import { Test, createSpy, describeConformance } from "../../../_helpers";

@Injectable()
class TestInjectable
  implements
    OnApplicationBootstrap,
    OnModuleInit,
    OnModuleDestroy,
    OnApplicationShutdown,
    BeforeApplicationShutdown
{
  onApplicationBootstrap = createSpy();
  beforeApplicationShutdown = createSpy();
  onApplicationShutdown = createSpy();
  onModuleDestroy = createSpy();
  onModuleInit = createSpy();
}

describeConformance(
  "Lifecycle Hook Order",
  {
    upstreamPath: "integration/hooks/e2e/lifecycle-hook-order.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should call the lifecycle hooks in the correct order", async () => {
      const module = await Test.createTestingModule({
        providers: [TestInjectable],
      }).compile();

      const app = module.createNestApplication();
      await app.init();
      await app.close();

      const instance = module.get(TestInjectable);
      const order = [
        instance.onModuleInit,
        instance.onApplicationBootstrap,
        instance.onModuleDestroy,
        instance.beforeApplicationShutdown,
        instance.onApplicationShutdown,
      ];
      for (let i = 0; i < order.length - 1; i++) {
        expect(order[i]!.calledBefore(order[i + 1]!)).toBe(true);
      }
    });
  },
);
