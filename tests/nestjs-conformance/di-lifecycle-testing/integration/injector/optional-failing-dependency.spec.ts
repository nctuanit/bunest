import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Optional,
  Scope,
  UnauthorizedException,
} from "../../../../../packages/core/src/common";
import {
  ContextIdFactory,
  ModuleRef,
  REQUEST,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";

@Injectable({ scope: Scope.REQUEST })
class CurrentUser {
  readonly name: string;

  constructor(@Inject(REQUEST) request: { user?: string }) {
    if (!request.user) {
      throw new UnauthorizedException();
    }
    this.name = request.user;
  }
}

@Injectable({ scope: Scope.REQUEST })
class ConstructorHost {
  constructor(@Optional() readonly user?: CurrentUser) {}
}

@Injectable({ scope: Scope.REQUEST })
class PropertyHost {
  @Optional() @Inject(CurrentUser) readonly user?: CurrentUser;
}

@Injectable({ scope: Scope.REQUEST })
class MissingAndFailingHost {
  constructor(
    @Optional() @Inject("MISSING") readonly missing?: unknown,
    @Optional() readonly user?: CurrentUser,
  ) {}
}

describeConformance(
  "Optional dependency that fails to instantiate",
  {
    upstreamPath:
      "integration/injector/e2e/optional-failing-dependency.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-012"],
    notes:
      "Host consumers of request-scoped CurrentUser explicitly declare Scope.REQUEST per ADR-012; also verifies fail-fast ScopeLeakException if left singleton.",
  },
  () => {
    let moduleRef: TestingModule;

    beforeEach(async () => {
      moduleRef = await Test.createTestingModule({
        providers: [
          CurrentUser,
          ConstructorHost,
          PropertyHost,
          MissingAndFailingHost,
        ],
      }).compile();
    });

    afterEach(async () => {
      await moduleRef.close();
    });

    const contextOf = (request: { user?: string }) => {
      const contextId = ContextIdFactory.create();
      moduleRef.registerRequestByContextId(request, contextId);
      return contextId;
    };

    itAdapted(
      "ADR-012",
      "should reject singleton host with @Optional() request-scoped dependency at bootstrap",
      async () => {
        @Injectable()
        class SingletonConstructorHost {
          constructor(@Optional() readonly user?: CurrentUser) {}
        }

        await expectScopeLeak(() =>
          Test.createTestingModule({
            providers: [CurrentUser, SingletonConstructorHost],
          }).compile(),
        );
      },
    );

    describe.each([
      { name: "ConstructorHost", host: ConstructorHost },
      { name: "PropertyHost", host: PropertyHost },
      { name: "MissingAndFailingHost", host: MissingAndFailingHost },
    ])("$name", ({ host }) => {
      it("should be rejected by ModuleRef#resolve()", async () => {
        await expect(
          moduleRef.resolve(host, contextOf({})),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      });

      it("should be rejected by ModuleRef#create()", async () => {
        await expect(
          moduleRef.get(ModuleRef).create(host, contextOf({})),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      });

      it("should get the dependency when it is instantiated", async () => {
        const contextId = contextOf({ user: "alice" });
        const resolved = await moduleRef.resolve(host, contextId);
        const created = await moduleRef.get(ModuleRef).create(host, contextId);

        expect(resolved.user!.name).toBe("alice");
        expect(created.user).toBe(resolved.user);
      });
    });

    it('should still inject "undefined" for a missing dependency', async () => {
      const contextId = contextOf({ user: "alice" });
      const resolved = await moduleRef.resolve(
        MissingAndFailingHost,
        contextId,
      );
      const created = await moduleRef
        .get(ModuleRef)
        .create(MissingAndFailingHost, contextId);

      expect(resolved.missing).toBeUndefined();
      expect(created.missing).toBeUndefined();
    });

    // BUNEST_BUG: resolveDependencyToken does not swallow instantiation errors of optional transient factory dependencies during bootstrap and inject undefined (packages/core/src/di/di-container.ts:3426, 3629)
    it.skip('should still inject "undefined" at bootstrap for a transient dependency that fails', async () => {
      const testingModule = await Test.createTestingModule({
        providers: [
          {
            provide: "FAILING",
            scope: Scope.TRANSIENT,
            useFactory: () => {
              throw new Error("failing");
            },
          },
          {
            provide: "FACTORY",
            useFactory: (dependency?: unknown) => dependency ?? "DEFAULT_VALUE",
            inject: [{ token: "FAILING", optional: true }],
          },
        ],
      }).compile();

      expect(testingModule.get("FACTORY")).toBe("DEFAULT_VALUE");
      await testingModule.close();
    });
  },
);
