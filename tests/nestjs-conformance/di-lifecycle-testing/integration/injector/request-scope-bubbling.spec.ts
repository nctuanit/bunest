import { expect } from "bun:test";
import { Injectable, Module, Scope } from "../../../../../packages/core/src/common";
import { ContextIdFactory } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
} from "../../../_helpers";

describeConformance(
  "Request Scope Bubbling (ADR-012 Fail-Fast)",
  {
    upstreamPath: "integration/injector/e2e/request-scope-bubbling.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-012"],
    notes:
      "Upstream NestJS silently downgrades a Singleton depending on a Request-scoped provider; Bunest ADR-012 intentionally rejects this at bootstrap with ScopeLeakException and requires explicit Scope.REQUEST declaration.",
  },
  () => {
    @Injectable({ scope: Scope.REQUEST })
    class ChildService {
      public readonly id = Math.random();
    }

    itAdapted(
      "ADR-012",
      "should throw ScopeLeakException instead of silently downgrading a Singleton depending on a Request-Scoped provider",
      async () => {
        @Injectable()
        class ParentService {
          constructor(public readonly child: ChildService) {}
        }

        @Module({
          providers: [ChildService, ParentService],
        })
        class TestModule {}

        await expectScopeLeak(() =>
          Test.createTestingModule({
            imports: [TestModule],
          }).compile(),
        );
      },
    );

    itAdapted(
      "ADR-012",
      "should create isolated instances per request context when ParentService explicitly declares Scope.REQUEST",
      async () => {
        @Injectable({ scope: Scope.REQUEST })
        class ParentService {
          constructor(public readonly child: ChildService) {}
        }

        @Module({
          providers: [ChildService, ParentService],
        })
        class ExplicitScopedModule {}

        const moduleRef = await Test.createTestingModule({
          imports: [ExplicitScopedModule],
        }).compile();

        const contextId1 = ContextIdFactory.create();
        const parent1 = await moduleRef.resolve(ParentService, contextId1);

        const contextId2 = ContextIdFactory.create();
        const parent2 = await moduleRef.resolve(ParentService, contextId2);

        expect(parent1.child.id).not.toBe(parent2.child.id);
        expect(parent1).not.toBe(parent2);
        await moduleRef.close();
      },
    );
  },
);
