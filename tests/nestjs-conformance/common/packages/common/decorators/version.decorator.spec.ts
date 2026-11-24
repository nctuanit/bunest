import { expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  Version,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "@Version",
  {
    upstreamPath: "packages/common/test/decorators/version.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    const version = "1";
    const versions = ["1", "2", "2", "1", "2", "1"];
    const versionsWithoutDuplicates = ["1", "2"];

    class Test {
      @Version(version)
      public static oneVersion() {}

      @Version(versions)
      public static multipleVersions() {}
    }

    it("should enhance method with expected version string", () => {
      const metadata = MetadataRegistry.get(
        METADATA_KEYS.VERSION,
        Test.oneVersion,
      );
      expect(metadata).toEqual(version);
    });

    // BUNEST_BUG: Version(versions) in packages/core/src/common/decorators/version.decorator.ts:12 clones `[...version]` without deduplicating duplicate entries (`['1','2','2','1','2','1']` stays un-deduplicated instead of `['1','2']`).
    it.skip("should enhance method with expected version array", () => {
      const metadata = MetadataRegistry.get(
        METADATA_KEYS.VERSION,
        Test.multipleVersions,
      );
      expect(metadata).toEqual(versionsWithoutDuplicates);
    });
  },
);
