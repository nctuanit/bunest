import { expect, it } from "bun:test";
import {
  Global,
  METADATA_KEYS,
  MetadataRegistry,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "@Global",
  {
    upstreamPath: "packages/common/test/decorators/global.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    @Global()
    class Test {}

    it("should enrich metatype with GlobalModule metadata", () => {
      const isGlobal = MetadataRegistry.get(METADATA_KEYS.GLOBAL_MODULE, Test);
      expect(isGlobal).toBe(true);
    });
  },
);
