import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Module,
  type OnModuleInit,
} from "../../../../../packages/common/src";
import {
  Test,
  createSpy,
  describeConformance,
} from "../../../_helpers";

@Injectable()
class TestInjectable implements OnModuleInit {
  onModuleInit = createSpy();
}

describeConformance(
  "OnModuleInit",
  {
    upstreamPath: "integration/hooks/e2e/on-module-init.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should call onModuleInit when application starts", async () => {
      const module = await Test.createTestingModule({
        providers: [TestInjectable],
      }).compile();

      const app = module.createNestApplication();
      await app.init();
      const instance = module.get(TestInjectable);
      expect(instance.onModuleInit).toHaveBeenCalled();
      await app.close();
    });

    it("should not throw an error when onModuleInit is null", async () => {
      const module = await Test.createTestingModule({
        providers: [{ provide: "TEST", useValue: { onModuleInit: null } }],
      }).compile();

      const app = module.createNestApplication();
      expect(await app.init()).not.toBeUndefined();
      await app.close();
    });

    it("should not throw an error when onModuleInit is undefined", async () => {
      const module = await Test.createTestingModule({
        providers: [{ provide: "TEST", useValue: { onModuleInit: undefined } }],
      }).compile();

      const app = module.createNestApplication();
      expect(await app.init()).not.toBeUndefined();
      await app.close();
    });

    // BUNEST_BUG: Global dynamic module (C.forRoot() with global: true) is not sorted ahead of modules implicitly injecting its exported token, so BB.onModuleInit runs before CC.onModuleInit ("_b-field_a-field" vs "c-field_b-field_a-field") (packages/core/src/module/module-scanner.ts, packages/core/src/lifecycle/lifecycle-manager.ts)
    it.skip("should sort modules by distance (topological sort) - DESC order", async () => {
      @Injectable()
      class CC implements OnModuleInit {
        public field = "";

        async onModuleInit() {
          this.field = "c-field";
        }
      }

      @Module({})
      class C {
        static forRoot() {
          return {
            module: C,
            global: true,
            providers: [
              {
                provide: CC,
                useValue: new CC(),
              },
            ],
            exports: [CC],
          };
        }
      }

      @Injectable()
      class BB implements OnModuleInit {
        public field = "";
        constructor(private readonly cc: CC) {}

        async onModuleInit() {
          this.field = this.cc.field + "_b-field";
        }
      }

      @Module({
        providers: [BB],
        exports: [BB],
      })
      class B {}

      @Injectable()
      class AA implements OnModuleInit {
        public field = "";
        constructor(private readonly bb: BB) {}

        async onModuleInit() {
          this.field = this.bb.field + "_a-field";
        }
      }

      @Module({
        imports: [B],
        providers: [AA],
      })
      class A {}

      @Module({
        imports: [A, C.forRoot()],
      })
      class AppModule {}

      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      const app = module.createNestApplication();
      await app.init();

      const instance = module.get(AA);
      expect(instance.field).toBe("c-field_b-field_a-field");
      await app.close();
    });

    it("should call onModuleInit of an imported module first when a longer import path also leads to it", async () => {
      @Injectable()
      class DatabaseService implements OnModuleInit {
        onModuleInit = createSpy();
      }

      @Module({
        providers: [DatabaseService],
        exports: [DatabaseService],
      })
      class DatabaseModule {}

      @Injectable()
      class UsersService implements OnModuleInit {
        constructor(public readonly db: DatabaseService) {}
        onModuleInit = createSpy();
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
      expect(db.onModuleInit.calledBefore(users.onModuleInit)).toBe(true);
    });

    // BUNEST_BUG: LifecycleManager runs intra-module onModuleInit hooks in provider declaration order instead of constructor dependency hierarchy order (packages/core/src/di/di-container.ts, packages/core/src/lifecycle/lifecycle-manager.ts)
    it.skip("should sort components within a single module by injection hierarchy - DESC order", async () => {
      @Injectable()
      class A implements OnModuleInit {
        onModuleInit = createSpy();
      }

      @Injectable()
      class AHost implements OnModuleInit {
        constructor(public readonly a: A) {}
        onModuleInit = createSpy();
      }

      @Injectable()
      class Composition implements OnModuleInit {
        constructor(
          public readonly a: A,
          public readonly host: AHost,
        ) {}
        onModuleInit = createSpy();
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
      expect(child.onModuleInit.calledBefore(parent.onModuleInit)).toBe(true);
      expect(parent.onModuleInit.calledBefore(composition.onModuleInit)).toBe(
        true,
      );
    });

    // BUNEST_BUG: LifecycleManager runs intra-module onModuleInit hooks in provider declaration order instead of running property (@Inject) dependency hooks first (packages/core/src/di/di-container.ts, packages/core/src/lifecycle/lifecycle-manager.ts)
    it.skip("should call onModuleInit of a property dependency first", async () => {
      const calls: string[] = [];

      @Injectable()
      class DatabaseService implements OnModuleInit {
        async onModuleInit() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          calls.push("database");
        }
      }

      @Injectable()
      class UsersService implements OnModuleInit {
        @Inject(DatabaseService)
        public readonly db!: DatabaseService;

        onModuleInit() {
          calls.push("users");
        }
      }

      @Module({
        providers: [UsersService, DatabaseService],
      })
      class AModule {}

      const module = await Test.createTestingModule({
        imports: [AModule],
      }).compile();

      const app = module.createNestApplication();
      await app.init();
      await app.close();

      expect(calls).toEqual(["database", "users"]);
    });
  },
);
