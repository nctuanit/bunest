import { expect, it } from "bun:test";
import {
  ApiProperty,
  SchemaExplorer,
  type OpenApiSchema,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "stripDynamicDefaults (SchemaExplorer excludeDynamicDefaults)",
  {
    upstreamPath: "test/utils/strip-dynamic-defaults.util.spec.ts",
    category: "ADAPTED_PORT",
    notes:
      "Adapts upstream internal stripDynamicDefaults(schemas) tests to Bunest's public SchemaExplorer({ excludeDynamicDefaults: true }) API (ADR-013).",
  },
  () => {
    it("should remove Date instance defaults", () => {
      class Plan {
        @ApiProperty({
          type: "string",
          format: "date-time",
          default: new Date("2025-01-01"),
        })
        createdAt!: Date;

        @ApiProperty({ type: "string", default: "anonymous" })
        name!: string;
      }

      const explorer = new SchemaExplorer({ excludeDynamicDefaults: true });
      explorer.registerDtoSchema(Plan);
      const props = explorer.getSchemas().Plan?.properties as Record<
        string,
        OpenApiSchema
      >;

      expect(props.createdAt?.default).toBeUndefined();
      expect(props.name?.default).toBe("anonymous");
    });

    it("should preserve primitive defaults", () => {
      class Dto {
        @ApiProperty({ type: "number", default: 0 })
        count!: number;

        @ApiProperty({ type: "boolean", default: true })
        enabled!: boolean;

        @ApiProperty({ type: "string", default: "hello" })
        label!: string;

        @ApiProperty({ type: "string", default: null })
        nothing!: string | null;
      }

      const explorer = new SchemaExplorer({ excludeDynamicDefaults: true });
      explorer.registerDtoSchema(Dto);
      const props = explorer.getSchemas().Dto?.properties as Record<
        string,
        OpenApiSchema
      >;

      expect(props.count?.default).toBe(0);
      expect(props.enabled?.default).toBe(true);
      expect(props.label?.default).toBe("hello");
      expect(props.nothing?.default).toBeNull();
    });

    it("should preserve plain object and array defaults", () => {
      class Dto {
        @ApiProperty({ type: "object", default: { key: "value" } })
        config!: Record<string, string>;

        @ApiProperty({ type: "array", default: ["a", "b"] })
        tags!: string[];
      }

      const explorer = new SchemaExplorer({ excludeDynamicDefaults: true });
      explorer.registerDtoSchema(Dto);
      const props = explorer.getSchemas().Dto?.properties as Record<
        string,
        OpenApiSchema
      >;

      expect(props.config?.default).toEqual({ key: "value" });
      expect(props.tags?.default).toEqual(["a", "b"]);
    });

    // BUNEST_BUG: SchemaExplorer.applyApiPropertyOptionsToSchema (packages/swagger/src/schema-explorer.ts:718-720) only treats functions and Date as dynamic defaults, missing non-plain class instances (new Foo())
    it.skip("should remove class instance defaults that are not Date", () => {
      class Foo {}
      class Dto {
        @ApiProperty({ type: "object", default: new Foo() })
        foo!: Foo;
      }

      const explorer = new SchemaExplorer({ excludeDynamicDefaults: true });
      explorer.registerDtoSchema(Dto);
      const props = explorer.getSchemas().Dto?.properties as Record<
        string,
        OpenApiSchema
      >;

      expect(props.foo?.default).toBeUndefined();
    });

    // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:717-726,801-803) does not recursively strip dynamic defaults inside nested allOf/oneOf/anyOf schemas
    it.skip("should strip defaults from nested allOf/oneOf/anyOf schemas", () => {
      class Dto {
        @ApiProperty({
          allOf: [
            {
              type: "object",
              properties: {
                ts: { type: "string", default: new Date() },
              },
            },
          ],
        })
        composed!: unknown;
      }

      const explorer = new SchemaExplorer({ excludeDynamicDefaults: true });
      explorer.registerDtoSchema(Dto);
      const composed = explorer.getSchemas().Dto?.properties?.composed as any;

      expect(composed.allOf[0].properties.ts.default).toBeUndefined();
    });

    // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:717-726,795-797) does not strip dynamic defaults inside additionalProperties schemas
    it.skip("should strip defaults from additionalProperties schemas", () => {
      class Dto {
        @ApiProperty({
          type: "object",
          additionalProperties: {
            type: "string",
            format: "date-time",
            default: new Date(),
          },
        })
        lastSeen!: Record<string, Date>;

        @ApiProperty({ type: "object", additionalProperties: true })
        flags!: Record<string, unknown>;
      }

      const explorer = new SchemaExplorer({ excludeDynamicDefaults: true });
      explorer.registerDtoSchema(Dto);
      const props = explorer.getSchemas().Dto?.properties as Record<
        string,
        any
      >;

      expect(props.lastSeen.additionalProperties.default).toBeUndefined();
      expect(props.flags.additionalProperties).toBe(true);
    });
  },
);
