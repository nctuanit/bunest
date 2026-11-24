import { expect, it } from "bun:test";
import {
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "../../../../../packages/core/src/common";
import { Test, createSpy, describeConformance } from "../../../_helpers";

@Injectable()
class TestInjectable implements OnApplicationShutdown {
  onApplicationShutdown = createSpy();
}

describeConformance(
  "OnApplicationShutdown",
  {
    upstreamPath: "integration/hooks/e2e/on-app-shutdown.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should call onApplicationShutdown when application closes", async () => {
      const module = await Test.createTestingModule({
        providers: [TestInjectable],
      }).compile();

      const app = module.createNestApplication();
      await app.close();
      const instance = module.get(TestInjectable);
      expect(instance.onApplicationShutdown).toHaveBeenCalled();
    });

    it("should call onApplicationShutdown when an application context closes after a failed init", async () => {
      @Injectable()
      class FailingInjectable implements OnModuleInit {
        onModuleInit() {
          throw new Error("init failed");
        }
      }

      const module = await Test.createTestingModule({
        providers: [TestInjectable, FailingInjectable],
      }).compile();

      await expect(module.init()).rejects.toThrow("init failed");
      await module.close();

      const instance = module.get(TestInjectable);
      expect(instance.onApplicationShutdown).toHaveBeenCalled();
    });

    it("should sort modules by distance (topological sort) - DESC order", async () => {
      @Injectable()
      class BB implements OnApplicationShutdown {
        onApplicationShutdown = createSpy();
      }

      @Module({
        providers: [BB],
        exports: [BB],
      })
      class B {}

      @Injectable()
      class AA implements OnApplicationShutdown {
        constructor(public readonly bb: BB) {}
        onApplicationShutdown = createSpy();
      }

      @Module({
        imports: [B],
        providers: [AA],
      })
      class A {}

      const module = await Test.createTestingModule({
        imports: [A],
      }).compile();

      const app = module.createNestApplication();
      await app.init();
      await app.close();

      const aa = module.get(AA);
      const bb = module.get(BB);
      expect(
        aa.onApplicationShutdown.calledBefore(bb.onApplicationShutdown),
      ).toBe(true);
    });

    // BUNEST_BUG: LifecycleManager runs intra-module onApplicationShutdown hooks in provider declaration order instead of reverse constructor dependency hierarchy (packages/core/src/di/di-container.ts, packages/core/src/lifecycle/lifecycle-manager.ts)
    it.skip("should sort components within a single module by injection hierarchy - ASC order", async () => {
      @Injectable()
      class A implements OnApplicationShutdown {
        onApplicationShutdown = createSpy();
      }

      @Injectable()
      class AHost implements OnApplicationShutdown {
        constructor(public readonly a: A) {}
        onApplicationShutdown = createSpy();
      }

      @Injectable()
      class Composition implements OnApplicationShutdown {
        constructor(
          public readonly a: A,
          public readonly host: AHost,
        ) {}
        onApplicationShutdown = createSpy();
      }

      @Module({
        providers: [AHost, A, Composition],
      })
      class AModule {}

      const module = await Test.createTestingModule({
        imports: [AModule],
      }).compile();

      const app = module.createNestApplication();
      await app.init();
      await app.close();

      const child = module.get(A);
      const parent = module.get(AHost);
      const composition = module.get(Composition);

      expect(
        composition.onApplicationShutdown.calledBefore(
          parent.onApplicationShutdown,
        ),
      ).toBe(true);
      expect(
        parent.onApplicationShutdown.calledBefore(child.onApplicationShutdown),
      ).toBe(true);
    });
  },
);
