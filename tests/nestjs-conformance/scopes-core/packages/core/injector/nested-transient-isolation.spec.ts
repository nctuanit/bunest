import { beforeEach, describe, expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Scope,
} from "../../../../../../packages/core/src/common";
import {
  Test,
  type TestingModule,
  describeConformance,
} from "../../../../_helpers";

describeConformance(
  "Nested Transient Isolation",
  {
    upstreamPath:
      "packages/core/test/injector/nested-transient-isolation.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-007", "ADR-012"],
    notes:
      "Adapted from NestJS internal Injector/InstanceWrapper calls to Bunest Test.createTestingModule + resolve/get.",
  },
  () => {
    describe("when TRANSIENT provider depends on another TRANSIENT provider", () => {
      @Injectable({ scope: Scope.TRANSIENT })
      class NestedTransientService {
        public static instanceCount = 0;
        public readonly instanceId: number;

        constructor() {
          NestedTransientService.instanceCount++;
          this.instanceId = NestedTransientService.instanceCount;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class TransientService {
        public static instanceCount = 0;
        public readonly instanceId: number;

        constructor(public readonly nested: NestedTransientService) {
          TransientService.instanceCount++;
          this.instanceId = TransientService.instanceCount;
        }
      }

      @Injectable({ scope: Scope.REQUEST })
      class RequestScopedParent1 {
        constructor(public readonly transient: TransientService) {}
      }

      @Injectable({ scope: Scope.REQUEST })
      class RequestScopedParent2 {
        constructor(public readonly transient: TransientService) {}
      }

      let moduleRef: TestingModule;

      beforeEach(async () => {
        NestedTransientService.instanceCount = 0;
        TransientService.instanceCount = 0;

        moduleRef = await Test.createTestingModule({
          providers: [
            NestedTransientService,
            TransientService,
            RequestScopedParent1,
            RequestScopedParent2,
          ],
        }).compile();
      });

      it("should create separate TRANSIENT instances for each parent", async () => {
        const contextId = { id: 1 };

        const parent1Instance = await moduleRef.resolve(
          RequestScopedParent1,
          contextId,
        );
        const parent2Instance = await moduleRef.resolve(
          RequestScopedParent2,
          contextId,
        );

        expect(parent1Instance.transient.instanceId).not.toBe(
          parent2Instance.transient.instanceId,
        );
      });

      it("should create separate nested TRANSIENT instances for each parent TRANSIENT", async () => {
        const contextId = { id: 1 };

        const parent1Instance = await moduleRef.resolve(
          RequestScopedParent1,
          contextId,
        );
        const parent2Instance = await moduleRef.resolve(
          RequestScopedParent2,
          contextId,
        );

        expect(parent1Instance.transient.nested.instanceId).not.toBe(
          parent2Instance.transient.nested.instanceId,
        );
      });

      it("should maintain isolation across multiple request contexts", async () => {
        const contextId1 = { id: 1 };
        const contextId2 = { id: 2 };

        const ctx1Parent1 = await moduleRef.resolve(
          RequestScopedParent1,
          contextId1,
        );
        const ctx1Parent2 = await moduleRef.resolve(
          RequestScopedParent2,
          contextId1,
        );
        const ctx2Parent1 = await moduleRef.resolve(
          RequestScopedParent1,
          contextId2,
        );

        // Different parents in same context
        expect(ctx1Parent1.transient.nested.instanceId).not.toBe(
          ctx1Parent2.transient.nested.instanceId,
        );

        // Same parent across different contexts
        expect(ctx1Parent1.transient.nested.instanceId).not.toBe(
          ctx2Parent1.transient.nested.instanceId,
        );
      });
    });

    describe("when TRANSIENT provider depends on another TRANSIENT provider through property injection", () => {
      @Injectable({ scope: Scope.TRANSIENT })
      class NestedTransientService {
        public static instanceCount = 0;
        public readonly instanceId: number;

        constructor() {
          NestedTransientService.instanceCount++;
          this.instanceId = NestedTransientService.instanceCount;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class TransientService {
        @Inject(NestedTransientService)
        public readonly nested!: NestedTransientService;
      }

      @Injectable({ scope: Scope.REQUEST })
      class RequestScopedParent1 {
        constructor(public readonly transient: TransientService) {}
      }

      @Injectable({ scope: Scope.REQUEST })
      class RequestScopedParent2 {
        constructor(public readonly transient: TransientService) {}
      }

      let moduleRef: TestingModule;

      beforeEach(async () => {
        NestedTransientService.instanceCount = 0;

        moduleRef = await Test.createTestingModule({
          providers: [
            NestedTransientService,
            TransientService,
            RequestScopedParent1,
            RequestScopedParent2,
          ],
        }).compile();
      });

      it("should create separate nested TRANSIENT instances for each parent on subsequent requests", async () => {
        const contextId1 = { id: 1 };
        const contextId2 = { id: 2 };

        await moduleRef.resolve(RequestScopedParent1, contextId1);
        await moduleRef.resolve(RequestScopedParent2, contextId1);
        const ctx2Parent1 = await moduleRef.resolve(
          RequestScopedParent1,
          contextId2,
        );
        const ctx2Parent2 = await moduleRef.resolve(
          RequestScopedParent2,
          contextId2,
        );

        expect(ctx2Parent1.transient.nested.instanceId).not.toBe(
          ctx2Parent2.transient.nested.instanceId,
        );
      });
    });

    describe("when DEFAULT scoped provider depends on nested TRANSIENT chain", () => {
      @Injectable({ scope: Scope.TRANSIENT })
      class NestedTransientService {
        public static constructorCalled = false;
        public static instanceCount = 0;
        public readonly instanceId: number;
        public readonly value = "nested-initialized";

        constructor() {
          NestedTransientService.constructorCalled = true;
          NestedTransientService.instanceCount++;
          this.instanceId = NestedTransientService.instanceCount;
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class TransientService {
        public static constructorCalled = false;
        public static instanceCount = 0;
        public readonly instanceId: number;

        constructor(public readonly nested: NestedTransientService) {
          TransientService.constructorCalled = true;
          TransientService.instanceCount++;
          this.instanceId = TransientService.instanceCount;
        }
      }

      @Injectable()
      class DefaultScopedParent {
        constructor(public readonly transient: TransientService) {}
      }

      @Injectable()
      class DefaultScopedParent2 {
        constructor(public readonly transient: TransientService) {}
      }

      let moduleRef: TestingModule;

      beforeEach(async () => {
        NestedTransientService.constructorCalled = false;
        NestedTransientService.instanceCount = 0;
        TransientService.constructorCalled = false;
        TransientService.instanceCount = 0;

        moduleRef = await Test.createTestingModule({
          providers: [
            NestedTransientService,
            TransientService,
            DefaultScopedParent,
            DefaultScopedParent2,
          ],
        }).compile();
      });

      it("should instantiate nested TRANSIENT providers from DEFAULT scope", () => {
        const parentInstance = moduleRef.get(DefaultScopedParent);

        expect(TransientService.constructorCalled).toBe(true);
        expect(NestedTransientService.constructorCalled).toBe(true);
        expect(parentInstance.transient).toBeInstanceOf(TransientService);
        expect(parentInstance.transient.nested).toBeInstanceOf(
          NestedTransientService,
        );
        expect(parentInstance.transient.nested.value).toBe(
          "nested-initialized",
        );
      });

      it("should isolate nested TRANSIENT instances across DEFAULT parents in STATIC context", () => {
        const parent1Instance = moduleRef.get(DefaultScopedParent);
        const parent2Instance = moduleRef.get(DefaultScopedParent2);

        expect(parent1Instance.transient.instanceId).not.toBe(
          parent2Instance.transient.instanceId,
        );
        expect(parent1Instance.transient.nested.instanceId).not.toBe(
          parent2Instance.transient.nested.instanceId,
        );
      });
    });
  },
);
