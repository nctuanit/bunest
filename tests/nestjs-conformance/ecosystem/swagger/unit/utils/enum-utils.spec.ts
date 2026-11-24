import { describe, expect, it } from "bun:test";
import {
  SchemaExplorer,
  normalizeEnumValues,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

function getInferredEnumType(values: unknown[]): unknown {
  const explorer = new SchemaExplorer();
  explorer.registerEnumSchema("TestEnum", values);
  return explorer.getSchemas().TestEnum?.type;
}

describeConformance(
  "enum.utils (normalizeEnumValues & enum type inference)",
  {
    upstreamPath: "test/utils/enum-utils.spec.ts",
    category: "ADAPTED_PORT",
    notes:
      "Adapts upstream getEnumValues -> normalizeEnumValues and getEnumType -> SchemaExplorer.registerEnumSchema() type inference (ADR-013).",
  },
  () => {
    describe("getEnumType (SchemaExplorer.registerEnumSchema)", () => {
      it('should return "string" for string enum values', () => {
        expect(getInferredEnumType(["a", "b"])).toBe("string");
      });

      it('should return "number" for number enum values', () => {
        expect(getInferredEnumType([1, 2])).toBe("number");
      });

      it('should return "boolean" for boolean enum values', () => {
        expect(getInferredEnumType([true, false])).toBe("boolean");
      });

      it('should return "boolean" for a single true value', () => {
        expect(getInferredEnumType([true])).toBe("boolean");
      });

      it('should return "boolean" for a single false value', () => {
        expect(getInferredEnumType([false])).toBe("boolean");
      });

      it('should return "string" for mixed string/number values', () => {
        expect(getInferredEnumType(["a", 1])).toBe("string");
      });
    });

    describe("getEnumValues (normalizeEnumValues)", () => {
      it("should pass through boolean arrays unchanged", () => {
        expect(normalizeEnumValues([true, false])).toEqual([true, false]);
      });

      it("should pass through string arrays unchanged", () => {
        expect(normalizeEnumValues(["a", "b"])).toEqual(["a", "b"]);
      });

      it("should pass through number arrays unchanged", () => {
        expect(normalizeEnumValues([1, 2])).toEqual([1, 2]);
      });

      it("should resolve lazy enum types", () => {
        const lazyEnum = () => ["x", "y"];
        expect(normalizeEnumValues(lazyEnum)).toEqual(["x", "y"]);
      });

      it("should extract values from TypeScript numeric enum objects", () => {
        const numericEnum = { 0: "A", 1: "B", A: 0, B: 1 };
        expect(normalizeEnumValues(numericEnum)).toEqual([0, 1]);
      });

      it("should extract values from TypeScript string enum objects", () => {
        const stringEnum = { A: "alpha", B: "beta" };
        expect(normalizeEnumValues(stringEnum)).toEqual(["alpha", "beta"]);
      });
    });
  },
);
