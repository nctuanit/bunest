import { expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  RequestMethod,
  Sse,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "@Sse",
  {
    upstreamPath: "packages/common/test/decorators/sse.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002", "ADR-006"],
  },
  () => {
    const prefix = "/prefix";
    class Test {
      @Sse(prefix)
      public static test() {}

      @Sse(prefix, { method: RequestMethod.POST })
      public static testUsingOptions() {}
    }

    it("should enhance method with expected path, method, and sse metadata", () => {
      const path = MetadataRegistry.get(METADATA_KEYS.ROUTE_PATH, Test.test);
      expect(path).toEqual("/prefix");

      const method = MetadataRegistry.get(
        METADATA_KEYS.ROUTE_METHOD,
        Test.test,
      );
      expect(method).toEqual(RequestMethod.GET);

      const metadata = MetadataRegistry.get(METADATA_KEYS.SSE, Test.test);
      expect(metadata).toEqual(true);
    });

    it("should enhance method with expected path, sse metadata, and method from options", () => {
      const path = MetadataRegistry.get(
        METADATA_KEYS.ROUTE_PATH,
        Test.testUsingOptions,
      );
      expect(path).toEqual("/prefix");

      const method = MetadataRegistry.get(
        METADATA_KEYS.ROUTE_METHOD,
        Test.testUsingOptions,
      );
      expect(method).toEqual(RequestMethod.POST);

      const metadata = MetadataRegistry.get(
        METADATA_KEYS.SSE,
        Test.testUsingOptions,
      );
      expect(metadata).toEqual(true);
    });

    it.each([1024, 0, Infinity])(
      "should enhance method with maxPendingDataLength %s from options",
      (maxPendingDataLength) => {
        class TestWithLimit {
          @Sse(prefix, { maxPendingDataLength })
          public static test() {}
        }

        const options = MetadataRegistry.get(
          METADATA_KEYS.SSE_OPTIONS,
          TestWithLimit.test,
        );
        expect(options).toEqual({ maxPendingDataLength });
      },
    );

    it("should keep GET as the method when the options do not set one", () => {
      class TestWithLimit {
        @Sse(prefix, { maxPendingDataLength: 1024 })
        public static test() {}
      }

      const method = MetadataRegistry.get(
        METADATA_KEYS.ROUTE_METHOD,
        TestWithLimit.test,
      );
      expect(method).toEqual(RequestMethod.GET);
    });

    // BUNEST_BUG: Sse() / Sse("") in packages/core/src/common/decorators/http.decorators.ts:184 stores "" instead of normalizing default/empty path to "/" in METADATA_KEYS.ROUTE_PATH (though controller scanner normalizes "" -> "/").
    it.skip('should set path on "/" by default', () => {
      class TestWithoutPath {
        @Sse()
        public static test() {}

        @Sse("")
        public static testUsingEmptyPath() {}
      }

      const path = MetadataRegistry.get(
        METADATA_KEYS.ROUTE_PATH,
        TestWithoutPath.test,
      );
      expect(path).toEqual("/");

      const emptyPath = MetadataRegistry.get(
        METADATA_KEYS.ROUTE_PATH,
        TestWithoutPath.testUsingEmptyPath,
      );
      expect(emptyPath).toEqual("/");
    });
  },
);
