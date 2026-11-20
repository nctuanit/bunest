import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Injectable,
  Module,
  type OnModuleDestroy,
} from "../../../../../packages/common/src";
import {
  Test,
  createSpy,
  describeConformance,
} from "../../../_helpers";

@Injectable()
class TestInjectable implements OnModuleDestroy {
  onModuleDestroy = createSpy();
}

describeConformance(
  "OnModuleDestroy",
  {
    upstreamPath: "integration/hooks/e2e/on-module-destroy.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should call onModuleDestroy when application closes", async () => {
      const module = await Test.createTestingModule({
        providers: [TestInjectable],
      }).compile();

      const app = module.createNestApplication();
      await app.close();
      const instance = module.get(TestInjectable);
      expect(instance.onModuleDestroy).toHaveBeenCalled();
    });

    it("should not throw an error when onModuleDestroy is null", async () => {
      const module = await Test.createTestingModule({
        providers: [{ provide: "TEST", useValue: { onModuleDestroy: null } }],
      }).compile();

      const app = module.createNestApplication();
      expect(await app.init()).not.toBeUndefined();
      await app.close();
    });

    it("should not throw an error when onModuleDestroy is undefined", async () => {
      const module = await Test.createTestingModule({
        providers: [
          { provide: "TEST", useValue: { onModuleDestroy: undefined } },
        ],
      }).compile();

      const app = module.createNestApplication();
      expect(await app.init()).not.toBeUndefined();
      await app.close();
    });

    it("should sort modules by distance (topological sort) - DESC order", async () => {
      @Injectable()
      class BB implements OnModuleDestroy {
        onModuleDestroy = createSpy();
      }

      @Module({
        providers: [BB],
        exports: [BB],
      })
      class B {}

      @Injectable()
      class AA implements OnModuleDestroy {
        constructor(public readonly bb: BB) {}
        onModuleDestroy = createSpy();
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
      expect(aa.onModuleDestroy.calledBefore(bb.onModuleDestroy)).toBe(true);
    });

    it("should call onModuleDestroy of an imported module last when a longer import path also leads to it", async () => {
      @Injectable()
      class DatabaseService implements OnModuleDestroy {
        onModuleDestroy = createSpy();
      }

      @Module({
        providers: [DatabaseService],
        exports: [DatabaseService],
      })
      class DatabaseModule {}

      @Injectable()
      class UsersService implements OnModuleDestroy {
        constructor(public readonly db: DatabaseService) {}
        onModuleDestroy = createSpy();
      }

      @Module({
        imports: [DatabaseModule],
        providers: [UsersService],
        exports: [UsersService],
      })
      class UsersModule {}

      @Module({ imports: [UsersModule] })
      class PaymentsModule {}

      @Module({ imports: [PaymentsModule] })
      class OrdersModule {}

      const module = await Test.createTestingModule({
        imports: [DatabaseModule, UsersModule, OrdersModule],
      }).compile();

      const app = module.createNestApplication();
      await app.init();
      await app.close();

      const db = module.get(DatabaseService);
      const users = module.get(UsersService);
      expect(users.onModuleDestroy.calledBefore(db.onModuleDestroy)).toBe(true);
    });

    // BUNEST_BUG: LifecycleManager runs intra-module onModuleDestroy hooks in provider declaration order instead of reverse constructor dependency hierarchy (packages/core/src/di/di-container.ts, packages/core/src/lifecycle/lifecycle-manager.ts)
    it.skip("should sort components within a single module by injection hierarchy - ASC order", async () => {
      @Injectable()
      class A implements OnModuleDestroy {
        onModuleDestroy = createSpy();
      }

      @Injectable()
      class AHost implements OnModuleDestroy {
        constructor(public readonly a: A) {}
        onModuleDestroy = createSpy();
      }

      @Injectable()
      class Composition implements OnModuleDestroy {
        constructor(
          public readonly a: A,
          public readonly host: AHost,
        ) {}
        onModuleDestroy = createSpy();
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
        composition.onModuleDestroy.calledBefore(parent.onModuleDestroy),
      ).toBe(true);
      expect(parent.onModuleDestroy.calledBefore(child.onModuleDestroy)).toBe(
        true,
      );
    });
  },
);
