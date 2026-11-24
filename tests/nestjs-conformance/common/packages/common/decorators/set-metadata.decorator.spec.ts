import { expect, it } from "bun:test";
import {
  MetadataRegistry,
  SetMetadata,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "@SetMetadata",
  {
    upstreamPath:
      "packages/common/test/decorators/set-metadata.decorator.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    const key = "key";
    const value = "value";

    @SetMetadata(key, value)
    class Test {}

    class TestWithMethod {
      @SetMetadata(key, value)
      public static test() {}
    }

    it("should enhance class with expected metadata", () => {
      const metadata = MetadataRegistry.get(key, Test);
      expect(metadata).toEqual(value);
    });

    it("should enhance method with expected metadata", () => {
      const metadata = MetadataRegistry.get(key, TestWithMethod.test);
      expect(metadata).toEqual(value);
    });
  },
);
