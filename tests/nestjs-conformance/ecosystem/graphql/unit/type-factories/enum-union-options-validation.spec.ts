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
    it("should throw a descriptive error when registerEnumType is called without options", () => {
      expect(() =>
        (registerEnumType as unknown as (ref: object) => void)(SampleEnum),
      ).toThrow(/registerEnumType requires an "options" object/);
    });

    it("should throw a descriptive error when registerEnumType is called without a name", () => {
      expect(() =>
        registerEnumType(SampleEnum, {} as unknown as { name: string }),
      ).toThrow(/non-empty "name"/);
    });

    it("should throw a descriptive error when createUnionType is called without options", () => {
      expect(() => (createUnionType as unknown as () => unknown)()).toThrow(
        /createUnionType requires an "options" object/,
      );
    });

    it("should throw a descriptive error when createUnionType is called without a name", () => {
      expect(() =>
        createUnionType({
          types: () => [MemberA, MemberB] as const,
        } as unknown as {
          name: string;
          types: () => readonly [typeof MemberA];
        }),
      ).toThrow(/non-empty "name"/);
    });

    it("should throw a descriptive error when createUnionType is called without a types function", () => {
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
