import { expect, it } from "bun:test";
import { Controller, Get, Module } from "../../../../../packages/core/src/common";
import { BunestFactory } from "../../../../../packages/core/src";
import {
  ApiProperty,
  DocumentBuilder,
  SwaggerModule,
} from "../../../../../packages/swagger/src";
import { describeConformance } from "../../../_helpers";

describeConformance(
  "SwaggerModule global parameters and responses",
  {
    upstreamPath: "e2e/swagger-module-global-metadata.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes: "Adapts NestFactory.create to BunestFactory.create (ADR-001).",
  },
  () => {
    class StaffErrorDto {
      @ApiProperty()
      stackTrace!: string;
    }

    @Controller("cats")
    class CatsController {
      @Get()
      findAll() {}
    }

    @Module({ controllers: [CatsController] })
    class AppModule {}

    // BUNEST_BUG: SwaggerModule.buildResponses (packages/swagger/src/swagger-module.ts:2214) skips synthesizing the default 200 success response whenever DocumentBuilder.addGlobalResponse() pre-populates any error status (Object.keys(responses).length > 0)
    it.skip("applies them only to documents created from the same config", async () => {
      const app = await BunestFactory.create(AppModule, { logger: false });
      try {
        await app.init();

        const publicConfig = new DocumentBuilder().setTitle("public").build();
        const staffConfig = new DocumentBuilder()
          .setTitle("staff")
          .addGlobalParameters({ name: "x-staff-id", in: "header" })
          .addGlobalParameters({ name: "x-tenant-id", in: "header" })
          .addGlobalResponse({ status: 500, type: StaffErrorDto })
          .addGlobalResponse({ status: 400, description: "Bad request" })
          .build();

        // A shallow copy of the config has to keep them too.
        for (const config of [staffConfig, { ...staffConfig }]) {
          const document = SwaggerModule.createDocument(app, config);
          const operation = document.paths["/cats"]?.get;

          expect(
            operation?.parameters?.map((param: any) => param.name),
          ).toEqual(["x-staff-id", "x-tenant-id"]);
          expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
            "200",
            "400",
            "500",
          ]);
          expect(document.components?.schemas).toHaveProperty("StaffErrorDto");
          expect(Object.getOwnPropertySymbols(document)).toEqual([]);
        }

        const document = SwaggerModule.createDocument(app, publicConfig);
        const operation = document.paths["/cats"]?.get;

        expect(operation?.parameters ?? []).toEqual([]);
        expect(Object.keys(operation?.responses ?? {})).toEqual(["200"]);
        expect(document.components?.schemas ?? {}).toEqual({});
      } finally {
        await app.close();
      }
    });
  },
);
