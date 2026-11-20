import "reflect-metadata";
import { expect } from "bun:test";
import {
  Header,
  METADATA_KEYS,
  MetadataRegistry,
} from "../../../../../../packages/common/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "@Header",
  {
    upstreamPath: "packages/common/test/decorators/header.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002", "ADR-006"],
    notes:
      "Per ADR-006 §3, Bunest @Header() uses copy-on-write prependOwnArray to accumulate stacked headers in top-to-bottom declaration order.",
  },
  () => {
    class Test {
      @Header("Content-Type", "Test")
      @Header("Authorization", "JWT")
      public static test() {}
    }

    itAdapted(
      "ADR-006",
      "should enhance method with expected headers in declaration order",
      () => {
        const metadata = MetadataRegistry.get(METADATA_KEYS.HEADERS, Test.test);
        expect(metadata).toEqual([
          { name: "Content-Type", value: "Test" },
          { name: "Authorization", value: "JWT" },
        ]);
      },
      "top-to-bottom declaration order via prependOwnArray",
    );
  },
);
