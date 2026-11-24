import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  BunestFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
  type OperationObject,
  type ParameterObject,
  type ReferenceObject,
  type RequestBodyObject,
  type ResponseObject,
  type SchemaObject,
} from "../../../../../packages/swagger/src";
import { describeConformance } from "../../../_helpers";
import { FullSwaggerAppModule } from "./fixtures/cats-app.fixture";

function getOperation(
  document: OpenAPIObject,
  path: string,
  method: keyof Pick<
    NonNullable<OpenAPIObject["paths"][string]>,
    "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace"
  >,
): OperationObject {
  const operation = document.paths[path]?.[method];
  expect(operation).toBeDefined();
  if (!operation) {
    throw new Error(
      `Expected inlined operation for ${method.toUpperCase()} ${path}`,
    );
  }
  return operation;
}

function getRequestBody(operation: OperationObject): RequestBodyObject {
  const requestBody = operation.requestBody;
  expect(requestBody).toBeDefined();
  if (!requestBody || "$ref" in requestBody) {
    throw new Error("Expected inlined request body");
  }
  return requestBody;
}

function getResponse(
  operation: OperationObject,
  status: string,
): ResponseObject {
  const response = operation.responses[status];
  expect(response).toBeDefined();
  if (!response || "$ref" in response) {
    throw new Error(`Expected inlined response object for status ${status}`);
  }
  return response;
}

function getSchemaFromRequestBody(
  requestBody: RequestBodyObject,
): SchemaObject {
  const schema = requestBody.content?.["application/json"]?.schema;
  expect(schema).toBeDefined();
  if (!schema || "$ref" in schema) {
    throw new Error("Expected inlined schema in request body");
  }
  return schema as SchemaObject;
}

function getSchemaFromResponse(response: ResponseObject): SchemaObject {
  const schema = response.content?.["application/json"]?.schema;
  expect(schema).toBeDefined();
  if (!schema || "$ref" in schema) {
    throw new Error("Expected inlined schema in response");
  }
  return schema as SchemaObject;
}

function getRequestBodyContent(requestBody: RequestBodyObject) {
  const content = requestBody.content?.["application/json"];
  expect(content).toBeDefined();
  if (!content) {
    throw new Error("Expected application/json request body content");
  }
  return content;
}

function getResponseContent(response: ResponseObject) {
  const content = response.content?.["application/json"];
  expect(content).toBeDefined();
  if (!content) {
    throw new Error("Expected application/json response content");
  }
  return content;
}

function getInlinedSchema(
  schema: SchemaObject | ReferenceObject | undefined,
  message = "Expected inlined schema",
): SchemaObject {
  expect(schema).toBeDefined();
  if (!schema || "$ref" in schema) {
    throw new Error(message);
  }
  return schema as SchemaObject;
}

function getUnionBranches(schema: SchemaObject): SchemaObject[] {
  return (schema.anyOf ?? schema.oneOf) as SchemaObject[];
}

function getParameter(
  document: OpenAPIObject,
  path: string,
  method: keyof Pick<
    NonNullable<OpenAPIObject["paths"][string]>,
    "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace"
  >,
  name: string,
): ParameterObject {
  const operation = getOperation(document, path, method);
  const parameters = operation.parameters as
    Array<ParameterObject | ReferenceObject> | undefined;
  const parameter = parameters?.find(
    (candidate): candidate is ParameterObject =>
      !!candidate && !("$ref" in candidate) && candidate.name === name,
  );

  expect(parameter).toBeDefined();
  return parameter as ParameterObject;
}

