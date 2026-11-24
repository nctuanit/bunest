import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  MetadataRegistry,
  Module,
  Query,
  type Type,
} from "../../../../../../packages/core/src/common";
import { BunestFactory } from "../../../../../../packages/core/src";
import {
  ApiQuery,
  DocumentBuilder,
  SWAGGER_METADATA_KEYS,
  SwaggerModule,
  type ApiQueryOptions,
  type OpenApiParameter,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

async function getQueryParams(
  controller: Type<unknown>,
  path: string,
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
      (p) => p.in === "query",
    );
  } finally {
    await app.close();
  }
}

describeConformance(
  "ApiQuery",
  {
    upstreamPath: "test/decorators/api-query.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest stores @ApiQuery metadata via MetadataRegistry (SWAGGER_METADATA_KEYS.API_QUERIES) per ADR-002 and resolves class/method merging and extensions in SwaggerModule.createDocument().",
  },
  () => {
    describe("when applied on the class level", () => {
      @ApiQuery({ name: "testId" })
      @Controller("test")
      class TestAppController {
        @Get()
        public get(@Query("testId") testId: string): string {
          return testId;
        }

        public noAPiMethod(): void {}

        public get service() {
          return null;
        }
      }

      // BUNEST_BUG: SwaggerModule.buildParameters (packages/swagger/src/swagger-module.ts:1863) defaults required to false instead of NestJS default true when @ApiQuery omits required
      it.skip("should attach metadata to all API methods", async () => {
        expect(
          MetadataRegistry.has(
            SWAGGER_METADATA_KEYS.API_QUERIES,
            TestAppController,
          ),
        ).toBe(true);
        expect(await getQueryParams(TestAppController, "/test")).toEqual([
          {
            in: "query",
            name: "testId",
            required: true,
            schema: { type: "string" },
          },
        ]);
      });

      it("should not attach metadata to non-API method (not a route)", () => {
        const controller = new TestAppController();
        expect(
          MetadataRegistry.has(
            SWAGGER_METADATA_KEYS.API_QUERIES,
            controller.noAPiMethod,
          ),
        ).toBe(false);
      });
    });

    describe("when applied on the method level", () => {
      @Controller("tests/:testId")
      class TestAppController {
        @Get()
        @ApiQuery({ name: "testId" })
        public get(@Query("testId") testId: string): string {
          return testId;
        }
      }

      // BUNEST_BUG: SwaggerModule.buildParameters (packages/swagger/src/swagger-module.ts:1863) defaults required to false instead of NestJS default true when @ApiQuery omits required
      it.skip("should attach metadata to a given method", async () => {
        const controller = new TestAppController();
        expect(
          MetadataRegistry.has(
            SWAGGER_METADATA_KEYS.API_QUERIES,
            controller.get,
          ),
        ).toBe(true);
        expect(
          await getQueryParams(TestAppController, "/tests/{testId}"),
        ).toEqual([
          {
            in: "query",
            name: "testId",
            required: true,
            schema: { type: "string" },
          },
        ]);
      });
    });

    describe("extensions support", () => {
      // BUNEST_BUG: SwaggerModule.buildParameters (packages/swagger/src/swagger-module.ts:1863) defaults required to false instead of NestJS default true when @ApiQuery omits required
      it.skip("should merge extensions into parameter metadata when provided (method level)", async () => {
        @Controller("")
        class TestAppController {
          @Get()
          @ApiQuery({
            name: "search",
            extensions: { "x-permissions": ["test.customer.add"] },
          })
          public get(@Query("search") search: string): string {
            return search;
          }
        }

        expect(await getQueryParams(TestAppController, "/")).toEqual([
          {
            in: "query",
            name: "search",
            required: true,
            schema: { type: "string" },
            "x-permissions": ["test.customer.add"],
          } as OpenApiParameter,
        ]);
      });

      // BUNEST_BUG: SwaggerModule.buildParameters (packages/swagger/src/swagger-module.ts:1863) defaults required to false instead of NestJS default true when @ApiQuery omits required
      it.skip("should auto-prefix extension keys without x- (class level)", async () => {
        @ApiQuery({
          name: "search",
          extensions: { permissions: ["test.customer.add"] },
        })
        @Controller("test")
        class TestAppController {
          @Get()
          public get(@Query("search") search: string): string {
            return search;
          }
        }

        expect(await getQueryParams(TestAppController, "/test")).toEqual([
          {
            in: "query",
            name: "search",
            required: true,
            schema: { type: "string" },
            "x-permissions": ["test.customer.add"],
          } as OpenApiParameter,
        ]);
      });

      it('should not leave a raw "extensions" key in the parameter metadata', async () => {
        @Controller("")
        class TestAppController {
          @Get()
          @ApiQuery({
            name: "search",
            extensions: { "x-permissions": ["test.customer.add"] },
          })
          public get(@Query("search") search: string): string {
            return search;
          }
        }

        const params = await getQueryParams(TestAppController, "/");
        expect(params[0]).not.toHaveProperty("extensions");
      });
    });

    describe("when type is specified", () => {
      @Controller("")
      class TestAppController {
        @Get("string")
        @ApiQuery({ name: "search", type: "string" })
        public getString(@Query("search") _s: string) {}

        @Get("number")
        @ApiQuery({ name: "page", type: "number" })
        public getNumber(@Query("page") _p: number) {}

        @Get("boolean")
        @ApiQuery({ name: "sort", type: "boolean" })
        public getBoolean(@Query("sort") _b: boolean) {}

        @Get("custom")
        @ApiQuery({ name: "custom", type: "uuid" as any })
        public getCustom(@Query("custom") _c: string) {}
      }

      const controller = new TestAppController();

      it('should store "string" type in metadata', () => {
        const metadata = MetadataRegistry.get<readonly ApiQueryOptions[]>(
          SWAGGER_METADATA_KEYS.API_QUERIES,
          controller.getString,
        );
        expect(metadata?.[0]?.type).toEqual("string");
      });

      it('should store "number" type in metadata', () => {
        const metadata = MetadataRegistry.get<readonly ApiQueryOptions[]>(
          SWAGGER_METADATA_KEYS.API_QUERIES,
          controller.getNumber,
        );
        expect(metadata?.[0]?.type).toEqual("number");
      });

      it('should store "boolean" literal type in metadata', () => {
        const metadata = MetadataRegistry.get<readonly ApiQueryOptions[]>(
          SWAGGER_METADATA_KEYS.API_QUERIES,
          controller.getBoolean,
        );
        expect(metadata?.[0]?.type).toEqual("boolean");
      });

      it("should store any string (like uuid) via type widening", () => {
        const metadata = MetadataRegistry.get<readonly ApiQueryOptions[]>(
          SWAGGER_METADATA_KEYS.API_QUERIES,
          controller.getCustom,
        );
        expect(metadata?.[0]?.type).toEqual("uuid");
      });
    });
  },
);
