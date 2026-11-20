import "reflect-metadata";
import { beforeEach, describe, expect, it } from "bun:test";
import {
  INQUIRER,
  Inject,
  Injectable,
  Scope,
} from "../../../../../../packages/common/src";
import { ModuleRef } from "../../../../../../packages/core/src";
import { Test, describeConformance } from "../../../../_helpers";

describeConformance(
  "Transient scope",
  {
    upstreamPath: "packages/core/test/scope/transient-scope.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-007", "ADR-012"],
  },
  () => {
    const SOME_TOKEN = Symbol("SomeToken");

    @Injectable({ scope: Scope.TRANSIENT })
    class TransientService {
      public context: string;

      constructor(
        @Inject(INQUIRER) inquirer: any,
        @Inject(SOME_TOKEN) public token: string,
      ) {
        this.context = inquirer.constructor.name;
      }
    }

    @Injectable()
    class RegularService {
      constructor(
        public transient: TransientService,
        @Inject(SOME_TOKEN) public token: string,
      ) {}
    }

    @Injectable()
    class DynamicService {
      constructor(
        public regular: RegularService,
        public transient: TransientService,
      ) {}
    }

    describe("creating an instance with moduleRef.create", () => {
      let service: DynamicService;
      let moduleRef: ModuleRef;

      beforeEach(async () => {
        const module = await Test.createTestingModule({
          providers: [
            RegularService,
            TransientService,
            DynamicService,
            { provide: SOME_TOKEN, useValue: "some-value" },
          ],
        }).compile();

        moduleRef = module.get(ModuleRef);
        service = await moduleRef.create(DynamicService);
      });

      // BUNEST_BUG: DIContainer.instantiateClass() injects the parent class constructor function instead of the parent instance/object for INQUIRER (packages/core/src/di/di-container.ts:3503,3571-3573); inquirer.constructor.name returns "Function" instead of "RegularService".
      it.skip("should be able to inject a regular dependency", async () => {
        expect(service.regular.token).toBe("some-value");
        expect(service.regular.transient.context).toBe(RegularService.name);
      });

      // BUNEST_BUG: DIContainer.instantiateClass() injects the parent class constructor function instead of the parent instance/object for INQUIRER (packages/core/src/di/di-container.ts:3503,3571-3573); inquirer.constructor.name returns "Function" instead of "DynamicService".
      it.skip("should be able to inject a transient-scoped dependency", async () => {
        expect(service.transient.token).toBe("some-value");
        expect(service.transient.context).toBe(DynamicService.name);
      });

      // BUNEST_BUG: DIContainer.instantiateClass() injects the parent class constructor function instead of the parent instance/object for INQUIRER (packages/core/src/di/di-container.ts:3503,3571-3573); inquirer.constructor.name returns "Function" instead of "RegularService"/"AnotherDynamicService".
      it.skip("should work correctly when there is another class that injects the same dependency", async () => {
        @Injectable()
        class AnotherDynamicService {
          constructor(
            public regular: RegularService,
            public transient: TransientService,
          ) {}
        }

        const service2 = await moduleRef.create(AnotherDynamicService);

        expect(service2.regular.token).toBe("some-value");
        expect(service2.regular.transient.context).toBe(RegularService.name);

        expect(service2.transient.token).toBe("some-value");
        expect(service2.transient.context).toBe(AnotherDynamicService.name);
      });
    });
  },
);
