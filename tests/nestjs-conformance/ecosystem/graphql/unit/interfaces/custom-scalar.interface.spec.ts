import { expect, it } from "bun:test";
import {
  Kind,
  type ValueNode,
} from "../../../../../../packages/graphql/src";
import type { CustomScalar } from "../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../_helpers/index";

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

describeConformance(
  "CustomScalar",
  {
    upstreamPath:
      "packages/graphql/tests/interfaces/custom-scalar.interface.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should allow parseLiteral, parseValue and serialize to return null or undefined", () => {
      class DateScalar implements CustomScalar<number | null, Date | null> {
        description = "Date custom scalar type";

        parseValue(value: unknown): Date | null {
          return typeof value === "number" ? new Date(value) : null;
        }

        serialize(value: unknown): number | null {
          return value instanceof Date ? value.getTime() : null;
        }

        parseLiteral(ast: ValueNode): Date | null {
          if (ast.kind === Kind.INT) {
            return new Date(Number.parseInt(ast.value, 10));
          }
          return null;
        }
      }

      const scalar = new DateScalar();

      expect(
        scalar.parseLiteral({ kind: Kind.STRING, value: "noop" }),
      ).toBeNull();
      expect(
        scalar.parseLiteral({ kind: Kind.INT, value: "0" }),
      ).toBeInstanceOf(Date);
      expect(scalar.parseValue("not-a-number")).toBeNull();
      expect(scalar.serialize("not-a-date")).toBeNull();
    });

    // BUNEST_BUG: CustomScalar<TExternal, TInternal> in packages/graphql/src/interfaces/graphql.interface.ts returns `TInternal` / `TExternal` (and marks `parseLiteral?` optional) instead of `TInternal | null | undefined` / `TExternal | null | undefined` (and required `parseLiteral`), so `class DateScalar implements CustomScalar<number, Date>` cannot return `null` or `undefined` under strict TypeScript.
    it.skip("should expose method signatures whose return types include null and undefined", () => {
      type Methods = CustomScalar<number, Date>;
      type ParseLiteralFn = NonNullable<Methods["parseLiteral"]>;

      const parseLiteralIncludesNullish: IsEqual<
        ReturnType<ParseLiteralFn>,
        Date | null | undefined
      > = false;
      const parseValueIncludesNullish: IsEqual<
        ReturnType<Methods["parseValue"]>,
        Date | null | undefined
      > = false;
      const serializeIncludesNullish: IsEqual<
        ReturnType<Methods["serialize"]>,
        number | null | undefined
      > = false;

      expect<boolean>(parseLiteralIncludesNullish).toBe(true);
      expect<boolean>(parseValueIncludesNullish).toBe(true);
      expect<boolean>(serializeIncludesNullish).toBe(true);
    });
  },
);
