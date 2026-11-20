import "reflect-metadata";
import { expect, it } from "bun:test";
import { Controller, Get, Module } from "../../../../../packages/common/src";
import { BunestFactory } from "../../../../../packages/core/src";
import {
  ApiDefaultResponse,
  ApiProperty,
  DocumentBuilder,
  SwaggerModule,
} from "../../../../../packages/swagger/src";
import { describeConformance } from "../../../_helpers";

describeConformance(
  "SwaggerModule default response",
  {
    upstreamPath: "e2e/swagger-module-default-response.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes: "Adapts NestFactory.create to BunestFactory.create (ADR-001).",
  },
  () => {
    class ErrorDto {
      @ApiProperty()
      message!: string;
    }

    @Controller("cats")
    class CatsController {
      @Get()
      @ApiDefaultResponse({ type: ErrorDto, nullable: true })
      findAll() {}

      @Get("name")
      @ApiDefaultResponse({ type: String, nullable: true })
      findName() {}
    }

    @Module({ controllers: [CatsController] })
    class AppModule {}

    it("converts a nullable default response for OAS >= 3.1", async () => {
      const app = await BunestFactory.create(AppModule, { logger: false });
      try {
        await app.init();

        const config = new DocumentBuilder()
          .setTitle("t")
          .setVersion("1")
          .setOpenAPIVersion("3.1.0")
          .build();
        const document = SwaggerModule.createDocument(app, config);
        const schemaOf = (path: string) =>
          (document.paths[path]?.get?.responses.default as any)?.content?.[
            "application/json"
          ]?.schema;

        expect(schemaOf("/cats")).toEqual({
          anyOf: [{ $ref: "#/components/schemas/ErrorDto" }, { type: "null" }],
        });
        expect(schemaOf("/cats/name")).toEqual({ type: ["string", "null"] });
      } finally {
        await app.close();
      }
    });
  },
);
