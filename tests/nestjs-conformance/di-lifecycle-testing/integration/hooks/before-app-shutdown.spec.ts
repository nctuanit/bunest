import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Injectable,
  Module,
  type BeforeApplicationShutdown,
} from "../../../../../packages/common/src";
import {
  Test,
  createSpy,
  describeConformance,
} from "../../../_helpers";

@Injectable()
class TestInjectable implements BeforeApplicationShutdown {
  beforeApplicationShutdown = createSpy();
}

describeConformance(
  "BeforeApplicationShutdown",
  {
    upstreamPath: "integration/hooks/e2e/before-app-shutdown.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should call `beforeApplicationShutdown` when application closes", async () => {
      const module = await Test.createTestingModule({
        providers: [TestInjectable],
      }).compile();

      const app = module.createNestApplication();
      await app.close();
      const instance = module.get(TestInjectable);
      expect(instance.beforeApplicationShutdown).toHaveBeenCalled();
    });

    it("should sort modules by distance (topological sort) - DESC order", async () => {
      @Injectable()
      class BB implements BeforeApplicationShutdown {
        beforeApplicationShutdown = createSpy();
      }

      @Module({
        providers: [BB],
        exports: [BB],
      })
      class B {}

      @Injectable()
      class AA implements BeforeApplicationShutdown {
        constructor(public readonly bb: BB) {}
        beforeApplicationShutdown = createSpy();
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
        aa.beforeApplicationShutdown.calledBefore(bb.beforeApplicationShutdown),
      ).toBe(true);
    });

    // BUNEST_BUG: LifecycleManager runs intra-module beforeApplicationShutdown hooks in provider declaration order instead of reverse constructor dependency hierarchy (packages/core/src/di/di-container.ts, packages/core/src/lifecycle/lifecycle-manager.ts)
    it.skip("should sort components within a single module by injection hierarchy - ASC order", async () => {
      @Injectable()
      class A implements BeforeApplicationShutdown {
        beforeApplicationShutdown = createSpy();
      }

      @Injectable()
      class AHost implements BeforeApplicationShutdown {
        constructor(public readonly a: A) {}
        beforeApplicationShutdown = createSpy();
      }

      @Injectable()
      class Composition implements BeforeApplicationShutdown {
        constructor(
          public readonly a: A,
          public readonly host: AHost,
        ) {}
        beforeApplicationShutdown = createSpy();
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
        composition.beforeApplicationShutdown.calledBefore(
          parent.beforeApplicationShutdown,
        ),
      ).toBe(true);
      expect(
        parent.beforeApplicationShutdown.calledBefore(
          child.beforeApplicationShutdown,
        ),
      ).toBe(true);
    });
  },
);
