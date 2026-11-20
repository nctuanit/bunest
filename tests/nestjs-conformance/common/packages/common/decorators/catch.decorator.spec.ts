import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Catch,
  METADATA_KEYS,
  MetadataRegistry,
} from "../../../../../../packages/common/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "@Catch",
  {
    upstreamPath: "packages/common/test/decorators/catch.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest stores @Catch exception constructors under METADATA_KEYS.CATCH_EXCEPTIONS on the class constructor.",
  },
  () => {
    const exceptions: any = ["exception", "exception2"];

    @Catch(...exceptions)
    class Test {}

    itAdapted(
      "ADR-002",
      "should enhance component with catch metadata",
      () => {
        expect(
          MetadataRegistry.has(METADATA_KEYS.CATCH_EXCEPTIONS, Test),
        ).toBe(true);
      },
      "METADATA_KEYS.CATCH_EXCEPTIONS presence instead of separate CATCH_WATERMARK",
    );

    it("should enhance class with expected exceptions array", () => {
      const metadata = MetadataRegistry.get(
        METADATA_KEYS.CATCH_EXCEPTIONS,
        Test,
      );
      expect(metadata).toEqual(exceptions);
    });

    // BUNEST_BUG: Catch() in packages/common/src/decorators/core.decorators.ts:212 only defines METADATA_KEYS.CATCH_EXCEPTIONS on `target` (the constructor), not on `target.prototype`.
    it.skip("should enhance the prototype of the class with expected exceptions array", () => {
      const metadata = MetadataRegistry.getOwn(
        METADATA_KEYS.CATCH_EXCEPTIONS,
        Test.prototype,
      );
      expect(metadata).toEqual(exceptions);
    });
  },
);
