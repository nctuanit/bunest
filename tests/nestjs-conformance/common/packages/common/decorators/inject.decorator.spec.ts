import { describe, expect, it } from "bun:test";
import {
  Inject,
  METADATA_KEYS,
  MetadataRegistry,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "@Inject",
  {
    upstreamPath: "packages/common/test/decorators/inject.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest stores sorted InjectTokenMetadata[] ({ index, token }) under METADATA_KEYS.INJECT_TOKENS and PropertyInjectMetadata[] ({ propertyKey, token }) under METADATA_KEYS.PROPERTY_INJECT_TOKENS (merged via MetadataRegistry.getPropertyInjectTokens).",
  },
  () => {
    const opaqueToken = (() => ({})) as any;
    class Test {
      constructor(
        @Inject("test") _param: unknown,
        @Inject("test2") _param2: unknown,
        @Inject(opaqueToken) _param3: unknown,
      ) {}
    }

    it("should enhance class with expected constructor params metadata", () => {
      const metadata = MetadataRegistry.get(METADATA_KEYS.INJECT_TOKENS, Test);

      const expectedMetadata = [
        { index: 0, token: "test" },
        { index: 1, token: "test2" },
        { index: 2, token: opaqueToken },
      ];
      expect(metadata).toEqual(expectedMetadata);
    });

    describe("when used on a constructor parameter without a token", () => {
      class Dependency {}

      class TestWithInferredToken {
        constructor(@Inject() _param: Dependency) {}
      }

      class TestWithUndefinedToken {
        constructor(@Inject(undefined) _param: Dependency) {}
      }

      it("should infer the token from the parameter type when called without arguments", () => {
        const metadata = MetadataRegistry.get(
          METADATA_KEYS.INJECT_TOKENS,
          TestWithInferredToken,
        );
        expect(metadata).toEqual([{ index: 0, token: Dependency }]);
      });

      it("should not infer the token when an explicit undefined token is passed", () => {
        const metadata = MetadataRegistry.get(
          METADATA_KEYS.INJECT_TOKENS,
          TestWithUndefinedToken,
        );
        expect(metadata).toEqual([{ index: 0, token: undefined }]);
      });
    });

    describe("when used on a property redeclared by a subclass", () => {
      class ParentTest {
        @Inject("parent") property: unknown = undefined;
      }

      class ChildTest extends ParentTest {
        @Inject("child") override property: unknown = undefined;
      }

      it("should replace the inherited token of that property", () => {
        const metadata = MetadataRegistry.getPropertyInjectTokens(ChildTest);
        expect(metadata).toEqual([{ propertyKey: "property", token: "child" }]);
        // Parent metadata remains untouched (ADR-002 copy-on-write invariant)
        expect(MetadataRegistry.getPropertyInjectTokens(ParentTest)).toEqual([
          { propertyKey: "property", token: "parent" },
        ]);
      });
    });
  },
);
