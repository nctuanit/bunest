import "reflect-metadata";
import { afterEach, expect, it } from "bun:test";
import type { Type } from "../../../../../../packages/common/src";
import {
  ArgsType,
  Field,
  TypeMetadataStorage,
} from "../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../_helpers/index";

class FeatureModule {}

describeConformance(
  "@ArgsType decorator",
  {
    upstreamPath: "packages/graphql/tests/decorators/args-type.decorator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest registers @ArgsType() eagerly into TypeMetadataStorage without NestJS internal LazyMetadataStorage.",
  },
  () => {
    afterEach(() => {
      TypeMetadataStorage.clear();
    });

    function getMetadata(target: Type<unknown>) {
      TypeMetadataStorage.compile();

      return TypeMetadataStorage.getArgumentsMetadataByTarget(target);
    }

    it("should fall back to the class name when called without arguments", () => {
      @ArgsType()
      class TestArgs {
        @Field(() => String)
        query!: string;
      }

      const metadata = getMetadata(TestArgs);
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe("TestArgs");
    });

    it("should fall back to the class name when called with options only", () => {
      @ArgsType({ registerIn: () => FeatureModule })
      class TestArgs {
        @Field(() => String)
        query!: string;
      }

      const metadata = getMetadata(TestArgs);
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe("TestArgs");
      expect((metadata!.registerIn as () => Function)()).toBe(FeatureModule);
    });

    it("should use the explicit name when called with a name only", () => {
      @ArgsType("CustomArgs")
      class TestArgs {
        @Field(() => String)
        query!: string;
      }

      const metadata = getMetadata(TestArgs);
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe("CustomArgs");
      expect(metadata!.registerIn).toBeUndefined();
    });

    it("should use the explicit name when called with a name and options", () => {
      @ArgsType("CustomArgs", { registerIn: () => FeatureModule })
      class TestArgs {
        @Field(() => String)
        query!: string;
      }

      const metadata = getMetadata(TestArgs);
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe("CustomArgs");
      expect((metadata!.registerIn as () => Function)()).toBe(FeatureModule);
    });
  },
);
