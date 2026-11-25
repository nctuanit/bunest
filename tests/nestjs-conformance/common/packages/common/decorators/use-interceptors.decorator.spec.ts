import { expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  UseInterceptors,
  type BunestInterceptor,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

class Interceptor implements BunestInterceptor {
  intercept(_ctx: any, next: any) {
    return next.handle();
  }
}

describeConformance(
  "@UseInterceptors",
  {
    upstreamPath:
      "packages/common/test/decorators/use-interceptors.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    const interceptors = [Interceptor, Interceptor];

    @UseInterceptors(...interceptors)
    class Test {}

    class TestWithMethod {
      @UseInterceptors(...interceptors)
      public static test() {}
    }

    it("should enhance class with expected interceptors array", () => {
      const metadata = MetadataRegistry.get(METADATA_KEYS.INTERCEPTORS, Test);
      expect(metadata).toEqual(interceptors);
    });

    it("should enhance method with expected interceptors array", () => {
      const metadata = MetadataRegistry.get(
        METADATA_KEYS.INTERCEPTORS,
        TestWithMethod.test,
      );
      expect(metadata).toEqual(interceptors);
    });

    it("when object is invalid should throw exception", () => {
      let error: unknown = undefined;
      try {
        UseInterceptors("test" as any)({ name: "target" } as any);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
    });

    it("when object is valid should not throw exception", () => {
      let error: unknown = undefined;
      try {
        UseInterceptors({
          intercept() {
            return null!;
          },
        })({ name: "target" } as any);
      } catch (e) {
        error = e;
      }
      expect(error).toBeUndefined();
    });
  },
);
