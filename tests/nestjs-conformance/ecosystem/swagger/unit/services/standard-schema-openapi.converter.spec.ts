import { describe, expect, it, spyOn } from "bun:test";
import { Logger } from "../../../../../../packages/core/src/common";
import {
  SchemaExplorer,
  defaultStandardSchemaConverter,
  type OpenApiSchema,
  type ReferenceObject,
  type SchemaObject,
  type StandardJSONSchemaV1,
  type StandardSchemaConverter,
} from "../../../../../../packages/swagger/src";
import { createSpy, describeConformance } from "../../../../_helpers";

function createStandardSchema(
  inputSchema: Record<string, unknown>,
  vendor = "test",
): StandardJSONSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor,
      jsonSchema: {
        input: () => inputSchema,
        output: () => inputSchema,
      },
    },
  };
}

function createZodLikeSchema(
  jsonSchema: Record<string, unknown>,
): StandardJSONSchemaV1 {
  return createStandardSchema(jsonSchema, "zod");
}

function createValibotLikeSchema(
  jsonSchema: Record<string, unknown>,
): StandardJSONSchemaV1 {
  return createStandardSchema(jsonSchema, "valibot");
}

function runConverter(
  schema: unknown,
  schemaType: "input" | "output" = "input",
  customConverter?: StandardSchemaConverter,
):
  | { schema: OpenApiSchema; components: Record<string, OpenApiSchema> }
  | undefined {
  const explorer = new SchemaExplorer(
    customConverter ? { standardSchemaConverter: customConverter } : {},
  );
  const converted = explorer.resolveStandardSchema(schema, schemaType);
  if (!converted) {
    return undefined;
  }
  return {
    schema: converted,
    components: explorer.getSchemas(),
  };
}

