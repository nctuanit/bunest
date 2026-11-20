import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  Optional,
} from "../../../../../../packages/common/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "@Optional",
  {
    upstreamPath: "packages/common/test/decorators/optional.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest sorts constructor optional indices ascending ([0, 1]) under METADATA_KEYS.OPTIONAL_DEPS and merges subclass optional properties across prototype chain via MetadataRegistry.getOptionalPropertyDeps().",
  },
  () => {
    class Test {
      constructor(
        @Optional() _param1?: unknown,
        @Optional() _param2?: unknown,
      ) {}
    }

    class PropertyTest {
      @Optional() property1?: string;
      @Optional() property2?: number;
    }

    class ChildPropertyTest extends PropertyTest {
      @Optional() property3?: boolean;
    }

    itAdapted(
      "ADR-002",
      "should enhance class with expected constructor params metadata",
      () => {
        const metadata = MetadataRegistry.get(
          METADATA_KEYS.OPTIONAL_DEPS,
          Test,
        );
        expect(metadata).toEqual([0, 1]);
      },
      "indices sorted ascending in METADATA_KEYS.OPTIONAL_DEPS",
    );

    it("should enhance class with expected property metadata", () => {
      const metadata = MetadataRegistry.getOptionalPropertyDeps(PropertyTest);
      expect(metadata).toEqual(["property1", "property2"]);
    });

    it("should enhance subclass with expected property metadata", () => {
      const metadata =
        MetadataRegistry.getOptionalPropertyDeps(ChildPropertyTest);
      expect(metadata).toEqual(["property1", "property2", "property3"]);
      // Parent remains unmutated
      expect(MetadataRegistry.getOptionalPropertyDeps(PropertyTest)).toEqual([
        "property1",
        "property2",
      ]);
    });
  },
);
