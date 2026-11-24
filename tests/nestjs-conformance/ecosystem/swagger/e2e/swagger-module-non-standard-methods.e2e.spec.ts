import { expect, it } from "bun:test";
import {
  All,
  Controller,
  Get,
  Module,
  RequestMapping,
  RequestMethod,
  Search,
} from "../../../../../packages/core/src/common";
import { BunestFactory } from "../../../../../packages/core/src";
import {
  ApiWebhook,
  DocumentBuilder,
  SwaggerModule,
} from "../../../../../packages/swagger/src";
import { describeConformance } from "../../../_helpers";
import { validateOpenApiDocument } from "./fixtures/validate-openapi.helper";

describeConformance(
  "SwaggerModule non-standard HTTP method handling",
  {
    upstreamPath: "e2e/swagger-module-non-standard-methods.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestFactory + @apidevtools/swagger-parser to BunestFactory + structural OpenAPI validator (ADR-001, ADR-013).",
  },
  () => {
    @Controller("items")
    class ItemsController {
      @Get()
      findAll() {
        return [];
      }

      @Search()
      search() {
        return [];
      }

      @RequestMapping({ path: "props", method: RequestMethod.PROPFIND })
      props() {
        return {};
      }
    }

    @Controller("proxy")
    class ProxyController {
      @All()
      proxy() {
        return {};
      }
    }

    @Controller()
    class SearchWebhooksController {
      @Search("search-hook")
      @ApiWebhook("searchEvent")
      searchHook() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [ItemsController, ProxyController, SearchWebhooksController],
    })
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

    // BUNEST_BUG: SwaggerModule.createDocument (packages/swagger/src/swagger-module.ts:941-954) emits non-standard HTTP methods (SEARCH, PROPFIND) directly on paths for OAS 3.0/3.1 instead of omitting them
    it.skip.each(["3.0.0", "3.1.0"])(
      "omits non-standard operations for OAS %s",
      async (openApiVersion) => {
        const document = await createDocument(openApiVersion);

        expect(document.paths["/items"]?.get).toBeDefined();
        expect(document.paths["/items"]).not.toHaveProperty("search");
        expect(document.paths["/items/props"]).toBeUndefined();
        expect(document.paths["/proxy"]).not.toHaveProperty("search");
        expect(document.paths["/proxy"]).not.toHaveProperty("query");
        expect(document.paths["/proxy"]?.get).toBeDefined();
      },
    );

    // BUNEST_BUG: SwaggerModule.createDocument (packages/swagger/src/swagger-module.ts:941-954) emits non-standard HTTP methods on webhooks for OAS 3.1 instead of omitting them
    it.skip("omits non-standard webhooks for OAS 3.1", async () => {
      const document = await createDocument("3.1.0");

      expect(document.webhooks?.searchEvent).toBeUndefined();
    });

    // BUNEST_BUG: SwaggerModule.createDocument (packages/swagger/src/swagger-module.ts:941-954) emits invalid non-standard method keys (search/propfind) into OAS 3.0.0 and 3.1.0 PathItem objects
    it.skip.each(["3.0.0", "3.1.0"])(
      "produces a valid document for OAS %s",
      async (openApiVersion) => {
        const document = await createDocument(openApiVersion);

        expect(() =>
          validateOpenApiDocument(JSON.parse(JSON.stringify(document))),
        ).not.toThrow();
      },
    );

    // BUNEST_BUG: SwaggerModule.createDocument (packages/swagger/src/swagger-module.ts:941-954) does not move non-standard HTTP methods (SEARCH, PROPFIND) into OpenAPI 3.2 `additionalOperations`
    it.skip("moves non-standard operations to additionalOperations for OAS >= 3.2", async () => {
      const document = await createDocument("3.2.0");

      expect(document.paths["/items"]).not.toHaveProperty("search");
      expect(document.paths["/items"]?.get).toBeDefined();
      expect(
        document.paths["/items"]?.additionalOperations?.SEARCH?.operationId,
      ).toBe("ItemsController_search");
      expect(
        document.paths["/items/props"]?.additionalOperations?.PROPFIND,
      ).toBeDefined();

      expect(document.paths["/proxy"]).not.toHaveProperty("search");
      expect(document.paths["/proxy"]?.query).toBeDefined();
      expect(
        document.paths["/proxy"]?.additionalOperations?.SEARCH?.operationId,
      ).toBe("ProxyController_proxy_search");

      expect(document.webhooks?.searchEvent).not.toHaveProperty("search");
      expect(
        document.webhooks?.searchEvent?.additionalOperations?.SEARCH,
      ).toBeDefined();
    });
  },
);
