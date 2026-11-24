import { expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  UsePipes,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

class Pipe {
  transform(value: unknown) {
    return value;
  }
}

describeConformance(
  "@UsePipes",
  {
    upstreamPath: "packages/common/test/decorators/use-pipes.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    const pipes = [new Pipe(), new Pipe()];

    @UsePipes(...pipes)
    class Test {}

    class TestWithMethod {
      @UsePipes(...pipes)
      public static test() {}
    }

    it("should enhance class with expected pipes array", () => {
      const metadata = MetadataRegistry.get(METADATA_KEYS.PIPES, Test);
      expect(metadata).toEqual(pipes);
    });

    it("should enhance method with expected pipes array", () => {
      const metadata = MetadataRegistry.get(
        METADATA_KEYS.PIPES,
        TestWithMethod.test,
      );
      expect(metadata).toEqual(pipes);
    });

    // BUNEST_BUG: UsePipes() in packages/core/src/common/decorators/enhancers.decorators.ts does not validate decorator items (does not throw InvalidDecoratorItemException when passed an invalid primitive like 'test').
    it.skip("when object is invalid should throw exception", () => {
      let errorClass: unknown = undefined;
      try {
        UsePipes("test" as any)(() => {});
      } catch (e) {
        errorClass = e;
      }
      expect(errorClass).toBeInstanceOf(Error);

      let errorMethod: unknown = undefined;
      try {
        UsePipes("test" as any)(() => {}, "test", {});
      } catch (e) {
        errorMethod = e;
      }
      expect(errorMethod).toBeInstanceOf(Error);
    });
  },
);
