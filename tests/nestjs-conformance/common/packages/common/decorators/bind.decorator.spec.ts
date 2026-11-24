import { expect } from "bun:test";
import {
  Bind,
  METADATA_KEYS,
  MetadataRegistry,
  Req,
} from "../../../../../../packages/core/src/common";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "@Bind",
  {
    upstreamPath: "packages/common/test/decorators/bind.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002", "ADR-004"],
    notes:
      "Bunest stores parameter metadata under METADATA_KEYS.ROUTE_PARAMS on the method prototype as an indexed ParameterMetadata[] array.",
  },
  () => {
    class TestWithMethod {
      @Bind(Req())
      public test() {}
    }

    itAdapted(
      ["ADR-002", "ADR-004"],
      "should enhance method - bind each decorator to method",
      () => {
        const metadata = MetadataRegistry.get(
          METADATA_KEYS.ROUTE_PARAMS,
          TestWithMethod.prototype,
          "test",
        );

        expect(metadata).toEqual([
          {
            index: 0,
            source: "request",
          },
        ]);
      },
      "indexed ParameterMetadata[] on prototype",
    );
  },
);
