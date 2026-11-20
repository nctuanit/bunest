import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  MetadataRegistry,
  Module,
  Param,
  type Type,
} from "../../../../../../packages/common/src";
import { BunestFactory } from "../../../../../../packages/core/src";
import {
  ApiParam,
  DocumentBuilder,
  SWAGGER_METADATA_KEYS,
  SwaggerModule,
  type OpenApiParameter,
} from "../../../../../../packages/swagger/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

async function getPathParams(
  controller: Type<unknown>,
  path: string,
): Promise<OpenApiParameter[]> {
  @Module({ controllers: [controller] })
  class TestModule {}
  const app = await BunestFactory.create(TestModule, { logger: false });
  try {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    return (doc.paths[path]?.get?.parameters ?? []).filter(
      (p) => p.in === "path",
    );
  } finally {
    await app.close();
  }
}

describeConformance(
  "ApiParam",
  {
    upstreamPath: "test/decorators/api-param.decorator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS internal exploreApiParametersMetadata + DECORATORS.API_PARAMETERS checks to Bunest MetadataRegistry (SWAGGER_METADATA_KEYS.API_PARAMS) and SwaggerModule.createDocument() per ADR-002 and ADR-013.",
  },
  () => {
    describe("when applied on the class level", () => {
      @ApiParam({ name: "testId" })
      @Controller("tests/:testId")
      class TestAppController {
        @Get()
        public get(@Param("testId") testId: string): string {
          return testId;
        }

        public noAPiMethod(): void {}
      }

      it("should attach metadata to all API methods", async () => {
        expect(
          MetadataRegistry.has(
            SWAGGER_METADATA_KEYS.API_PARAMS,
            TestAppController,
          ),
        ).toBe(true);
        expect(
          await getPathParams(TestAppController, "/tests/{testId}"),
        ).toEqual([
          {
            in: "path",
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
            SWAGGER_METADATA_KEYS.API_PARAMS,
            controller.noAPiMethod,
          ),
        ).toBe(false);
      });
    });

    describe("when applied on the method level", () => {
      @Controller("tests/:testId")
      class TestAppController {
        @Get()
        @ApiParam({ name: "testId" })
        public get(@Param("testId") testId: string): string {
          return testId;
        }
      }

      it("should attach metadata to a given method", async () => {
        const controller = new TestAppController();
        expect(
          MetadataRegistry.has(
            SWAGGER_METADATA_KEYS.API_PARAMS,
            controller.get,
          ),
        ).toBe(true);
        expect(
          await getPathParams(TestAppController, "/tests/{testId}"),
        ).toEqual([
          {
            in: "path",
            name: "testId",
            required: true,
            schema: { type: "string" },
          },
        ]);
      });
    });

    describe("extensions support", () => {
      it("should merge extensions into parameter metadata when provided (method level)", async () => {
        @Controller("tests/:testId")
        class TestAppController {
          @Get()
          @ApiParam({
            name: "testId",
            extensions: { "x-permissions": ["test.customer.add"] },
          })
          public get(@Param("testId") testId: string): string {
            return testId;
          }
        }

        expect(
          await getPathParams(TestAppController, "/tests/{testId}"),
        ).toEqual([
          {
            in: "path",
            name: "testId",
            required: true,
            schema: { type: "string" },
            "x-permissions": ["test.customer.add"],
          } as OpenApiParameter,
        ]);
      });

      it("should auto-prefix extension keys without x- (class level)", async () => {
        @ApiParam({
          name: "testId",
          extensions: { permissions: ["test.customer.add"] },
        })
        @Controller("tests/:testId")
        class TestAppController2 {
          @Get()
          public get(@Param("testId") testId: string): string {
            return testId;
          }
        }

        expect(
          await getPathParams(TestAppController2, "/tests/{testId}"),
        ).toEqual([
          {
            in: "path",
            name: "testId",
            required: true,
            schema: { type: "string" },
            "x-permissions": ["test.customer.add"],
          } as OpenApiParameter,
        ]);
      });
    });

    describe("when the type is written as an array", () => {
      itAdapted(
        "ADR-002",
        "should document an array of that type",
        async () => {
          @Controller("")
          class TestAppController {
            @ApiParam({ name: "ids", type: [String] })
            @Get(":ids")
            public get(): void {}
          }

          const parameters = await getPathParams(TestAppController, "/{ids}");

          expect(parameters).toEqual([
            {
              name: "ids",
              in: "path",
              required: true,
              schema: { type: "array", items: { type: "string" } },
            },
          ]);
        },
        "Verified via SwaggerModule.createDocument() instead of internal exploreApiParametersMetadata",
      );
    });
  },
);
