import { describe, expect, it } from "bun:test";
import { Module, Scope } from "../../../../../packages/core/src/common";
import { Test, describeConformance } from "../../../_helpers";

@Module({
  providers: [
    {
      provide: "MULTI_PROVIDER",
      useValue: "A",
    },
    {
      provide: "REQ_SCOPED_MULTI_PROVIDER",
      useFactory: () => "A",
      scope: Scope.REQUEST,
    },
  ],
})
class AModule {}

@Module({
  providers: [
    {
      provide: "MULTI_PROVIDER",
      useValue: "B",
    },
    {
      provide: "REQ_SCOPED_MULTI_PROVIDER",
      useFactory: () => "B",
      scope: Scope.REQUEST,
    },
  ],
})
class BModule {}

@Module({
  providers: [
    {
      provide: "MULTI_PROVIDER",
      useValue: "C",
    },
    {
      provide: "REQ_SCOPED_MULTI_PROVIDER",
      useFactory: () => "C",
      scope: Scope.REQUEST,
    },
  ],
})
class CModule {}

@Module({
  imports: [AModule, BModule, CModule],
})
class MultipleProvidersModule {}

describeConformance(
  'Multiple providers under the same token ("each" feature)',
  {
    upstreamPath: "integration/injector/e2e/multiple-providers.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    describe("get()", () => {
      it("should return an array of providers", async () => {
        const builder = Test.createTestingModule({
          imports: [MultipleProvidersModule],
        });
        const testingModule = await builder.compile();

        const multiProviderInstances = testingModule.get<string>(
          "MULTI_PROVIDER",
          {
            each: true,
          },
        );

        // @ts-expect-error: make sure "multiProviderInstances" is string[] not string
        multiProviderInstances.charAt;

        expect(multiProviderInstances).toEqual(["A", "B", "C"]);
        await testingModule.close();
      });
    });

    describe("resolve()", () => {
      it("should return an array of request-scoped providers", async () => {
        const builder = Test.createTestingModule({
          imports: [MultipleProvidersModule],
        });
        const testingModule = await builder.compile();

        const multiProviderInstances = await testingModule.resolve<string>(
          "REQ_SCOPED_MULTI_PROVIDER",
          undefined,
          {
            each: true,
          },
        );

        // @ts-expect-error: make sure "multiProviderInstances" is string[] not string
        multiProviderInstances.charAt;

        expect(multiProviderInstances).toEqual(["A", "B", "C"]);
        await testingModule.close();
      });

      it("should return an array of default-scoped providers", async () => {
        const builder = Test.createTestingModule({
          imports: [MultipleProvidersModule],
        });
        const testingModule = await builder.compile();

        const multiProviderInstances = await testingModule.resolve<string>(
          "MULTI_PROVIDER",
          undefined,
          {
            each: true,
          },
        );

        // @ts-expect-error: make sure "multiProviderInstances" is string[] not string
        multiProviderInstances.charAt;

        expect(multiProviderInstances).toEqual(["A", "B", "C"]);
        await testingModule.close();
      });
    });
  },
);
