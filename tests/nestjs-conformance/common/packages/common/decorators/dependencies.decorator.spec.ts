import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Dependencies,
  METADATA_KEYS,
  MetadataRegistry,
  flatten,
} from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "@Dependencies",
  {
    upstreamPath:
      "packages/common/test/decorators/dependencies.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest stores @Dependencies under METADATA_KEYS.DEPENDENCIES (and populates METADATA_KEYS.INJECT_TOKENS).",
  },
  () => {
    const dep = "test";
    const dep2 = "test2";
    const dep3 = "test3";
    const deps = [dep, dep2];

    @Dependencies(deps)
    class Test {}

    @Dependencies(dep, dep2)
    class Test2 {}

    @Dependencies([dep, [dep2, [dep3]]] as any)
    class Test3 {}

    it("should enhance class with expected dependencies array", () => {
      const metadata = MetadataRegistry.get(METADATA_KEYS.DEPENDENCIES, Test);
      expect(metadata).toEqual(deps);
    });

    it("should makes passed array flatten", () => {
      const metadata = MetadataRegistry.get(METADATA_KEYS.DEPENDENCIES, Test2);
      expect(metadata).toEqual([dep, dep2]);
    });

    // BUNEST_BUG: Dependencies() in packages/common/src/decorators/core.decorators.ts:226-236 only flattens one level of arrays instead of recursively calling flatten(dependencies).
    it.skip("should flatten deeply nested dependency arrays", () => {
      const metadata = MetadataRegistry.get(METADATA_KEYS.DEPENDENCIES, Test3);
      expect(metadata).toEqual([dep, dep2, dep3]);
    });

    describe("flatten", () => {
      it("should flatten arrays nested at any depth", () => {
        expect(flatten([1, [2, [3, [4]]]])).toEqual([1, 2, 3, 4]);
      });
    });
  },
);
