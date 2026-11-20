import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Query,
  VersioningType,
} from "../../../../../packages/common/src";
import {
  BunestFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  ApiPropertyOptional,
  DocumentBuilder,
  SwaggerModule,
  getSchemaPath,
  type OpenAPIObject,
  type ParameterObject,
  type ResponseObject,
  type SchemaObject,
  type SwaggerConfig,
} from "../../../../../packages/swagger/src";
import { describeConformance } from "../../../_helpers";
import {
  Cat,
  FullSwaggerAppModule,
  TagDto,
  ValidationErrorDto,
} from "./fixtures/cats-app.fixture";
import { validateOpenApiDocument } from "./fixtures/validate-openapi.helper";

function asResponseObject(
  response: ResponseObject | { $ref: string } | undefined,
): ResponseObject {
  if (!response || "$ref" in response) {
    throw new Error("Expected an inlined response object");
  }
  return response;
}

describeConformance(
  "Validate OpenAPI schema",
  {
    upstreamPath: "e2e/validate-schema.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestFactory + @apidevtools/swagger-parser + zod/valibot to BunestFactory, structural OpenAPI validation, and inline StandardJSONSchemaV1 fixtures (ADR-001, ADR-013).",
  },
  () => {
    let app: BunestApplication;
    let options: SwaggerConfig;

    beforeEach(async () => {
      app = await BunestFactory.create(FullSwaggerAppModule, { logger: false });
      app.setGlobalPrefix("api/");
      app.enableVersioning({ type: VersioningType.URI });

      options = new DocumentBuilder()
        .setTitle("Cats example")
        .setDescription("The cats API description")
        .setVersion("1.0")
        .setBasePath("api")
        .addTag("cats")
        .addBasicAuth()
        .addBearerAuth()
        .addOAuth2()
        .addApiKey()
        .addApiKey({ type: "apiKey" }, "key1")
        .addApiKey({ type: "apiKey" }, "key2")
        .addCookieAuth()
        .addSecurityRequirements("bearer")
        .addSecurityRequirements({ basic: [], cookie: [] })
        .addGlobalResponse({
          status: 500,
          description: "Internal server error",
        })
        .addGlobalResponse({
          status: 400,
          description: "Bad request",
          type: ValidationErrorDto,
        })
        .addGlobalParameters({
          name: "x-tenant-id",
          in: "header",
          schema: { type: "string" },
        })
        .addExtension("x-test", { test: "test" })
        .addExtension("x-logo", { url: "https://example.com/logo.png" }, "info")
        .addServer(
          "http://localhost:3000",
          "Local server",
          {
            someVariable: {
              default: "Variable default value here",
              description: "A variable description here",
            },
          },
          {
            "x-google-endpoint": {
              allowCors: true,
            },
            "x-another-field": "another value",
          },
        )
        .build();
    });

    afterEach(async () => {
      await app.close();
    });

    // BUNEST_BUG: SchemaExplorer.registerDtoSchema (packages/swagger/src/schema-explorer.ts:564-689) ignores class-level @ApiExtension() metadata on DTO schemas (x-schema-extension missing on Cat)
    it.skip("should produce a valid OpenAPI 3.0 schema", async () => {
      await SwaggerModule.loadPluginMetadata(async () => ({
        "@nestjs/swagger": {
          models: [
            [
              import("./fixtures/cats-app.fixture"),
              {
                Cat: {
                  tags: {
                    description: "Tags of the cat",
                    example: ["tag1", "tag2"],
                    required: false,
                  },
                  siblings: {
                    required: false,
                    type: () => ({
                      ids: { required: true, type: () => Number },
                    }),
                  },
                },
                CreateCatDto: {
                  enumWithDescription: {
                    enum: await import("./fixtures/cats-app.fixture").then(
                      (f) => f.LettersEnum,
                    ),
                  },
                  name: {
                    description: "Name of the cat",
                  },
                },
              },
            ],
          ],
          controllers: [
            [
              import("./fixtures/cats-app.fixture"),
              {
                CatsController: {
                  findAllBulk: {
                    type: [
                      await import("./fixtures/cats-app.fixture").then(
                        (f) => f.Cat,
                      ),
                    ],
                    summary: "Find all cats in bulk",
                  },
                },
              },
            ],
          ],
        },
      }));

      const document = SwaggerModule.createDocument(app, options);
      const api = validateOpenApiDocument(document);

      expect(api.info.title).toEqual("Cats example");
      expect(
        (api.components?.schemas?.Cat as any)?.["x-schema-extension"]?.test,
      ).toEqual("test");
      expect(
        (api.components?.schemas?.Cat as any)?.["x-schema-extension-multiple"]
          ?.test,
      ).toEqual("test*2");
      expect(
        (
          api.paths["/api/cats"]?.post?.callbacks?.myEvent as any
        )?.["{$request.body#/callbackUrl}"]?.post?.requestBody?.content?.[
          "application/json"
        ]?.schema,
      ).toBeDefined();
      expect(
        (api.paths["/api/cats"]?.get as any)?.["x-codeSamples"]?.[0]?.lang,
      ).toEqual("JavaScript");
      expect(
        (api.paths["/api/cats"]?.get as any)?.["x-multiple"]?.test,
      ).toEqual("test");
      expect(api.paths["/api/cats"]?.get?.tags).toContain("tag1");
      expect(api.paths["/api/cats"]?.get?.tags).toContain("tag2");
    });

    // BUNEST_BUG: SwaggerModule.buildParameters (packages/swagger/src/swagger-module.ts:1853,1874) places @ApiQuery({ type: TagDto, example }) on param.example instead of wrapping $ref in schema.allOf + schema.example
    it.skip("should preserve example metadata for named type query params (issue #3335)", () => {
      const document = SwaggerModule.createDocument(app, options);
      const params =
        document.paths["/api/cats/with-named-type-example"]?.get?.parameters ??
        [];
      const filterParam = params.find(
        (p) => p.name === "filter" && p.in === "query",
      );
      expect(filterParam).toBeDefined();
      expect((filterParam as ParameterObject).schema).toEqual({
        example: "example-tag",
        allOf: [{ $ref: "#/components/schemas/TagDto" }],
      });
    });

    it("should preserve example/examples for built-in scalar response types", () => {
      const document = SwaggerModule.createDocument(app, options);

      const scalarExample = asResponseObject(
        document.paths["/api/cats/scalar-with-example"]?.get?.responses["200"],
      );
      expect(scalarExample.content?.["application/json"]?.example).toEqual(42);
      expect((scalarExample as any).example).toBeUndefined();

      const scalarExamples = asResponseObject(
        document.paths["/api/cats/scalar-with-examples"]?.get?.responses["200"],
      );
      expect(scalarExamples.content?.["application/json"]?.examples).toEqual({
        adult: { value: 5, summary: "Adult cat age" },
        kitten: { value: 1, summary: "Kitten age" },
      });
      expect((scalarExamples as any).examples).toBeUndefined();

      const arrayExample = asResponseObject(
        document.paths["/api/cats/array-of-scalar-with-example"]?.get
          ?.responses["200"],
      );
      expect(arrayExample.content?.["application/json"]?.schema).toEqual({
        type: "array",
        items: { type: "string" },
      });
      expect(arrayExample.content?.["application/json"]?.example).toEqual([
        "Mau",
        "Persian",
      ]);
      expect((arrayExample as any).example).toBeUndefined();
    });

    it("should map Date responses and bodies to date-time strings", () => {
      const document = SwaggerModule.createDocument(app, options);

      const dateResponse = asResponseObject(
        document.paths["/api/cats/date-response"]?.get?.responses["200"],
      );
      expect(dateResponse.content?.["application/json"]?.schema).toEqual({
        type: "string",
        format: "date-time",
      });
      const dateBody = document.paths["/api/cats/date-body"]?.post
        ?.requestBody as any;
      expect(dateBody.content["application/json"].schema).toEqual({
        type: "string",
        format: "date-time",
      });
      expect(document.components?.schemas).not.toHaveProperty("Date");
    });

    // BUNEST_BUG: SwaggerModule.buildResponses (packages/swagger/src/swagger-module.ts:2147-2156) emits OAS 3.1 `type: ["object", "null"]` even when config.openapi is "3.0.0" instead of `nullable: true`
    it.skip("should move nullable from a schema response into the schema", () => {
      const oas30Options: SwaggerConfig = { ...options, openapi: "3.0.0" };
      const document = SwaggerModule.createDocument(app, oas30Options);

      const response = asResponseObject(
        document.paths["/api/cats/nullable-schema-response"]?.get?.responses[
          "200"
        ],
      );
      expect(response).not.toHaveProperty("nullable");
      expect(response.content?.["application/json"]?.schema).toEqual({
        type: "object",
        properties: { name: { type: "string" } },
        nullable: true,
      });
    });

    // BUNEST_BUG: convertPathToOpenApi (packages/swagger/src/swagger-module.ts:121-160) does not unescape `\:` literal colons in route paths ("/api/v1/express\\:colon\\:another/{prop}" vs "/api/v1/express:colon:another/{prop}")
    it.skip("should fix colons in url", () => {
      const document = SwaggerModule.createDocument(app, options);
      expect(
        document.paths["/api/v1/express:colon:another/{prop}"],
      ).toBeDefined();
    });

    it("should merge custom components passed via config", () => {
      const components = {
        schemas: {
          Person: {
            oneOf: [
              { $ref: getSchemaPath(Cat) },
              { $ref: getSchemaPath(TagDto) },
            ],
            discriminator: {
              propertyName: "_resolveType",
              mapping: {
                cat: getSchemaPath(Cat),
                tag: getSchemaPath(TagDto),
              },
            },
          },
        },
      };

      const document = SwaggerModule.createDocument(app, {
        ...options,
        components: {
          ...options.components,
          ...components,
        },
      });

      const api = validateOpenApiDocument(document);
      expect(api.components?.schemas).toHaveProperty("Person");
      expect(api.components?.schemas).toHaveProperty("Cat");
    });

    it("should consider explicit config over auto-detected schema", () => {
      const document = SwaggerModule.createDocument(app, options);
      expect(document.paths["/api/cats/download"]?.get?.responses["200"]).toEqual({
        description: "binary file for download",
        content: {
          "application/pdf": {
            schema: { type: "string", format: "binary" },
          },
          "image/jpeg": { schema: { type: "string", format: "binary" } },
        },
      });
    });

    // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:912) unconditionally emits OAS 3.1 anyOf: [{ $ref }, { type: "null" }] even for openapi: "3.0.0" instead of OAS 3.0 { type: "object", nullable: true, allOf: [{ $ref }] }
    it.skip("should include type field when nullable is used with allOf (issue #3274)", () => {
      const document = SwaggerModule.createDocument(app, {
        ...options,
        openapi: "3.0.0",
      });
      const createCatDtoSchema = document.components?.schemas
        ?.CreateCatDto as SchemaObject;
      expect(createCatDtoSchema.properties?.nullableTag).toEqual({
        description: "nullable tag",
        nullable: true,
        type: "object",
        allOf: [{ $ref: "#/components/schemas/TagDto" }],
      });
    });

    // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:860-912) keeps reflected design:type ("object") next to oneOf and applies OAS 3.1 type array even for openapi: "3.0.0"
    it.skip("should omit inferred type when nullable is used with oneOf (issue #3928)", () => {
      const document = SwaggerModule.createDocument(app, {
        ...options,
        openapi: "3.0.0",
      });
      const createCatDtoSchema = document.components?.schemas
        ?.CreateCatDto as SchemaObject;

      expect(createCatDtoSchema.properties?.nullablePrimitiveUnion).toEqual({
        description: "nullable primitive union",
        nullable: true,
        oneOf: [{ type: "string" }, { type: "number" }],
      });
    });

    it("should not add optional properties to required list", () => {
      const document = SwaggerModule.createDocument(app, options);
      const required = (document.components?.schemas?.Cat as SchemaObject)
        ?.required;
      expect(required).not.toContain("optionalRawDefinition");
    });

    it("should fail if extension is not prefixed with x-", () => {
      expect(() =>
        new DocumentBuilder().addExtension("test", { test: "test" }).build(),
      ).toThrow(/not prefixed.*x-/i);
    });

    it("should add extension to root", () => {
      const document = SwaggerModule.createDocument(app, options);
      expect(document["x-test"]).toEqual({ test: "test" });
    });

    it("should add extension to info", () => {
      const document = SwaggerModule.createDocument(app, options);
      expect(document.info["x-logo"]).toEqual({
        url: "https://example.com/logo.png",
      });
    });

    it("should add server to the root", () => {
      const document = SwaggerModule.createDocument(app, options);
      expect(document.servers).toBeDefined();
      expect(document.servers).toHaveLength(1);
      expect(document.servers?.[0]).toEqual({
        url: "http://localhost:3000",
        description: "Local server",
        variables: {
          someVariable: {
            default: "Variable default value here",
            description: "A variable description here",
          },
        },
        "x-google-endpoint": {
          allowCors: true,
        },
        "x-another-field": "another value",
      });
    });

    describe("hierarchical tags (OpenAPI 3.2)", () => {
      it("should add tag with parent option", () => {
        const hierarchicalOptions = new DocumentBuilder()
          .setTitle("Hierarchical Tags Test")
          .setVersion("1.0")
          .addTag("Animals", "All animal operations")
          .addTag("Cats", "Cat operations", undefined, { parent: "Animals" })
          .build();

        const document = SwaggerModule.createDocument(app, hierarchicalOptions);

        expect(document.tags).toBeDefined();
        expect(document.tags).toHaveLength(2);
        expect(document.tags?.[0]).toEqual({
          name: "Animals",
          description: "All animal operations",
        });
        expect(document.tags?.[1]).toEqual({
          name: "Cats",
          description: "Cat operations",
          parent: "Animals",
        });
      });

      it("should add tag with kind option", () => {
        const hierarchicalOptions = new DocumentBuilder()
          .setTitle("Hierarchical Tags Test")
          .setVersion("1.0")
          .addTag("Internal", "Internal APIs", undefined, { kind: "reference" })
          .build();

        const document = SwaggerModule.createDocument(app, hierarchicalOptions);

        expect(document.tags).toBeDefined();
        expect(document.tags).toHaveLength(1);
        expect(document.tags?.[0]).toEqual({
          name: "Internal",
          description: "Internal APIs",
          kind: "reference",
        });
      });

      it("should add tag with both parent and kind options", () => {
        const hierarchicalOptions = new DocumentBuilder()
          .setTitle("Hierarchical Tags Test")
          .setVersion("1.0")
          .addTag("Animals", "All animal operations")
          .addTag("Cats", "Cat operations", undefined, {
            parent: "Animals",
            kind: "navigation",
          })
          .build();

        const document = SwaggerModule.createDocument(app, hierarchicalOptions);

        expect(document.tags).toBeDefined();
        expect(document.tags).toHaveLength(2);
        expect(document.tags?.[1]).toEqual({
          name: "Cats",
          description: "Cat operations",
          parent: "Animals",
          kind: "navigation",
        });
      });

      it("should keep operation tags as string arrays", () => {
        const document = SwaggerModule.createDocument(app, options);

        const createCatOperation = document.paths["/api/cats"]?.post;
        expect(createCatOperation?.tags).toBeDefined();
        expect(Array.isArray(createCatOperation?.tags)).toBe(true);
        expect(
          createCatOperation?.tags?.every((tag) => typeof tag === "string"),
        ).toBe(true);
      });
    });

    describe("OpenAPI 3.1 nullability (issue #4063)", () => {
      const createOas31Document = () =>
        SwaggerModule.createDocument(app, { ...options, openapi: "3.1.0" });

      const getCreateCatDtoProperties = (document: OpenAPIObject) =>
        (document.components?.schemas?.CreateCatDto as SchemaObject).properties!;

      it("should emit a type union for a nullable primitive", () => {
        const properties = getCreateCatDtoProperties(createOas31Document());

        expect(properties.nullablePrimitive).toEqual({
          description: "nullable primitive",
          type: ["string", "null"],
        });
      });

      // BUNEST_BUG: applyNullable31 (packages/swagger/src/schema-explorer.ts:360-380) converts nullable enums into anyOf instead of { type: ["string", "null"], enum: [..., null] }
      it.skip("should add null to the values of a nullable enum", () => {
        const properties = getCreateCatDtoProperties(createOas31Document());

        expect(properties.nullableEnum).toEqual({
          description: "nullable enum",
          type: ["string", "null"],
          enum: ["A", "B", "C", null],
        });
      });

      it("should emit anyOf for a nullable $ref, without the 3.0 allOf wrapper", () => {
        const properties = getCreateCatDtoProperties(createOas31Document());

        expect(properties.nullableTag).toEqual({
          description: "nullable tag",
          anyOf: [{ $ref: "#/components/schemas/TagDto" }, { type: "null" }],
        });
      });

      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:860-912) retains reflected design:type ("object") on oneOf properties so applyNullable31 emits type: ["object", "null"] instead of anyOf: [{ oneOf }, { type: "null" }]
      it.skip("should emit anyOf for a nullable composite schema", () => {
        const properties = getCreateCatDtoProperties(createOas31Document());

        expect(properties.nullablePrimitiveUnion).toEqual({
          description: "nullable primitive union",
          anyOf: [
            { oneOf: [{ type: "string" }, { type: "number" }] },
            { type: "null" },
          ],
        });
      });

      it("should convert nullable parameter schemas", () => {
        const document = createOas31Document();
        const parameters = document.paths["/api/cats"]?.get
          ?.parameters as ParameterObject[];
        const sortBy = parameters.find(
          (parameter) => parameter.name === "_sortBy",
        );

        expect(sortBy?.schema).toEqual({
          example: ["sort1", "sort2"],
          type: ["array", "null"],
          items: { type: "string" },
        });
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:747-755) does not convert OAS 3.0 boolean exclusiveMinimum/exclusiveMaximum into OAS 3.1 numeric bounds in parameter schemas
      it.skip("should emit numeric exclusive bounds in parameter schemas", () => {
        const document = createOas31Document();
        const parameters = document.paths["/api/cats"]?.get
          ?.parameters as ParameterObject[];
        const page = parameters.find((parameter) => parameter.name === "page");

        expect(page?.schema).toEqual({
          exclusiveMaximum: 10000,
          exclusiveMinimum: 0,
          title: "Page",
          format: "int32",
          default: 0,
          example: 123,
          type: "number",
        });
      });

      it("should not leave the 3.0 nullable keyword anywhere in the document", () => {
        const document = createOas31Document();

        expect(JSON.stringify(document)).not.toContain('"nullable"');
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:912) unconditionally emits OAS 3.1 `type: ["string", "null"]` regardless of config.openapi: "3.0.0"
      it.skip("should keep the 3.0 spelling in 3.0 documents", () => {
        const properties = getCreateCatDtoProperties(
          SwaggerModule.createDocument(app, { ...options, openapi: "3.0.0" }),
        );

        expect(properties.nullablePrimitive).toEqual({
          description: "nullable primitive",
          type: "string",
          nullable: true,
        });
      });

      it("should produce a valid 3.1 document", () => {
        const document = SwaggerModule.createDocument(
          app,
          new DocumentBuilder()
            .setTitle("Cats example")
            .setVersion("1.0")
            .setOpenAPIVersion("3.1.0")
            .build(),
        );

        expect(() =>
          validateOpenApiDocument(JSON.parse(JSON.stringify(document))),
        ).not.toThrow();
      });
    });

    describe("OpenAPI 3.1 parameter examples", () => {
      class SearchQuery {
        @ApiPropertyOptional({ examples: ["cat", "dog"] })
        term?: string;
      }

      @Controller("search")
      class SearchController {
        @Get()
        find(@Query() _query: SearchQuery) {}
      }

      @Module({ controllers: [SearchController] })
      class SearchModule {}

      it("should move array `examples` of query parameters into the schema", async () => {
        const searchApp = await BunestFactory.create(SearchModule, {
          logger: false,
        });
        try {
          const document = SwaggerModule.createDocument(
            searchApp,
            new DocumentBuilder().setOpenAPIVersion("3.1.0").build(),
          );

          expect(document.paths["/search"]?.get?.parameters).toEqual([
            {
              name: "term",
              in: "query",
              required: false,
              schema: { type: "string", examples: ["cat", "dog"] },
            },
          ]);
          expect(() =>
            validateOpenApiDocument(JSON.parse(JSON.stringify(document))),
          ).not.toThrow();
        } finally {
          await searchApp.close();
        }
      });
    });
  },
);