describeConformance(
  "StandardSchemaOpenApiConverter (defaultStandardSchemaConverter / SchemaExplorer)",
  {
    upstreamPath: "test/services/standard-schema-openapi.converter.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream StandardSchemaOpenApiConverter + zod/valibot npm deps to Bunest zero-dep defaultStandardSchemaConverter & SchemaExplorer.resolveStandardSchema() using inline StandardJSONSchemaV1 objects (ADR-001, ADR-013).",
  },
  () => {
    it("should convert a standard jsonSchema hook and rewrite component refs", () => {
      const converted = runConverter({
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            input: () => ({
              type: "object",
              properties: {
                tag: { $ref: "#/$defs/Tag" },
              },
              required: ["tag"],
              $defs: {
                Tag: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                  },
                  required: ["label"],
                },
              },
            }),
          },
        },
      });

      expect(converted).toEqual({
        schema: {
          type: "object",
          properties: {
            tag: { $ref: "#/components/schemas/Tag" },
          },
          required: ["tag"],
        },
        components: {
          Tag: {
            type: "object",
            properties: {
              label: { type: "string" },
            },
            required: ["label"],
          },
        },
      });
    });

    it("should convert a standard schema that is a function", () => {
      const schema = Object.assign((value: unknown) => value, {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            input: () => ({
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            }),
          },
        },
      });

      expect(runConverter(schema)).toEqual({
        schema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        components: {},
      });
    });

    it("should pass a function-shaped standard schema to the custom converter", () => {
      const schema = Object.assign((value: unknown) => value, {
        "~standard": {
          version: 1,
          vendor: "arktype",
          validate: (value: unknown) => ({ value }),
        },
      });
      const schemaConverter = createSpy(() => ({
        schema: { type: "string" } as SchemaObject,
      }));

      expect(runConverter(schema, "input", schemaConverter)).toEqual({
        schema: { type: "string" },
        components: {},
      });
      expect(schemaConverter.calledWith(schema, { schemaType: "input" })).toBe(
        true,
      );
    });

    it("should skip and warn about a function-shaped standard schema that cannot produce OpenAPI 3.0", () => {
      const warnSpy = spyOn(Logger.prototype, "warn").mockImplementation(
        () => {},
      );
      const schema = Object.assign((value: unknown) => value, {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            input: ({ target }: { target: string }) => {
              throw new Error(`Unsupported target: ${target}`);
            },
          },
        },
      });

      try {
        expect(runConverter(schema)).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Unsupported target: openapi-3.0"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("should rethrow when an object-shaped standard schema cannot produce OpenAPI 3.0", () => {
      const schema = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            input: ({ target }: { target: string }) => {
              throw new Error(`Unsupported target: ${target}`);
            },
          },
        },
      };

      expect(() => runConverter(schema)).toThrow("Unsupported target:");
    });

    it("should convert zod standard schemas", () => {
      const converted = runConverter(
        createZodLikeSchema({
          type: "object",
          properties: {
            id: { type: "string" },
            tags: { type: "array", items: { type: "number" } },
          },
          required: ["id", "tags"],
        }),
        "input",
      );

      expect(converted?.schema).toEqual(
        expect.objectContaining({
          type: "object",
          properties: {
            id: { type: "string" },
            tags: {
              type: "array",
              items: { type: "number" },
            },
          },
          required: ["id", "tags"],
        }),
      );
    });

    it("should preserve OpenAPI-specific metadata from zod conversion", () => {
      const converted = runConverter(
        createZodLikeSchema({
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "cat name",
              example: "Milo",
            },
          },
          required: ["name"],
        }),
        "input",
      );

      expect(converted?.schema).toEqual(
        expect.objectContaining({
          properties: {
            name: {
              type: "string",
              description: "cat name",
              example: "Milo",
            },
          },
        }),
      );
    });

    it("should convert zod unions, enums, and nested OpenAPI metadata", () => {
      const converted = runConverter(
        createZodLikeSchema({
          type: "object",
          properties: {
            species: {
              type: "string",
              enum: ["cat", "dog"],
              title: "Species",
              description: "Species enum from Zod",
              example: "cat",
            },
            contact: {
              title: "PreferredContact",
              description: "Preferred contact from Zod",
              examples: ["owner@example.com"],
              anyOf: [
                { type: "string", format: "email" },
                {
                  type: "object",
                  properties: {
                    phone: {
                      type: "string",
                      description: "Phone number from Zod",
                      example: "123-456",
                    },
                  },
                  required: ["phone"],
                },
              ],
            },
            profile: {
              type: "object",
              title: "CatProfile",
              description: "Nested cat profile from Zod",
              properties: {
                nickname: {
                  type: "string",
                  description: "Nested nickname from Zod",
                  example: "Captain Whiskers",
                },
                notes: {
                  type: "string",
                  default: "Indoor only",
                  description: "Nested notes from Zod",
                  example: "Indoor only",
                  deprecated: true,
                },
              },
            },
          },
        }),
        "input",
      );

      expect(converted?.schema).toEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            species: {
              type: "string",
              enum: ["cat", "dog"],
              title: "Species",
              description: "Species enum from Zod",
              example: "cat",
            },
            contact: expect.objectContaining({
              title: "PreferredContact",
              description: "Preferred contact from Zod",
            }),
            profile: expect.objectContaining({
              title: "CatProfile",
              description: "Nested cat profile from Zod",
              properties: expect.objectContaining({
                nickname: {
                  type: "string",
                  description: "Nested nickname from Zod",
                  example: "Captain Whiskers",
                },
                notes: expect.objectContaining({
                  type: "string",
                  default: "Indoor only",
                  description: "Nested notes from Zod",
                  example: "Indoor only",
                  deprecated: true,
                }),
              }),
            }),
          }),
        }),
      );

      const contact = (converted?.schema as any).properties.contact;
      const unionBranches = contact.anyOf ?? contact.oneOf;
      expect(unionBranches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "string", format: "email" }),
          expect.objectContaining({
            type: "object",
            properties: expect.objectContaining({
              phone: {
                type: "string",
                description: "Phone number from Zod",
                example: "123-456",
              },
            }),
          }),
        ]),
      );
      expect(contact.example).toBe("owner@example.com");
      expect(contact.examples).toBeUndefined();
    });

    it("should convert valibot standard schemas", () => {
      const converted = runConverter(
        createValibotLikeSchema({
          type: "object",
          properties: {
            page: { type: "number" },
            search: { type: "string" },
          },
          required: ["page"],
        }),
        "input",
      );

      expect(converted?.schema).toEqual({
        type: "object",
        properties: {
          page: { type: "number" },
          search: { type: "string" },
        },
        required: ["page"],
      });
    });

    it("should preserve OpenAPI-specific metadata from valibot conversion", () => {
      const converted = runConverter(
        createValibotLikeSchema({
          type: "object",
          properties: {
            name: { type: "string", description: "cat name" },
            search: { type: "string", title: "Search term" },
          },
          required: ["name"],
        }),
        "input",
      );

      expect(converted?.schema).toEqual({
        type: "object",
        properties: {
          name: { type: "string", description: "cat name" },
          search: { type: "string", title: "Search term" },
        },
        required: ["name"],
      });
    });

    it("should convert valibot unions, enums, and nested metadata", () => {
      const converted = runConverter(
        createValibotLikeSchema({
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["simple", "advanced"],
              description: "Mode enum from Valibot",
              examples: ["simple"],
            },
            filter: {
              title: "FilterTitle",
              description: "Filter union from Valibot",
              anyOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    nested: {
                      type: "string",
                      description: "Nested filter from Valibot",
                      examples: ["persian"],
                    },
                  },
                },
              ],
            },
            details: {
              type: "object",
              title: "Details title from Valibot",
              description: "Nested details from Valibot",
              properties: {
                label: {
                  type: "string",
                  description: "Nested label from Valibot",
                  examples: ["primary"],
                },
                flags: {
                  type: "array",
                  title: "Flag list from Valibot",
                  items: { type: "boolean" },
                },
              },
            },
          },
        }),
        "input",
      );

      const props = (converted?.schema as any).properties;
      expect(props.mode.example).toBe("simple");
      expect(props.mode.examples).toBeUndefined();
      expect(props.details.properties.label.example).toBe("primary");
      expect(props.details.properties.label.examples).toBeUndefined();
    });

    it("should return undefined when a standard schema cannot be converted", () => {
      expect(
        defaultStandardSchemaConverter(
          {
            "~standard": {
              version: 1,
              vendor: "test",
              validate: (value: unknown) => ({ value }),
            },
          },
          { schemaType: "input" },
        ),
      ).toBeUndefined();
    });

    it("should normalize const to enum for OpenAPI 3.0 compatibility", () => {
      const converted = runConverter(
        createZodLikeSchema({
          type: "object",
          properties: {
            kind: {
              type: "string",
              const: "cat",
            },
          },
        }),
        "input",
      );

      expect(converted?.schema).toEqual(
        expect.objectContaining({
          properties: {
            kind: {
              type: "string",
              enum: ["cat"],
            },
          },
        }),
      );
      expect((converted?.schema as any).properties.kind.const).toBeUndefined();
    });

    it("should narrow const to the constant value even when a wider enum is present", () => {
      const converted = runConverter(
        createStandardSchema({
          type: "object",
          properties: {
            kind: { type: "string", const: "a", enum: ["a", "b"] },
          },
        }),
      );

      expect((converted?.schema as any).properties.kind).toEqual({
        type: "string",
        enum: ["a"],
      });
    });

    it("should not treat property names as schema keywords inside nested definitions", () => {
      const converted = runConverter(
        createStandardSchema({
          type: "object",
          properties: {
            node: { $ref: "#/$defs/Node" },
          },
          $defs: {
            Node: {
              type: "object",
              properties: {
                const: { type: "string" },
                nested: {
                  type: "object",
                  properties: {
                    examples: { type: "boolean" },
                  },
                },
              },
            },
          },
        }),
      );

      expect(converted?.components.Node).toEqual({
        type: "object",
        properties: {
          const: { type: "string" },
          nested: {
            type: "object",
            properties: {
              examples: { type: "boolean" },
            },
          },
        },
      });
    });

    it("should normalize const and examples inside definitions", () => {
      const converted = runConverter(
        createStandardSchema({
          $ref: "#/$defs/Kind",
          $defs: {
            Kind: {
              type: "object",
              properties: {
                kind: { type: "string", const: "cat" },
                label: { type: "string", examples: ["first", "second"] },
              },
            },
          },
        }),
      );

      expect((converted?.components.Kind as any).properties).toEqual({
        kind: { type: "string", enum: ["cat"] },
        label: { type: "string", example: "first" },
      });
    });

    it("should rewrite a root-level $ref to the components location", () => {
      const converted = runConverter(
        createStandardSchema({
          $ref: "#/$defs/Cat",
          $defs: {
            Cat: { type: "object", properties: { name: { type: "string" } } },
          },
        }),
      );

      expect(converted?.schema).toEqual({ $ref: "#/components/schemas/Cat" });
      expect(converted?.components.Cat).toEqual({
        type: "object",
        properties: { name: { type: "string" } },
      });
    });

    it("should rewrite a root-level $ref returned by a custom converter", () => {
      const converted = runConverter(
        {
          "~standard": {
            version: 1,
            vendor: "test",
            validate: (value: unknown) => ({ value }),
          },
        },
        "input",
        () => ({
          schema: { $ref: "#/$defs/Tag" } as ReferenceObject,
          components: { Tag: { type: "object" } as SchemaObject },
        }),
      );

      expect(converted?.schema).toEqual({ $ref: "#/components/schemas/Tag" });
    });

    it("should rewrite refs while preserving sibling keywords", () => {
      const converted = runConverter(
        createStandardSchema({
          type: "object",
          properties: {
            tag: {
              $ref: "#/definitions/Tag",
              description: "Sibling description",
            },
          },
          definitions: {
            Tag: { type: "object", properties: { id: { type: "string" } } },
          },
        }),
      );

      expect((converted?.schema as any).properties.tag).toEqual({
        $ref: "#/components/schemas/Tag",
        description: "Sibling description",
      });
      expect(converted?.components.Tag).toBeDefined();
    });

    it("should rewrite refs inside composition keywords and arrays", () => {
      const converted = runConverter(
        createStandardSchema({
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { $ref: "#/$defs/Item" },
            },
            either: {
              anyOf: [{ $ref: "#/$defs/Item" }, { type: "null" }],
            },
          },
          $defs: {
            Item: { type: "object", properties: { id: { type: "string" } } },
          },
        }),
      );

      const schema = converted?.schema as any;
      expect(schema.properties.items.items).toEqual({
        $ref: "#/components/schemas/Item",
      });
      expect(schema.properties.either.anyOf[0]).toEqual({
        $ref: "#/components/schemas/Item",
      });
    });

    it("should not treat property names as schema keywords", () => {
      const converted = runConverter(
        createStandardSchema({
          type: "object",
          properties: {
            const: { type: "string" },
            examples: { type: "number" },
            name: { type: "string" },
          },
          required: ["const", "examples", "name"],
        }),
      );

      expect(converted?.schema).toEqual({
        type: "object",
        properties: {
          const: { type: "string" },
          examples: { type: "number" },
          name: { type: "string" },
        },
        required: ["const", "examples", "name"],
      });
    });
  },
);
