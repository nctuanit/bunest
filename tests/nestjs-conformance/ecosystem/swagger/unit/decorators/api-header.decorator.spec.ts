import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  type Type,
} from "../../../../../../packages/core/src/common";
import { BunestFactory } from "../../../../../../packages/core/src";
import {
  ApiHeader,
  DocumentBuilder,
  SwaggerModule,
  type OpenApiParameter,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

async function getHeaderParams(
  controller: Type<unknown>,
  path = "/",
): Promise<OpenApiParameter[]> {
  @Module({ controllers: [controller] })
  class TestModule {}
  const app = await BunestFactory.create(TestModule, { logger: false });
  try {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    return (doc.paths[path]?.get?.parameters ?? []).filter(
      (p) => p.in === "header",
    );
  } finally {
    await app.close();
  }
}

describeConformance(
  "ApiHeader",
  {
    upstreamPath: "test/decorators/api-header.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest stores raw @ApiHeader options under SWAGGER_METADATA_KEYS.API_HEADERS (ADR-002) and expands defaults, content/schema exclusivity, and extensions during SwaggerModule.createDocument().",
  },
  () => {
    describe("forwarded option fields", () => {
      @Controller("")
      class TestController {
        @ApiHeader({
          name: "X-Simple",
          description: "a simple header",
        })
        @Get("simple")
        simple(): void {}

        @ApiHeader({
          name: "X-Full",
          description: "all optional parameter fields",
          required: true,
          deprecated: true,
          allowEmptyValue: true,
          style: "simple",
          explode: false,
          allowReserved: true,
        })
        @Get("full")
        full(): void {}

        @ApiHeader({
          name: "X-Content",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { foo: { type: "string" } },
              },
            },
          },
        })
        @Get("content")
        content(): void {}

        @ApiHeader({
          name: "X-Example",
          example: "abc",
        })
        @Get("example")
        example(): void {}
      }

      it("forwards deprecated/allowEmptyValue/style/explode/allowReserved to parameter metadata", async () => {
        const metadata = await getHeaderParams(TestController, "/full");

        expect(metadata).toEqual([
          {
            name: "X-Full",
            in: "header",
            description: "all optional parameter fields",
            required: true,
            deprecated: true,
            allowEmptyValue: true,
            style: "simple",
            explode: false,
            allowReserved: true,
            schema: { type: "string" },
          },
        ]);
      });

      it("does not emit a synthetic string schema when `content` is provided", async () => {
        const metadata = await getHeaderParams(TestController, "/content");

        expect(metadata).toEqual([
          {
            name: "X-Content",
            in: "header",
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { foo: { type: "string" } },
                },
              },
            },
          },
        ]);
        expect(metadata[0]).not.toHaveProperty("schema");
      });

      it("preserves the default string schema for the simple case", async () => {
        expect(await getHeaderParams(TestController, "/simple")).toEqual([
          {
            name: "X-Simple",
            in: "header",
            required: false,
            description: "a simple header",
            schema: { type: "string" },
          },
        ]);
      });

      // BUNEST_BUG: SwaggerModule.buildParameters (packages/swagger/src/swagger-module.ts:1911) places @ApiHeader({ example }) on the parameter object (param.example) instead of param.schema.example
      it.skip("keeps `example` on the generated schema", async () => {
        expect(await getHeaderParams(TestController, "/example")).toEqual([
          {
            name: "X-Example",
            in: "header",
            required: false,
            schema: { type: "string", example: "abc" },
          },
        ]);
      });
    });

    describe("extensions support", () => {
      it("should merge extensions into parameter metadata when provided (method level)", async () => {
        @Controller("")
        class TestAppController {
          @ApiHeader({
            name: "X-Api-Key",
            extensions: { "x-permissions": ["test.customer.add"] },
          })
          @Get()
          public get(): void {}
        }

        expect(await getHeaderParams(TestAppController, "/")).toEqual([
          {
            name: "X-Api-Key",
            in: "header",
            required: false,
            schema: { type: "string" },
            "x-permissions": ["test.customer.add"],
          } as OpenApiParameter,
        ]);
      });

      it("should auto-prefix extension keys without x- (method level)", async () => {
        @Controller("")
        class TestAppController {
          @ApiHeader({
            name: "X-Api-Key",
            extensions: { permissions: ["test.customer.add"] },
          })
          @Get()
          public get(): void {}
        }

        expect(await getHeaderParams(TestAppController, "/")).toEqual([
          {
            name: "X-Api-Key",
            in: "header",
            required: false,
            schema: { type: "string" },
            "x-permissions": ["test.customer.add"],
          } as OpenApiParameter,
        ]);
      });

      it("should merge extensions into header metadata when provided (class level)", async () => {
        @ApiHeader({
          name: "X-Api-Key",
          extensions: { "x-permissions": ["test.customer.add"] },
        })
        @Controller("test")
        class TestAppController {
          @Get()
          public get(): void {}
        }

        expect(await getHeaderParams(TestAppController, "/test")).toEqual([
          {
            name: "X-Api-Key",
            in: "header",
            required: false,
            schema: { type: "string" },
            "x-permissions": ["test.customer.add"],
          } as OpenApiParameter,
        ]);
      });

      it('should not leave a raw "extensions" key in the parameter metadata', async () => {
        @Controller("")
        class TestAppController {
          @ApiHeader({
            name: "X-Api-Key",
            extensions: { "x-permissions": ["test.customer.add"] },
          })
          @Get()
          public get(): void {}
        }

        const metadata = await getHeaderParams(TestAppController, "/");
        expect(metadata[0]).not.toHaveProperty("extensions");
      });

      it("should not change metadata when extensions is not provided (no-op)", async () => {
        @Controller("")
        class TestAppController {
          @ApiHeader({ name: "X-Api-Key" })
          @Get()
          public get(): void {}
        }

        expect(await getHeaderParams(TestAppController, "/")).toEqual([
          {
            name: "X-Api-Key",
            in: "header",
            required: false,
            schema: { type: "string" },
          },
        ]);
      });
    });

    describe("when the example is a falsy value", () => {
      // BUNEST_BUG: SwaggerModule.buildParameters (packages/swagger/src/swagger-module.ts:1911) emits falsy @ApiHeader({ example }) on param.example instead of param.schema.example
      it.skip.each([[0], [false], [""]])(
        "should keep the example %j",
        async (example) => {
          @Controller("")
          class TestAppController {
            @ApiHeader({ name: "X-Value", example })
            @Get()
            public get(): void {}
          }

          expect(await getHeaderParams(TestAppController, "/")).toEqual([
            {
              name: "X-Value",
              in: "header",
              required: false,
              schema: { type: "string", example },
            },
          ]);
        },
      );
    });
  },
);