describeConformance(
  "BunHttpAdapter standard schema support",
  {
    upstreamPath: "e2e/standard-schema.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts Express/Fastify matrix + external zod/valibot packages to BunestFactory + inline StandardJSONSchemaV1 fixtures (ADR-001, ADR-013).",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      app = await BunestFactory.create(FullSwaggerAppModule, { logger: false });
    });

    afterEach(async () => {
      await app.close();
    });

    // BUNEST_BUG: SwaggerModule.buildRequestBody (packages/swagger/src/swagger-module.ts:1933) returns early on @ApiBody before applying @Body({ schema }) overrides, and buildParameters (:1687-1743) ignores rp.schema for @Query({ schema }) / @Param("id", { schema })
    it.skip("should generate standard schema overrides for body, query, param, unions, enums, and nested metadata", () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle("Cats example")
          .setDescription("The cats API description")
          .setVersion("1.0")
          .addTag("cats")
          .build(),
      );

      // Standard body
      const standardBody = getRequestBody(
        getOperation(document, "/cats/standard-body", "post"),
      );
      const standardBodySchema = getSchemaFromRequestBody(standardBody);
      expect(standardBody.required).toBe(true);
      expect(standardBodySchema).toEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            name: {
              type: "string",
              minLength: 1,
              description: "Cat name from Zod",
              example: "Milo",
            },
          }),
        }),
      );

      // Conflicting body (@ApiBody + @Body({ schema }))
      const conflictingBodyRequest = getRequestBody(
        getOperation(document, "/cats/standard-body-conflict", "post"),
      );
      const conflictingBodyContent = getRequestBodyContent(
        conflictingBodyRequest,
      );
      const conflictingBodySchema = getSchemaFromRequestBody(
        conflictingBodyRequest,
      );
      expect(conflictingBodyRequest.description).toBe(
        "Explicit body decorator metadata",
      );
      expect(conflictingBodyRequest.required).toBe(false);
      expect(conflictingBodyContent.examples).toEqual({
        legacy: {
          summary: "Explicit body example",
          value: { legacy: true },
        },
      });
      expect(conflictingBodySchema).toEqual(
        expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            override: {
              type: "string",
              description: "Body override from Zod",
              example: "zod-body",
            },
            count: expect.objectContaining({
              type: "integer",
              minimum: 1,
            }),
          }),
        }),
      );
      expect(conflictingBodySchema.properties).not.toHaveProperty("name");

      // Rich body
      const richBodySchema = getSchemaFromRequestBody(
        getRequestBody(
          getOperation(document, "/cats/standard-body-rich", "post"),
        ),
      );
      expect(richBodySchema.properties?.species).toEqual({
        type: "string",
        enum: ["cat", "dog"],
        title: "Species",
        description: "Species enum from Zod",
        example: "cat",
      });
      const richBodyContactSchema = getInlinedSchema(
        richBodySchema.properties?.contact,
        "Expected inlined contact schema",
      );
      expect(richBodyContactSchema.title).toBe("PreferredContact");
      expect(richBodyContactSchema.description).toBe(
        "Preferred contact from Zod",
      );
      expect(
        (Array.isArray(richBodyContactSchema.examples)
          ? richBodyContactSchema.examples[0]
          : undefined) ?? richBodyContactSchema.example,
      ).toBe("owner@example.com");
      expect(getUnionBranches(richBodyContactSchema)).toEqual(
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

      // Standard query
      const pageParam = getParameter(
        document,
        "/cats/standard-query",
        "get",
        "page",
      );
      expect(pageParam.schema).toEqual({
        type: "number",
        description: "Page number from Valibot",
      });
      expect(pageParam.description).toBe("Page number from Valibot");

      const searchParam = getParameter(
        document,
        "/cats/standard-query",
        "get",
        "search",
      );
      expect(searchParam.schema).toEqual({
        type: "string",
        title: "Search term",
      });
      expect(searchParam.description).toBeUndefined();

      // Conflicting query
      const conflictOperation = getOperation(
        document,
        "/cats/standard-query-conflict",
        "get",
      );
      const conflictParameters = (conflictOperation.parameters ??
        []) as ParameterObject[];
      const conflictParameterKeys = conflictParameters.map(
        (parameter) => `${parameter.in}:${parameter.name}`,
      );
      expect(conflictParameterKeys).toEqual([
        ...new Set(conflictParameterKeys),
      ]);

      const conflictingFilterParam = getParameter(
        document,
        "/cats/standard-query-conflict",
        "get",
        "filter",
      );
      expect(conflictingFilterParam.required).toBe(false);
      expect(conflictingFilterParam.description).toBe(
        "Explicit query decorator description",
      );
      expect(conflictingFilterParam.schema).toEqual(
        expect.objectContaining({
          type: "integer",
          minimum: 1,
          description: "Query override from Zod",
          example: 3,
        }),
      );

      const conflictingActiveParam = getParameter(
        document,
        "/cats/standard-query-conflict",
        "get",
        "active",
      );
      expect(conflictingActiveParam.schema).toEqual({
        type: "boolean",
        description: "Boolean flag from Zod",
        example: true,
      });
      expect(conflictingActiveParam.description).toBe("Boolean flag from Zod");

      // Standard param
      const idParam = getParameter(
        document,
        "/cats/standard-param/{id}",
        "get",
        "id",
      );
      expect(idParam.schema).toEqual(
        expect.objectContaining({
          type: "string",
          minLength: 3,
          pattern: "^cat_[0-9]+$",
          description: "Cat identifier from Zod",
        }),
      );
      expect(idParam.description).toBe("Cat identifier from Zod");

      // Conflicting param
      const conflictingStateParam = getParameter(
        document,
        "/cats/standard-param-conflict/{state}",
        "get",
        "state",
      );
      expect(conflictingStateParam.description).toBe(
        "Explicit param decorator description",
      );
      expect(conflictingStateParam.schema).toEqual(
        expect.objectContaining({
          type: "string",
          enum: ["available", "resting"],
          description: "Param override from Zod",
          example: "resting",
        }),
      );

      // Standard response
      const standardResponse = getResponse(
        getOperation(document, "/cats/standard-response", "get"),
        "200",
      );
      const standardResponseSchema = getSchemaFromResponse(standardResponse);
      expect(standardResponse.description).toBe(
        "Standard schema response override",
      );
      expect(standardResponseSchema.properties?.status).toEqual({
        type: "string",
        enum: ["available", "resting"],
        title: "CatResponseState",
        description: "Response status enum from Zod",
        example: "available",
      });

      // Conflicting standard response
      const conflictingStandardResponse = getResponse(
        getOperation(document, "/cats/standard-response-conflict", "get"),
        "200",
      );
      const conflictingStandardResponseContent = getResponseContent(
        conflictingStandardResponse,
      );
      const conflictingStandardResponseSchema = getSchemaFromResponse(
        conflictingStandardResponse,
      );
      expect(conflictingStandardResponse.description).toBe(
        "Standard schema response conflict override",
      );
      expect(conflictingStandardResponseContent.examples).toEqual({
        legacy: {
          summary: "Decorator response example",
          value: { legacy: true },
        },
      });
      expect(conflictingStandardResponseSchema).toEqual(
        expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            result: {
              type: "string",
              description: "Response override from Zod",
              example: "ok",
            },
            count: expect.objectContaining({
              type: "integer",
              minimum: 1,
            }),
          }),
        }),
      );
    });
  },
);
