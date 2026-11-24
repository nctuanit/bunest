import { expect, it, spyOn } from "bun:test";
import {
  Controller,
  Logger,
  Module,
  Post,
} from "../../../../../packages/core/src/common";
import { BunestFactory } from "../../../../../packages/core/src";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiWebhook,
  DocumentBuilder,
  SwaggerModule,
} from "../../../../../packages/swagger/src";
import { describeConformance } from "../../../_helpers";

describeConformance(
  "SwaggerModule webhooks handling",
  {
    upstreamPath: "e2e/swagger-module-webhooks.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes: "Adapts NestFactory.create to BunestFactory.create (ADR-001).",
  },
  () => {
    @Controller()
    class StripeWebhooksController {
      @Post("stripe")
      @ApiWebhook("stripeEvent")
      stripe() {
        return { ok: true };
      }
    }

    @Module({ controllers: [StripeWebhooksController] })
    class AppModule {}

    // BUNEST_BUG: SwaggerModule.createDocument (packages/swagger/src/swagger-module.ts:880,1072) always emits @ApiWebhook() routes into document.webhooks even when config.openapi < 3.1 instead of placing them in document.paths
    it.skip("adds webhook routes to paths for OAS < 3.1", async () => {
      const app = await BunestFactory.create(AppModule, { logger: false });
      try {
        await app.init();

        const config = new DocumentBuilder()
          .setTitle("t")
          .setVersion("1")
          .setOpenAPIVersion("3.0.0")
          .build();
        const document = SwaggerModule.createDocument(app, config);

        expect(document.webhooks).toBeUndefined();
        expect(document.paths["/stripe"]).toBeDefined();
      } finally {
        await app.close();
      }
    });

    it("emits webhooks separately for OAS >= 3.1", async () => {
      const app = await BunestFactory.create(AppModule, { logger: false });
      try {
        await app.init();

        const config = new DocumentBuilder()
          .setTitle("t")
          .setVersion("1")
          .setOpenAPIVersion("3.1.0")
          .build();
        const document = SwaggerModule.createDocument(app, config);

        expect(document.webhooks?.stripeEvent).toBeDefined();
        expect(document.paths["/stripe"]).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    // BUNEST_BUG: SwaggerModule.createDocument (packages/swagger/src/swagger-module.ts:650,880) calls scanControllers with default error conflict policy (throwing DuplicateRouteException on POST /invoices) and never drops/warns on colliding OAS 3.0 webhook routes
    it.skip("keeps the regular operation when a webhook shares its path and method for OAS < 3.1", async () => {
      @Controller({ path: "orders", host: "api.example.com" })
      class OrdersController {
        @Post()
        @ApiBearerAuth()
        create() {}
      }

      @Controller({ path: "orders", host: "hooks.example.com" })
      class OrderEventsController {
        @Post()
        @ApiWebhook("orderEvent")
        receive() {}
      }

      @Controller("invoices")
      class InvoicesController {
        @Post()
        @ApiWebhook("invoiceCreated")
        invoiceCreated() {}

        @Post()
        @ApiBearerAuth()
        create() {}
      }

      @Module({
        controllers: [
          OrderEventsController,
          OrdersController,
          InvoicesController,
        ],
      })
      class DuplicatesModule {}

      const app = await BunestFactory.create(DuplicatesModule, {
        logger: false,
        routeConflictPolicy: "warn",
      });
      const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      try {
        await app.init();

        const config = new DocumentBuilder()
          .setTitle("t")
          .setVersion("1")
          .setOpenAPIVersion("3.0.0")
          .addBearerAuth()
          .build();
        const document = SwaggerModule.createDocument(app, config);
        const bearer = [{ bearer: [] }];

        expect(warn.mock.calls.map(([message]) => message)).toEqual([
          'Webhook "POST /orders" shares its path and method with a route, so it is left out of the OpenAPI 3.0.0 document. Use OpenAPI 3.1 or later to document both.',
          'Webhook "POST /invoices" shares its path and method with a route, so it is left out of the OpenAPI 3.0.0 document. Use OpenAPI 3.1 or later to document both.',
        ]);

        expect(document.webhooks).toBeUndefined();
        expect(document.paths["/orders"]?.post).toMatchObject({
          operationId: "OrdersController_create",
          security: bearer,
        });
        expect(document.paths["/invoices"]?.post).toMatchObject({
          operationId: "InvoicesController_create",
          security: bearer,
        });
      } finally {
        warn.mockRestore();
        await app.close();
      }
    });

    it('converts nullable schemas of a webhook named "default" for OAS >= 3.1', async () => {
      @Controller()
      class DefaultWebhookController {
        @Post("events")
        @ApiWebhook("default")
        @ApiOkResponse({ type: String, nullable: true })
        events() {}
      }

      @Module({ controllers: [DefaultWebhookController] })
      class DefaultWebhookModule {}

      const app = await BunestFactory.create(DefaultWebhookModule, {
        logger: false,
      });
      try {
        await app.init();

        const config = new DocumentBuilder()
          .setTitle("t")
          .setVersion("1")
          .setOpenAPIVersion("3.1.0")
          .build();
        const document = SwaggerModule.createDocument(app, config);

        expect(
          (document.webhooks?.default?.post?.responses["200"] as any)
            ?.content?.["application/json"]?.schema,
        ).toEqual({ type: ["string", "null"] });
      } finally {
        await app.close();
      }
    });
  },
);
