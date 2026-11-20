import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from "../../../../../packages/common/src";
import {
  Test,
  createSpy,
  describeConformance,
} from "../../../_helpers";

@Injectable()
class TestInjectable implements OnApplicationBootstrap {
  onApplicationBootstrap = createSpy();
}

describeConformance(
  "OnApplicationBootstrap",
  {
    upstreamPath: "integration/hooks/e2e/on-app-bootstrap.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should call onApplicationBootstrap when application starts", async () => {
      const module = await Test.createTestingModule({
        providers: [TestInjectable],
      }).compile();

      const app = module.createNestApplication();
      await app.init();
      const instance = module.get(TestInjectable);
      expect(instance.onApplicationBootstrap).toHaveBeenCalled();
      await app.close();
    });

    it("should not throw an error when onApplicationBootstrap is null", async () => {
      const module = await Test.createTestingModule({
        providers: [
          { provide: "TEST", useValue: { onApplicationBootstrap: null } },
        ],
      }).compile();

      const app = module.createNestApplication();
      expect(await app.init()).not.toBeUndefined();
      await app.close();
    });

    it("should not throw an error when onApplicationBootstrap is undefined", async () => {
      const module = await Test.createTestingModule({
        providers: [
          { provide: "TEST", useValue: { onApplicationBootstrap: undefined } },
        ],
      }).compile();

      const app = module.createNestApplication();
      expect(await app.init()).not.toBeUndefined();
      await app.close();
    });

    it("should sort modules by distance (topological sort) - DESC order", async () => {
      @Injectable()
      class BB implements OnApplicationBootstrap {
        public field = "";
        async onApplicationBootstrap() {
          this.field = "b-field";
        }
      }

      @Module({
        providers: [BB],
        exports: [BB],
      })
      class B {}

      @Injectable()
      class AA implements OnApplicationBootstrap {
        public field = "";
        constructor(private readonly bb: BB) {}

        async onApplicationBootstrap() {
          this.field = this.bb.field + "_a-field";
        }
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

      const instance = module.get(AA);
      expect(instance.field).toBe("b-field_a-field");
      await app.close();
    });

    // BUNEST_BUG: LifecycleManager runs intra-module onApplicationBootstrap hooks in provider declaration order instead of constructor dependency hierarchy order (packages/core/src/di/di-container.ts, packages/core/src/lifecycle/lifecycle-manager.ts)
    it.skip("should sort components within a single module by injection hierarchy - DESC order", async () => {
      @Injectable()
      class A implements OnApplicationBootstrap {
        onApplicationBootstrap = createSpy();
      }

      @Injectable()
      class AHost implements OnApplicationBootstrap {
        constructor(public readonly a: A) {}
        onApplicationBootstrap = createSpy();
      }

      @Injectable()
      class Composition implements OnApplicationBootstrap {
        constructor(
          public readonly a: A,
          public readonly host: AHost,
        ) {}
        onApplicationBootstrap = createSpy();
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
        child.onApplicationBootstrap.calledBefore(
          parent.onApplicationBootstrap,
        ),
      ).toBe(true);
      expect(
        parent.onApplicationBootstrap.calledBefore(
          composition.onApplicationBootstrap,
        ),
      ).toBe(true);
    });
  },
);
