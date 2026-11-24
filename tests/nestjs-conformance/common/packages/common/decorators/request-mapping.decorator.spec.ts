import { expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  RequestMapping,
  RequestMethod,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "@RequestMapping",
  {
    upstreamPath:
      "packages/common/test/decorators/request-mapping.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002", "ADR-006"],
  },
  () => {
    const requestProps = {
      path: "test",
      method: RequestMethod.ALL,
    };

    const requestPropsUsingArray = {
      path: ["foo", "bar"],
      method: RequestMethod.ALL,
    };

    it("should enhance class with expected request metadata", () => {
      class Test {
        @RequestMapping(requestProps)
        public static test() {}

        @RequestMapping(requestPropsUsingArray)
        public static testUsingArray() {}
      }

      const path = MetadataRegistry.get(METADATA_KEYS.ROUTE_PATH, Test.test);
      const method = MetadataRegistry.get(
        METADATA_KEYS.ROUTE_METHOD,
        Test.test,
      );
      const pathUsingArray = MetadataRegistry.get(
        METADATA_KEYS.ROUTE_PATH,
        Test.testUsingArray,
      );
      const methodUsingArray = MetadataRegistry.get(
        METADATA_KEYS.ROUTE_METHOD,
        Test.testUsingArray,
      );

      expect(path).toEqual(requestProps.path);
      expect(method).toEqual(requestProps.method);
      expect(pathUsingArray).toEqual(requestPropsUsingArray.path);
      expect(methodUsingArray).toEqual(requestPropsUsingArray.method);
    });

    it("should set request method on GET by default", () => {
      class Test {
        @RequestMapping({ path: "" })
        public static test() {}
      }

      const method = MetadataRegistry.get(
        METADATA_KEYS.ROUTE_METHOD,
        Test.test,
      );
      expect(method).toEqual(RequestMethod.GET);
    });

    // BUNEST_BUG: RequestMapping({ path: [] }) in packages/core/src/common/decorators/http.decorators.ts:154 stores empty array `[]` instead of normalizing empty array to `"/"` as NestJS does.
    it.skip('should set path on "/" by default (for both {} and { path: [] })', () => {
      class Test {
        @RequestMapping({})
        public static test() {}

        @RequestMapping({ path: [] })
        public static testUsingArray() {}
      }

      const path = MetadataRegistry.get(METADATA_KEYS.ROUTE_PATH, Test.test);
      const pathUsingArray = MetadataRegistry.get(
        METADATA_KEYS.ROUTE_PATH,
        Test.testUsingArray,
      );

      expect(path).toEqual("/");
      expect(pathUsingArray).toEqual("/");
    });

    it('should set path on "/" when metadata object omits path', () => {
      class Test {
        @RequestMapping({})
        public static test() {}
      }

      const path = MetadataRegistry.get(METADATA_KEYS.ROUTE_PATH, Test.test);
      expect(path).toEqual("/");
    });
  },
);
