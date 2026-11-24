import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Post,
} from "../../../../../../packages/core/src/common";
import { BunestFactory } from "../../../../../../packages/core/src";
import {
  ApiBody,
  ApiCallbacks,
  ApiDefaultResponse,
  ApiHeader,
  ApiProperty,
  ApiQuery,
  ApiResponse,
  ApiWebhook,
  DocumentBuilder,
  SchemaExplorer,
  SwaggerModule,
  type ApiPropertyOptions,
  type OpenApiSchema,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

function exploreProperty31(options: ApiPropertyOptions): OpenApiSchema {
  class TestDto {
    @ApiProperty(options)
    field!: unknown;
  }
  const explorer = new SchemaExplorer();
  explorer.registerDtoSchema(TestDto);
  return explorer.getSchemas().TestDto?.properties?.field as OpenApiSchema;
}

describeConformance(
  "convertNullableToOas31 (OAS 3.1 SchemaExplorer & SwaggerModule)",
  {
    upstreamPath: "test/utils/nullable-to-oas31.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts upstream internal convertNullableToOas31(document) helper tests to Bunest's public SchemaExplorer and SwaggerModule.createDocument() with openapi: '3.1.0' (ADR-013).",
  },
  () => {
    describe("type unions", () => {
      it("turns a nullable primitive into a type union", () => {
        expect(exploreProperty31({ type: "string", nullable: true })).toEqual({
          type: ["string", "null"],
        });
      });

      it('appends "null" to an existing type array', () => {
        expect(
          exploreProperty31({
            schema: { type: ["string"] },
            nullable: true,
          }),
        ).toEqual({
          type: ["string", "null"],
        });
      });

      it('does not duplicate "null" when it is already listed', () => {
        expect(
          exploreProperty31({
            schema: { type: ["string", "null"] },
            nullable: true,
          }),
        ).toEqual({
          type: ["string", "null"],
        });
      });

      it("preserves sibling keywords", () => {
        expect(
          exploreProperty31({
            type: "string",
            format: "date-time",
            description: "when the user was deleted",
            nullable: true,
          }),
        ).toEqual({
          type: ["string", "null"],
          format: "date-time",
          description: "when the user was deleted",
        });
      });

      it("converts nullable arrays without touching the items schema", () => {
        expect(
          exploreProperty31({
            type: "array",
            nullable: true,
            items: { type: "string" },
          }),
        ).toEqual({
          type: ["array", "null"],
          items: { type: "string" },
        });
      });
    });

    describe("enums", () => {
      // BUNEST_BUG: applyNullable31 (packages/swagger/src/schema-explorer.ts:360-380) does not append null to `enum` values when nullable: true in OAS 3.1
      it.skip("adds null to the enum values", () => {
        expect(
          exploreProperty31({
            type: "string",
            enum: ["a", "b"],
            nullable: true,
          }),
        ).toEqual({
          type: ["string", "null"],
          enum: ["a", "b", null],
        });
      });

      it("does not duplicate a null enum value", () => {
        expect(
          exploreProperty31({
            type: "string",
            enum: ["a", null],
            nullable: true,
          }),
        ).toEqual({
          type: ["string", "null"],
          enum: ["a", null],
        });
      });

      // BUNEST_BUG: applyNullable31 (packages/swagger/src/schema-explorer.ts:360-380) wraps a typeless enum in anyOf instead of appending null to enum values
      it.skip("adds null to an enum that declares no type", () => {
        expect(
          exploreProperty31({
            schema: { enum: ["a"] },
            nullable: true,
          }),
        ).toEqual({
          enum: ["a", null],
        });
      });

      it("leaves the enum alone when the schema is not nullable", () => {
        expect(
          exploreProperty31({
            type: "string",
            enum: ["a"],
            nullable: false,
          }),
        ).toEqual({
          type: "string",
          enum: ["a"],
        });
      });
    });

    describe("references and composite schemas", () => {
      it("turns a nullable $ref into an anyOf union", () => {
        class Cat {
          @ApiProperty()
          name!: string;
        }
        expect(exploreProperty31({ type: () => Cat, nullable: true })).toEqual({
          anyOf: [{ $ref: "#/components/schemas/Cat" }, { type: "null" }],
        });
      });

      // BUNEST_BUG: applyNullable31 (packages/swagger/src/schema-explorer.ts:360-380) does not unwrap OAS 3.0 single-element allOf: [{ $ref }] + type: "object" into OAS 3.1 anyOf: [{ $ref }, { type: "null" }]
      it.skip("unwraps the 3.0 allOf wrapper emitted for nullable references", () => {
        expect(
          exploreProperty31({
            schema: {
              description: "the owner",
              type: "object",
              allOf: [{ $ref: "#/components/schemas/Cat" }],
            },
            nullable: true,
          }),
        ).toEqual({
          description: "the owner",
          anyOf: [{ $ref: "#/components/schemas/Cat" }, { type: "null" }],
        });
      });

      it("keeps multi-member combinators intact inside the union", () => {
        expect(
          exploreProperty31({
            schema: {
              oneOf: [{ type: "string" }, { type: "number" }],
            },
            nullable: true,
          }),
        ).toEqual({
          anyOf: [
            { oneOf: [{ type: "string" }, { type: "number" }] },
            { type: "null" },
          ],
        });
      });

      // BUNEST_BUG: applyNullable31 (packages/swagger/src/schema-explorer.ts:360-380) wraps sibling keywords (title, deprecated) inside the anyOf branch instead of keeping them outside the union
      it.skip("keeps sibling keywords outside the union", () => {
        expect(
          exploreProperty31({
            schema: {
              title: "Owner",
              deprecated: true,
              allOf: [{ $ref: "#/components/schemas/Cat" }, { type: "object" }],
            },
            nullable: true,
          }),
        ).toEqual({
          title: "Owner",
          deprecated: true,
          anyOf: [
            {
              allOf: [{ $ref: "#/components/schemas/Cat" }, { type: "object" }],
            },
            { type: "null" },
          ],
        });
      });
    });

    describe("untyped and non-nullable schemas", () => {
      // BUNEST_BUG: applyNullable31 (packages/swagger/src/schema-explorer.ts:360-380) wraps a pure annotation schema ({ description }) in anyOf instead of dropping redundant nullable
      it.skip("drops a nullable keyword that asserts nothing", () => {
        expect(
          exploreProperty31({
            schema: { description: "anything" },
            nullable: true,
          }),
        ).toEqual({
          description: "anything",
        });
      });

      it("drops nullable: false without other changes", () => {
        expect(exploreProperty31({ type: "string", nullable: false })).toEqual({
          type: "string",
        });
      });

      it("leaves a plain $ref untouched", () => {
        class Cat {
          @ApiProperty()
          name!: string;
        }
        expect(exploreProperty31({ type: () => Cat })).toEqual({
          $ref: "#/components/schemas/Cat",
        });
      });
    });

    describe("exclusive bounds", () => {
      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:747-755) does not convert OAS 3.0 boolean exclusiveMinimum/exclusiveMaximum + minimum/maximum into OAS 3.1 numeric bounds
      it.skip("turns boolean exclusive bounds into the bounds they qualify", () => {
        expect(
          exploreProperty31({
            type: "integer",
            minimum: 0,
            maximum: 10,
            exclusiveMinimum: true,
            exclusiveMaximum: true,
          }),
        ).toEqual({
          type: "integer",
          exclusiveMinimum: 0,
          exclusiveMaximum: 10,
        });
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:747-755) does not strip boolean exclusiveMinimum: false / exclusiveMaximum: false for OAS 3.1
      it.skip("drops exclusive bounds set to false", () => {
        expect(
          exploreProperty31({
            type: "number",
            minimum: 0,
            maximum: 10,
            exclusiveMinimum: false,
            exclusiveMaximum: false,
          }),
        ).toEqual({
          type: "number",
          minimum: 0,
          maximum: 10,
        });
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:747-755) does not drop dangling boolean exclusiveMinimum: true without minimum for OAS 3.1
      it.skip("drops a boolean exclusive bound that has no bound to qualify", () => {
        expect(
          exploreProperty31({ type: "number", exclusiveMinimum: true }),
        ).toEqual({
          type: "number",
        });
      });

      it("leaves numeric exclusive bounds untouched", () => {
        expect(
          exploreProperty31({
            type: "number",
            minimum: 1,
            exclusiveMaximum: 5,
          }),
        ).toEqual({
          type: "number",
          minimum: 1,
          exclusiveMaximum: 5,
        });
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:747-755) does not convert boolean exclusiveMinimum on nullable OAS 3.1 schemas
      it.skip("converts the bounds of a nullable schema", () => {
        expect(
          exploreProperty31({
            type: "integer",
            minimum: 0,
            exclusiveMinimum: true,
            nullable: true,
          }),
        ).toEqual({
          type: ["integer", "null"],
          exclusiveMinimum: 0,
        });
      });
    });

    describe("nested positions", () => {
      // BUNEST_BUG: applyNullable31 (packages/swagger/src/schema-explorer.ts:360-380) does not recursively convert nested items, additionalProperties, or patternProperties
      it.skip("converts nested properties, items and additionalProperties", () => {
        expect(
          exploreProperty31({
            type: "object",
            properties: {
              tags: {
                type: "array",
                items: { type: "string", nullable: true },
              },
              meta: {
                type: "object",
                additionalProperties: { type: "number", nullable: true },
              },
              patterned: {
                type: "object",
                patternProperties: {
                  "^x-": { type: "string", nullable: true },
                },
              },
            },
          }),
        ).toEqual({
          type: "object",
          properties: {
            tags: {
              type: "array",
              items: { type: ["string", "null"] },
            },
            meta: {
              type: "object",
              additionalProperties: { type: ["number", "null"] },
            },
            patterned: {
              type: "object",
              patternProperties: {
                "^x-": { type: ["string", "null"] },
              },
            },
          },
        });
      });

      // BUNEST_BUG: applyNullable31 (packages/swagger/src/schema-explorer.ts:360-380) does not recursively convert nullable inside allOf/oneOf/anyOf/not combinators
      it.skip('converts schemas nested inside combinators and "not"', () => {
        expect(
          exploreProperty31({
            schema: {
              allOf: [{ type: "string", nullable: true }],
              not: { type: "number", nullable: true },
            },
          }),
        ).toEqual({
          allOf: [{ type: ["string", "null"] }],
          not: { type: ["number", "null"] },
        });
      });

      it('does not treat a property named "nullable" as the keyword', () => {
        class FlagDto {
          @ApiProperty({ type: "boolean" })
          nullable!: boolean;
        }
        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(FlagDto);
        expect(explorer.getSchemas().FlagDto).toEqual({
          type: "object",
          properties: {
            nullable: { type: "boolean" },
          },
          required: ["nullable"],
        });
      });

      it("leaves example and default values untouched", () => {
        expect(
          exploreProperty31({
            type: "object",
            nullable: true,
            default: { nullable: true },
            example: { nested: { nullable: true } },
          }),
        ).toEqual({
          type: ["object", "null"],
          default: { nullable: true },
          example: { nested: { nullable: true } },
        });
      });

      it("is idempotent", () => {
        class IdemDto {
          @ApiProperty({ type: "string", nullable: true })
          val!: string | null;
        }
        const explorer1 = new SchemaExplorer();
        explorer1.registerDtoSchema(IdemDto);
        const first = explorer1.getSchemas().IdemDto;

        const explorer2 = new SchemaExplorer();
        explorer2.registerDtoSchema(IdemDto);
        const second = explorer2.getSchemas().IdemDto;

        expect(second).toEqual(first);
      });
    });

    describe("document positions outside components.schemas", () => {
      // BUNEST_BUG: SwaggerModule.createDocument (packages/swagger/src/swagger-module.ts) does not run a document-wide OAS 3.1 nullable normalization pass over parameters, headers, inline requestBodies, and response headers
      it.skip("converts parameters, request bodies, responses and headers", async () => {
        class EventPayload {
          @ApiProperty({ type: "string", nullable: true })
          val!: string | null;
        }

        @Controller("cats")
        class CatsController {
          @Get()
          @ApiQuery({ name: "limit", type: Number, nullable: true })
          @ApiHeader({
            name: "x-shared",
            schema: { type: "string", nullable: true },
          })
          @ApiBody({ schema: { type: "string", nullable: true } })
          @ApiResponse({
            status: 200,
            type: String,
            nullable: true,
            headers: {
              "x-total": { schema: { type: "number", nullable: true } },
            },
          })
          @ApiCallbacks({
            name: "onEvent",
            callbackUrl: "{$request.body#/url}",
            method: "post",
            requestBody: { type: EventPayload },
            expectedResponse: { status: 200 },
          })
          list() {}

          @Post("hook")
          @ApiWebhook("newCat")
          @ApiBody({ schema: { type: "string", nullable: true } })
          onNewCat() {}
        }

        @Module({ controllers: [CatsController] })
        class TestModule {}

        const app = await BunestFactory.create(TestModule, { logger: false });
        try {
          const doc = SwaggerModule.createDocument(
            app,
            new DocumentBuilder().setOpenAPIVersion("3.1.0").build(),
          );
          expect(JSON.stringify(doc)).not.toContain('"nullable"');
        } finally {
          await app.close();
        }
      });

      // BUNEST_BUG: SwaggerModule.createDocument (packages/swagger/src/swagger-module.ts:2116) does not convert nullable schemas inside response headers (e.g. default response x-request-id header) for OAS 3.1
      it.skip("converts the default response and skips extensions next to it", async () => {
        class ErrorModel {
          @ApiProperty()
          msg!: string;
        }

        @Controller("cats")
        class CatsController {
          @Get()
          @ApiDefaultResponse({
            type: ErrorModel,
            nullable: true,
            headers: {
              "x-request-id": { schema: { type: "string", nullable: true } },
            },
          })
          list() {}
        }

        @Module({ controllers: [CatsController] })
        class TestModule {}

        const app = await BunestFactory.create(TestModule, { logger: false });
        try {
          const doc = SwaggerModule.createDocument(
            app,
            new DocumentBuilder().setOpenAPIVersion("3.1.0").build(),
          );
          const defResp = doc.paths["/cats"]?.get?.responses.default;
          expect(defResp?.content?.["application/json"]?.schema).toEqual({
            anyOf: [
              { $ref: "#/components/schemas/ErrorModel" },
              { type: "null" },
            ],
          });
          expect(defResp?.headers?.["x-request-id"]).toEqual({
            schema: { type: ["string", "null"] },
          });
        } finally {
          await app.close();
        }
      });

      // BUNEST_BUG: SwaggerModule.buildParameters (packages/swagger/src/swagger-module.ts:1858) leaves raw nullable: true on @ApiQuery parameter schemas instead of converting to OAS 3.1 type unions
      it.skip("converts entries named like data keywords in other name-keyed maps", async () => {
        @Controller("cats")
        class KeywordNamesController {
          @Post()
          @ApiWebhook("default")
          @ApiResponse({ status: 200, type: String, nullable: true })
          defaultWebhook() {}

          @Get()
          @ApiQuery({ name: "default", type: String, nullable: true })
          @ApiQuery({ name: "examples", type: String, nullable: true })
          list() {}
        }

        @Module({ controllers: [KeywordNamesController] })
        class TestModule {}

        const app = await BunestFactory.create(TestModule, { logger: false });
        try {
          const doc = SwaggerModule.createDocument(
            app,
            new DocumentBuilder().setOpenAPIVersion("3.1.0").build(),
          );
          expect(JSON.stringify(doc)).not.toContain('"nullable"');
          expect(
            doc.webhooks?.default?.post?.responses["200"]?.content?.[
              "application/json"
            ]?.schema,
          ).toEqual({ type: ["string", "null"] });
        } finally {
          await app.close();
        }
      });
    });
  },
);
