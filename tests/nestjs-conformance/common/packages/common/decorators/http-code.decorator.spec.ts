import { expect, it } from "bun:test";
import {
  HttpCode,
  METADATA_KEYS,
  MetadataRegistry,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "@HttpCode",
  {
    upstreamPath: "packages/common/test/decorators/http-code.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    const httpCode = 200;
    class Test {
      @HttpCode(httpCode)
      public static test() {}
    }

    it("should enhance method with expected http status code", () => {
      const metadata = MetadataRegistry.get(METADATA_KEYS.HTTP_CODE, Test.test);
      expect(metadata).toEqual(httpCode);
    });
  },
);
