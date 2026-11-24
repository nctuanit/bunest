import { expect, it } from "bun:test";
import {
  Field,
  getGraphQLFields,
} from "../../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../../_helpers/index";

class Inner {
  test!: string;
}

class CorrectPrimitive {
  @Field(() => Boolean, { defaultValue: true })
  bool!: boolean;
}

class CorrectObject {
  @Field(() => Inner, { defaultValue: { test: "hello" } })
  inner!: Inner;
}

class CorrectArray {
  @Field(() => [Inner], { defaultValue: [{ test: "test" }] })
  inner!: Inner;
}

describeConformance(
  "Field decorator (defaultValue)",
  {
    upstreamPath:
      "packages/graphql/tests/plugin/decorators/field.decorator.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("TypeScript should not complain about valid defaultValue types", () => {
      const primFields = getGraphQLFields(CorrectPrimitive);
      const objFields = getGraphQLFields(CorrectObject);
      const arrFields = getGraphQLFields(CorrectArray);

      expect(primFields[0]?.defaultValue).toBe(true);
      expect(objFields[0]?.defaultValue).toEqual({ test: "hello" });
      expect(arrFields[0]?.defaultValue).toEqual([{ test: "test" }]);
    });

    it("should reject mismatched defaultValue types at compile time", () => {
      class WrongPrimitive {
        // Expected @ts-expect-error: The defaultValue should be a boolean
        @Field(() => Boolean, { defaultValue: "true" })
        bool!: boolean;
      }

      class WrongObject {
        // Expected @ts-expect-error: The defaultValue should be of the shape of Inner
        @Field(() => Inner, { defaultValue: { success: true } })
        inner!: Inner;
      }

      class WrongArray {
        // Expected @ts-expect-error: The defaultValue should be an Array
        @Field(() => [Inner], { defaultValue: { test: "test" } })
        inners!: Inner[];
      }

      expect(getGraphQLFields(WrongPrimitive)).toHaveLength(1);
      expect(getGraphQLFields(WrongObject)).toHaveLength(1);
      expect(getGraphQLFields(WrongArray)).toHaveLength(1);
    });
  },
);
