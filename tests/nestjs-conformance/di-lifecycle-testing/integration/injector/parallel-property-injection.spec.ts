import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Module,
  Scope,
} from "../../../../../packages/core/src/common";
import {
  INQUIRER,
  REQUEST,
  createContextId,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  type TestingModule,
} from "../../../_helpers";

@Injectable()
class UnrelatedProvider {}

@Module({ providers: [UnrelatedProvider], exports: [UnrelatedProvider] })
class UnrelatedModule {}

@Injectable()
class ImportedProvider {}

@Module({ providers: [ImportedProvider], exports: [ImportedProvider] })
class ImportedModule {}

@Injectable()
class LocalProvider {}

@Injectable({ scope: Scope.REQUEST })
class PropertyInjectedProvider {
  @Inject(LocalProvider)
  public readonly local!: LocalProvider;

  @Inject(ImportedProvider)
  public readonly imported!: ImportedProvider;

  @Inject(REQUEST)
  public readonly request!: { requestId: string };
}

@Injectable({ scope: Scope.TRANSIENT })
class InquirerAwareProvider {
  @Inject(LocalProvider)
  public readonly local!: LocalProvider;

  @Inject(INQUIRER)
  public readonly inquirer: unknown;
}

@Injectable({ scope: Scope.REQUEST })
class InquirerAwareProviderHost {
  constructor(public readonly dependency: InquirerAwareProvider) {}
}

@Module({
  imports: [UnrelatedModule, ImportedModule],
  providers: [
    LocalProvider,
    PropertyInjectedProvider,
    InquirerAwareProvider,
    InquirerAwareProviderHost,
  ],
})
class ParallelModule {}

describeConformance(
  "Parallel property injection",
  {
    upstreamPath:
      "integration/injector/e2e/parallel-property-injection.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-012"],
    notes:
      "All providers already declare explicit scopes (Scope.REQUEST / Scope.TRANSIENT), conforming directly to ADR-012.",
  },
  () => {
    let testingModule: TestingModule;

    beforeEach(async () => {
      testingModule = await Test.createTestingModule({
        imports: [ParallelModule],
      }).compile();
    });

    afterEach(async () => {
      await testingModule.close();
    });

    it("should inject every property into overlapping first resolutions", async () => {
      const requests = [{ requestId: "first" }, { requestId: "second" }];
      const contextIds = requests.map((request) => {
        const contextId = createContextId();
        testingModule.registerRequestByContextId(request, contextId);
        return contextId;
      });

      const providers = await Promise.all(
        contextIds.map((contextId) =>
          testingModule.resolve(PropertyInjectedProvider, contextId),
        ),
      );

      providers.forEach((provider, index) => {
        expect(provider.local).toBeInstanceOf(LocalProvider);
        expect(provider.imported).toBeInstanceOf(ImportedProvider);
        expect(provider.request).toBe(requests[index]!);
      });
    });

    it("should keep injecting a property that is not registered as metadata", async () => {
      for (const requestId of ["first", "second"]) {
        const contextId = createContextId();
        testingModule.registerRequestByContextId({ requestId }, contextId);
        const host = await testingModule.resolve(
          InquirerAwareProviderHost,
          contextId,
        );

        expect(host.dependency.local).toBeInstanceOf(LocalProvider);
        expect(host.dependency.inquirer).toBeInstanceOf(
          InquirerAwareProviderHost,
        );
      }
    });
  },
);
