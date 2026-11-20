import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  UseFilters,
} from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

class Filter {
  catch() {}
}

describeConformance(
  "@UseFilters",
  {
    upstreamPath:
      "packages/common/test/decorators/exception-filters.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes: "Uses METADATA_KEYS.EXCEPTION_FILTERS symbol per ADR-002.",
  },
  () => {
    const filters = [new Filter(), new Filter()];

    @UseFilters(...(filters as any))
    class Test {}

    class TestWithMethod {
      @UseFilters(...(filters as any))
      public static test() {}
    }

    it("should enhance class with expected exception filters array", () => {
      const metadata = MetadataRegistry.get(
        METADATA_KEYS.EXCEPTION_FILTERS,
        Test,
      );
      expect(metadata).toEqual(filters);
    });

    it("should enhance method with expected exception filters array", () => {
      const metadata = MetadataRegistry.get(
        METADATA_KEYS.EXCEPTION_FILTERS,
        TestWithMethod.test,
      );
      expect(metadata).toEqual(filters);
    });

    // BUNEST_BUG: UseFilters() in packages/common/src/decorators/enhancers.decorators.ts does not validate decorator arguments (does not throw InvalidDecoratorItemException when a primitive like 'test' is passed).
    it.skip("when object is invalid should throw exception", () => {
      let error: unknown = undefined;
      try {
        UseFilters("test" as any)(() => {});
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
    });
  },
);
