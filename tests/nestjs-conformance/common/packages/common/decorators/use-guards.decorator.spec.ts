import { expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  UseGuards,
  type CanActivate,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

class Guard implements CanActivate {
  canActivate() {
    return true;
  }
}

describeConformance(
  "@UseGuards",
  {
    upstreamPath:
      "packages/common/test/decorators/use-guards.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    const guards = [Guard, Guard];

    @UseGuards(...guards)
    class Test {}

    class TestWithMethod {
      @UseGuards(...guards)
      public static test() {}
    }

    class Test2 {
      @UseGuards(...guards)
      @UseGuards(...guards)
      public static test() {}
    }

    it("should enhance class with expected guards array", () => {
      const metadata = MetadataRegistry.get(METADATA_KEYS.GUARDS, Test);
      expect(metadata).toEqual(guards);
    });

    it("should enhance method with expected guards array", () => {
      const metadata = MetadataRegistry.get(
        METADATA_KEYS.GUARDS,
        TestWithMethod.test,
      );
      expect(metadata).toEqual(guards);
    });

    it("should enhance method with multiple guards array", () => {
      const metadata = MetadataRegistry.get(METADATA_KEYS.GUARDS, Test2.test);
      expect(metadata).toEqual(guards.concat(guards));
    });

    it("should throw exception when object is invalid", () => {
      let error: unknown = undefined;
      try {
        UseGuards("test" as any)({ name: "target" } as any);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
    });

    it("should not throw exception when object is a guard instance", () => {
      let error: unknown = undefined;
      try {
        UseGuards({
          canActivate() {
            return true;
          },
        })({ name: "target" } as any);
      } catch (e) {
        error = e;
      }
      expect(error).toBeUndefined();
    });
  },
);
