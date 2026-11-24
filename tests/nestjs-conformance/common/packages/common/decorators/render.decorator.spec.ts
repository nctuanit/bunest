import { expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  Render,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "@Render",
  {
    upstreamPath: "packages/common/test/decorators/render.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    const template = "template";

    class Test {
      @Render("template")
      public static test() {}
    }

    it("should enhance method with expected template string", () => {
      const metadata = MetadataRegistry.get(METADATA_KEYS.RENDER, Test.test);
      expect(metadata).toEqual(template);
    });
  },
);
