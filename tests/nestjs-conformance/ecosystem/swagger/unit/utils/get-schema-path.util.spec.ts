import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  ApiSchema,
  getSchemaPath,
  refs,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "getSchemaPath",
  {
    upstreamPath: "test/utils/get-schema-path.util.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    @ApiSchema({ name: "Feline" })
    class Cat {}

    class Dog {}

    it("uses the name set with @ApiSchema()", () => {
      expect(getSchemaPath(Cat)).toBe("#/components/schemas/Feline");
      expect(getSchemaPath(Dog)).toBe("#/components/schemas/Dog");
    });

    describe("refs", () => {
      it("uses the name set with @ApiSchema()", () => {
        expect(refs(Cat, Dog)).toEqual([
          { $ref: "#/components/schemas/Feline" },
          { $ref: "#/components/schemas/Dog" },
        ]);
      });
    });
  },
);
