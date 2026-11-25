import { describe, expect, it } from "bun:test";
import {
  ApiProperty,
  SchemaExplorer,
  type OpenApiSchema,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

function exploreWithMaxDepth(
  propOptions: Parameters<typeof ApiProperty>[0],
  globalMaxDepth?: number,
): OpenApiSchema {
  class TestDto {
    @ApiProperty(propOptions)
    prop!: unknown;
  }
  const explorer = new SchemaExplorer(
    globalMaxDepth !== undefined ? { exampleMaxDepth: globalMaxDepth } : {},
  );
  explorer.registerDtoSchema(TestDto);
  return explorer.getSchemas().TestDto?.properties?.prop as OpenApiSchema;
}

describeConformance(
  "applyExampleMaxDepth (SchemaExplorer exampleMaxDepth)",
  {
    upstreamPath: "test/utils/apply-example-max-depth.util.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts upstream internal applyExampleMaxDepth(schemas, maxDepth) tests to Bunest's public SchemaExplorer({ exampleMaxDepth }) and @ApiProperty({ exampleMaxDepth }) APIs (ADR-013).",
  },
  () => {
    describe("global option", () => {
      it("truncates deeply nested object examples to {}/[] beyond the limit", () => {
        const prop = exploreWithMaxDepth(
          {
            type: "object",
            example: {
              a: 1,
              b: { c: { d: { e: "too deep" } } },
            },
          },
          2,
        );

        expect(prop.example).toEqual({
          a: 1,
          b: { c: {} },
        });
      });

      it("treats arrays the same as objects when measuring depth", () => {
        const prop = exploreWithMaxDepth(
          {
            type: "array",
            example: [{ id: 1, nested: { deep: "cut" } }],
          },
          2,
        );

        expect(prop.example).toEqual([{ id: 1, nested: {} }]);
      });

      it("leaves primitive examples untouched at any depth", () => {
        class Dto {
          @ApiProperty({ type: "string", example: "hello" })
          label!: string;

          @ApiProperty({ type: "number", example: 0 })
          count!: number;

          @ApiProperty({ type: "boolean", example: false })
          active!: boolean;

          @ApiProperty({ type: "string", example: null })
          nothing!: string | null;
        }

        const explorer = new SchemaExplorer({ exampleMaxDepth: 0 });
        explorer.registerDtoSchema(Dto);
        const props = explorer.getSchemas().Dto?.properties;

        expect((props?.label as OpenApiSchema)?.example).toBe("hello");
        expect((props?.count as OpenApiSchema)?.example).toBe(0);
        expect((props?.active as OpenApiSchema)?.example).toBe(false);
        expect((props?.nothing as OpenApiSchema)?.example).toBeNull();
      });

      it("collapses any non-primitive example to {} or [] when maxDepth is 0", () => {
        const objProp = exploreWithMaxDepth(
          { type: "object", example: { a: 1 } },
          0,
        );
        const arrProp = exploreWithMaxDepth(
          { type: "array", example: [1, 2, 3] },
          0,
        );

        expect(objProp.example).toEqual({});
        expect(arrProp.example).toEqual([]);
      });

      it("truncates entries inside the OpenAPI 3.1 examples array", () => {
        const prop = exploreWithMaxDepth(
          {
            type: "object",
            examples: [{ a: { b: { c: "cut" } } }, { x: { y: { z: "cut" } } }],
          },
          2,
        );

        expect(prop.examples).toEqual([{ a: { b: {} } }, { x: { y: {} } }]);
      });

      it("walks into items, allOf, oneOf, anyOf, and additionalProperties", () => {
        class Dto {
          @ApiProperty({
            type: "array",
            items: {
              type: "object",
              example: { lvl1: { lvl2: "cut" } },
            },
          })
          arr!: unknown[];

          @ApiProperty({
            allOf: [{ type: "object", example: { a: { b: "cut" } } }],
            oneOf: [{ type: "object", example: { a: { b: "cut" } } }],
            anyOf: [{ type: "object", example: { a: { b: "cut" } } }],
          })
          combo!: unknown;

          @ApiProperty({
            type: "object",
            additionalProperties: {
              type: "object",
              example: { a: { b: "cut" } },
            },
          })
          map!: Record<string, unknown>;
        }

        const explorer = new SchemaExplorer({ exampleMaxDepth: 1 });
        explorer.registerDtoSchema(Dto);
        const props = explorer.getSchemas().Dto?.properties as Record<
          string,
          any
        >;

        expect(props.arr.items.example).toEqual({ lvl1: {} });
        expect(props.combo.allOf[0].example).toEqual({ a: {} });
        expect(props.combo.oneOf[0].example).toEqual({ a: {} });
        expect(props.combo.anyOf[0].example).toEqual({ a: {} });
        expect(props.map.additionalProperties.example).toEqual({ a: {} });
      });
    });

    describe("per-property override", () => {
      it("overrides the global limit with the per-property exampleMaxDepth value", () => {
        class Dto {
          @ApiProperty({
            type: "object",
            exampleMaxDepth: 1,
            example: { a: { b: "cut even though global is generous" } },
          })
          tight!: object;

          @ApiProperty({
            type: "object",
            example: { a: { b: { c: "kept up to global=3" } } },
          })
          loose!: object;
        }

        const explorer = new SchemaExplorer({ exampleMaxDepth: 3 });
        explorer.registerDtoSchema(Dto);
        const props = explorer.getSchemas().Dto?.properties as Record<
          string,
          OpenApiSchema
        >;

        expect(props.tight?.example).toEqual({ a: {} });
        expect(props.loose?.example).toEqual({
          a: { b: { c: "kept up to global=3" } },
        });
      });

      it("applies the override even when the global option is unset", () => {
        const prop = exploreWithMaxDepth({
          type: "object",
          exampleMaxDepth: 1,
          example: { a: { b: "cut" } },
        });

        expect(prop.example).toEqual({ a: {} });
      });

      it("does not cascade the override to children of the matching schema", () => {
        class Dto {
          @ApiProperty({
            type: "object",
            exampleMaxDepth: 1,
            properties: {
              inner: {
                type: "object",
                example: {
                  a: { b: { c: "should follow global, not parent override" } },
                },
              },
            },
          })
          outer!: object;
        }

        const explorer = new SchemaExplorer({ exampleMaxDepth: 3 });
        explorer.registerDtoSchema(Dto);
        const props = explorer.getSchemas().Dto?.properties as Record<
          string,
          any
        >;

        expect(props.outer.properties.inner.example).toEqual({
          a: { b: { c: "should follow global, not parent override" } },
        });
      });
    });

    describe("output leakage", () => {
      it("strips exampleMaxDepth from every visited schema", () => {
        class Dto {
          @ApiProperty({
            type: "object",
            exampleMaxDepth: 5,
            example: { ok: true },
          })
          inner!: object;

          @ApiProperty({
            type: "array",
            exampleMaxDepth: 1,
            example: [{ a: { b: "cut" } }],
          })
          list!: unknown[];
        }

        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(Dto);

        const serialized = JSON.stringify(explorer.getSchemas());
        expect(serialized).not.toContain("exampleMaxDepth");
      });

      it("strips the metadata even when the override never triggers truncation", () => {
        const prop = exploreWithMaxDepth({
          type: "object",
          exampleMaxDepth: 5,
        });

        expect("exampleMaxDepth" in prop).toBe(false);
      });
    });

    describe("no-op safety", () => {
      it("does not modify schemas when neither the global option nor any override is set", () => {
        class Dto {
          @ApiProperty({
            type: "object",
            example: { a: { b: { c: { d: "kept" } } } },
          })
          payload!: object;

          @ApiProperty({
            type: "array",
            example: [{ deeply: { nested: "kept" } }],
          })
          list!: unknown[];
        }

        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(Dto);
        const props = explorer.getSchemas().Dto?.properties as Record<
          string,
          OpenApiSchema
        >;

        expect(props.payload?.example).toEqual({
          a: { b: { c: { d: "kept" } } },
        });
        expect(props.list?.example).toEqual([{ deeply: { nested: "kept" } }]);
      });
    });

    describe("shared references (non-cyclic DAG)", () => {
      it("trims every occurrence when sibling properties share a reference", () => {
        const shared = { x: 1, y: { deeper: "kept" } };
        const prop = exploreWithMaxDepth(
          { type: "object", example: { a: shared, b: shared } },
          5,
        );

        expect(prop.example).toEqual({
          a: { x: 1, y: { deeper: "kept" } },
          b: { x: 1, y: { deeper: "kept" } },
        });
      });

      it("does not collapse repeated references inside an array", () => {
        const shared = { id: 7 };
        const prop = exploreWithMaxDepth(
          { type: "array", example: [shared, shared, shared] },
          3,
        );

        expect(prop.example).toEqual([{ id: 7 }, { id: 7 }, { id: 7 }]);
      });
    });

    describe("non-plain object instances", () => {
      it("preserves Date / Map / Set / class instances inside examples as-is", () => {
        const date = new Date("2026-01-01T00:00:00.000Z");
        const map = new Map<string, number>([["k", 1]]);
        const set = new Set<number>([1, 2, 3]);
        class Custom {
          constructor(public name = "foo") {}
        }
        const instance = new Custom();

        const prop = exploreWithMaxDepth(
          {
            type: "object",
            example: { ts: date, lookup: map, members: set, who: instance },
          },
          5,
        );

        const out = prop.example as Record<string, unknown>;
        expect(out.ts).toBe(date);
        expect(out.lookup).toBe(map);
        expect(out.members).toBe(set);
        expect(out.who).toBe(instance);
      });

      it("does not rewrite a Date used as the entire example value", () => {
        const date = new Date("2026-05-08T00:00:00.000Z");
        const prop = exploreWithMaxDepth({ type: "string", example: date }, 0);

        expect(prop.example).toBe(date);
      });
    });

    describe("circular safety", () => {
      it("terminates on circular example values via WeakSet guard", () => {
        const cyclic: Record<string, unknown> = { name: "root" };
        cyclic.self = cyclic;

        let prop: OpenApiSchema | undefined;
        expect(() => {
          prop = exploreWithMaxDepth({ type: "object", example: cyclic }, 5);
        }).not.toThrow();

        const trimmed = prop?.example as Record<string, unknown>;
        expect(trimmed.name).toBe("root");
        expect(trimmed.self).toEqual({});
      });
    });

    describe("integration with SchemaExplorer output", () => {
      it("truncates a user-supplied @ApiProperty example end-to-end", () => {
        const big = {
          list: Array.from({ length: 5 }, (_, i) => ({
            id: i,
            nested: { a: 1, b: 2, c: { x: "y" } },
          })),
        };
        class WithExample {
          @ApiProperty({ example: big })
          payload!: object;
        }

        const unbounded = new SchemaExplorer();
        unbounded.registerDtoSchema(WithExample);
        const before = JSON.stringify(unbounded.getSchemas()).length;

        const bounded = new SchemaExplorer({ exampleMaxDepth: 2 });
        bounded.registerDtoSchema(WithExample);
        const schemas = bounded.getSchemas();
        const after = JSON.stringify(schemas).length;

        expect(after).toBeLessThan(before);
        expect(
          (schemas.WithExample?.properties?.payload as OpenApiSchema)?.example,
        ).toEqual({
          list: [{}, {}, {}, {}, {}],
        });
      });

      it("honours per-property @ApiProperty({ exampleMaxDepth }) and strips it from the schema", () => {
        class Dto {
          @ApiProperty({
            exampleMaxDepth: 1,
            example: { a: { b: "cut" } },
          })
          bounded!: object;

          @ApiProperty({
            example: { a: { b: "kept" } },
          })
          unbounded!: object;
        }

        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(Dto);
        const schemas = explorer.getSchemas();

        expect(
          (schemas.Dto?.properties?.bounded as OpenApiSchema)?.example,
        ).toEqual({ a: {} });
        expect(
          (schemas.Dto?.properties?.unbounded as OpenApiSchema)?.example,
        ).toEqual({ a: { b: "kept" } });
        expect(JSON.stringify(schemas)).not.toContain("exampleMaxDepth");
      });
    });
  },
);
