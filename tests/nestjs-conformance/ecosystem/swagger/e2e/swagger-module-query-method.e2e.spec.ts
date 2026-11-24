import { expect, it } from "bun:test";
import {
  Body,
  Controller,
  Get,
  Module,
  RequestMapping,
  RequestMethod,
} from "../../../../../packages/core/src/common";
import { BunestFactory } from "../../../../../packages/core/src";
import {
  ApiWebhook,
  DocumentBuilder,
  SwaggerModule,
} from "../../../../../packages/swagger/src";
import { describeConformance } from "../../../_helpers";

describeConformance(
  "SwaggerModule QUERY method handling",
  {
    upstreamPath: "e2e/swagger-module-query-method.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes: "Adapts NestFactory.create to BunestFactory.create (ADR-001).",
  },
  () => {
    class FooFilterDto {
      name!: string;
    }

    @Controller("foos")
    class QueryMethodController {
      @Get()
      findAll() {
        return [];
      }

      @RequestMapping({ path: "filtered", method: RequestMethod.QUERY })
      getFiltered(@Body() _filters: FooFilterDto) {
        return [];
      }
    }

    @Controller()
    class QueryWebhooksController {
      @RequestMapping({ path: "search-hook", method: RequestMethod.QUERY })
      @ApiWebhook("searchEvent")
      searchHook() {
        return { ok: true };
      }
    }

    @Module({ controllers: [QueryMethodController, QueryWebhooksController] })
    class AppModule {}

    const createDocument = async (openApiVersion: string) => {
      const app = await BunestFactory.create(AppModule, { logger: false });
      try {
        await app.init();
        const config = new DocumentBuilder()
          .setTitle("t")
          .setVersion("1")
          .setOpenAPIVersion(openApiVersion)
          .build();
        return SwaggerModule.createDocument(app, config);
      } finally {
        await app.close();
      }
    };

    it("omits the query operation for OAS < 3.2", async () => {
      const document = await createDocument("3.0.0");

      expect(document.paths["/foos/filtered"]).toBeUndefined();
    });

    it("omits the query operation for OAS 3.1", async () => {
      const document = await createDocument("3.1.0");

      expect(document.paths["/foos/filtered"]).toBeUndefined();
    });

    it("keeps sibling operations when dropping the query operation", async () => {
      const document = await createDocument("3.0.0");

      expect(document.paths["/foos"]?.get).toBeDefined();
      expect(document.paths["/foos"]?.query).toBeUndefined();
    });

    it("omits query webhooks for OAS 3.1", async () => {
      const document = await createDocument("3.1.0");

      expect(document.webhooks?.searchEvent).toBeUndefined();
    });

    it("emits the query operation for OAS >= 3.2", async () => {
      const document = await createDocument("3.2.0");

      expect(document.paths["/foos/filtered"]?.query).toBeDefined();
      expect(document.webhooks?.searchEvent?.query).toBeDefined();
    });
  },
);
