import { describe, expect, it } from "bun:test";
import {
  Controller,
  MetadataRegistry,
  Module,
  Post,
} from "../../../../../../packages/core/src/common";
import { BunestFactory } from "../../../../../../packages/core/src";
import {
  ApiBody,
  DocumentBuilder,
  SWAGGER_METADATA_KEYS,
  SwaggerModule,
  type ApiBodyOptions,
} from "../../../../../../packages/swagger/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "ApiBody",
  {
    upstreamPath: "test/decorators/api-body.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest stores @ApiBody metadata under SWAGGER_METADATA_KEYS.API_BODY via MetadataRegistry (ADR-002) and materializes OpenAPI requestBody schemas in SwaggerModule.createDocument().",
  },
  () => {
    describe("when applied on the method level", () => {
      @Controller("tests")
      class TestAppController {
        @Post()
        @ApiBody({
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
          },
          examples: {
            sample: {
              value: { name: "test" },
            },
          },
          encoding: {
            name: { explode: true, style: "form" },
          },
        })
        public create(): void {}
      }

      itAdapted(
        "ADR-002",
        "should attach metadata to a given method",
        async () => {
          const controller = new TestAppController();
          expect(
            MetadataRegistry.has(
              SWAGGER_METADATA_KEYS.API_BODY,
              controller.create,
            ),
          ).toBe(true);
          expect(
            MetadataRegistry.get<ApiBodyOptions>(
              SWAGGER_METADATA_KEYS.API_BODY,
              controller.create,
            ),
          ).toEqual({
            schema: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
            examples: {
              sample: {
                value: { name: "test" },
              },
            },
            encoding: {
              name: { explode: true, style: "form" },
            },
          });

          @Module({ controllers: [TestAppController] })
          class TestModule {}
          const app = await BunestFactory.create(TestModule, { logger: false });
          try {
            const doc = SwaggerModule.createDocument(
              app,
              new DocumentBuilder().build(),
            );
            expect(doc.paths["/tests"]?.post?.requestBody).toEqual({
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                    },
                  },
                  examples: {
                    sample: {
                      value: { name: "test" },
                    },
                  },
                  encoding: {
                    name: { explode: true, style: "form" },
                  },
                },
              },
            });
          } finally {
            await app.close();
          }
        },
        "MetadataRegistry SWAGGER_METADATA_KEYS.API_BODY + generated requestBody",
      );
    });

    describe("when enum array is provided", () => {
      @Controller("tests")
      class TestAppController {
        @Post()
        @ApiBody({
          enum: ["small", "large"],
          isArray: true,
        })
        public create(): void {}
      }

      it("should attach array enum schema metadata", async () => {
        const controller = new TestAppController();
        expect(
          MetadataRegistry.has(
            SWAGGER_METADATA_KEYS.API_BODY,
            controller.create,
          ),
        ).toBe(true);

        @Module({ controllers: [TestAppController] })
        class TestModule {}
        const app = await BunestFactory.create(TestModule, { logger: false });
        try {
          const doc = SwaggerModule.createDocument(
            app,
            new DocumentBuilder().build(),
          );
          expect(doc.paths["/tests"]?.post?.requestBody).toEqual({
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["small", "large"],
                  },
                },
              },
            },
          });
        } finally {
          await app.close();
        }
      });
    });
  },
);
