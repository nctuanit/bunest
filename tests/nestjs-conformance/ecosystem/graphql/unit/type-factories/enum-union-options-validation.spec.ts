import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Field,
  ID,
  ObjectType,
  createUnionType,
  registerEnumType,
} from "../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../_helpers/index";

@ObjectType()
class MemberA {
  @Field(() => ID)
  id!: string;
}

@ObjectType()
class MemberB {
  @Field(() => ID)
  id!: string;
}

enum SampleEnum {
  A = "A",
  B = "B",
}

describeConformance(
  "registerEnumType / createUnionType options validation",
  {
    upstreamPath:
      "packages/graphql/tests/type-factories/enum-union-options-validation.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    // BUNEST_BUG: registerEnumType() in packages/graphql/src/decorators/type.decorators.ts (lines 77-130) does not validate that `options` is provided, throwing raw TypeError("undefined is not an object (evaluating 'options.valuesMap')") instead of a descriptive error matching /registerEnumType requires an "options" object/.
    it.skip("should throw a descriptive error when registerEnumType is called without options", () => {
      expect(() =>
        (registerEnumType as unknown as (ref: object) => void)(SampleEnum),
      ).toThrow(/registerEnumType requires an "options" object/);
    });

    // BUNEST_BUG: registerEnumType() in packages/graphql/src/decorators/type.decorators.ts (lines 77-130) does not validate `options.name`, forwarding undefined to GraphQLEnumType ("Must provide name.") instead of throwing a descriptive error matching /non-empty "name"/.
    it.skip("should throw a descriptive error when registerEnumType is called without a name", () => {
      expect(() =>
        registerEnumType(SampleEnum, {} as unknown as { name: string }),
      ).toThrow(/non-empty "name"/);
    });

    // BUNEST_BUG: createUnionType() in packages/graphql/src/decorators/type.decorators.ts (lines 183-205) does not validate that `options` is provided, throwing raw TypeError("undefined is not an object (evaluating 'options.name')") instead of a descriptive error matching /createUnionType requires an "options" object/.
    it.skip("should throw a descriptive error when createUnionType is called without options", () => {
      expect(() => (createUnionType as unknown as () => unknown)()).toThrow(
        /createUnionType requires an "options" object/,
      );
    });

    // BUNEST_BUG: createUnionType() in packages/graphql/src/decorators/type.decorators.ts (lines 183-205) does not validate `options.name`, silently returning a UnionTypeRef with name: undefined instead of throwing a descriptive error matching /non-empty "name"/.
    it.skip("should throw a descriptive error when createUnionType is called without a name", () => {
      expect(() =>
        createUnionType({
          types: () => [MemberA, MemberB] as const,
        } as unknown as {
          name: string;
          types: () => readonly [typeof MemberA];
        }),
      ).toThrow(/non-empty "name"/);
    });

    // BUNEST_BUG: createUnionType() in packages/graphql/src/decorators/type.decorators.ts (lines 183-205) does not validate that `options.types` is a function, silently returning a UnionTypeRef with types: undefined instead of throwing a descriptive error matching /"options\.types" to be a function/.
    it.skip("should throw a descriptive error when createUnionType is called without a types function", () => {
      expect(() =>
        createUnionType({
          name: "BadUnion",
        } as unknown as {
          name: string;
          types: () => readonly [typeof MemberA];
        }),
      ).toThrow(/"options\.types" to be a function/);
    });

    it("should accept a fully formed options object", () => {
      expect(() =>
        registerEnumType(SampleEnum, { name: "SampleEnum" }),
      ).not.toThrow();
      expect(() =>
        createUnionType({
          name: "SampleUnion",
          types: () => [MemberA, MemberB] as const,
        }),
      ).not.toThrow();
    });
  },
);
