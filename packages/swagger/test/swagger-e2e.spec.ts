import { describe, expect, test } from "bun:test";
import { Controller, Get, Module } from "@bunest/core";
import { BunestFactory } from "@bunest/core";
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  DocumentBuilder,
  SwaggerModule,
} from "../src/index";

describe("SwaggerModule.setup() HTTP E2E & XSS Protection", () => {
  test("serves OpenAPI JSON and XSS-safe HTML Explorer via app.fetch() and live Bun.serve({ port: 0 })", async () => {
    @ApiTags("Health")
    @Controller("/health")
    class HealthController {
      @Get()
      @ApiOperation({
        summary: "Health probe </script><script>alert(1)</script>",
      })
      @ApiOkResponse({ description: "Service is healthy" })
      check() {
        return { ok: true };
      }
    }

    @Module({ controllers: [HealthController] })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    try {
      const config = new DocumentBuilder()
        .setTitle('Demo API </script><img src=x onerror="alert(1)">')
        .setVersion("1.2.3")
        .build();

      const doc = SwaggerModule.createDocument(app, config);
      SwaggerModule.setup("/docs", app, doc);

      // In-memory app.fetch() tests
      const jsonRes = await app.fetch(
        new Request("http://localhost/docs-json"),
      );
      expect(jsonRes.status).toBe(200);
      expect(jsonRes.headers.get("content-type")).toContain("application/json");
      const servedDoc = (await jsonRes.json()) as Record<string, unknown>;
      expect(servedDoc.openapi).toBe("3.1.0");
      expect(
        (servedDoc.paths as Record<string, unknown>)["/health"],
      ).toBeDefined();

      const htmlRes = await app.fetch(new Request("http://localhost/docs"));
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get("content-type")).toContain("text/html");
      const html = await htmlRes.text();

      // XSS safety: raw `</script><script>` or `<img` MUST NEVER appear unescaped in HTML or embedded JSON!
      expect(html).not.toContain("</script><script>alert(1)</script>");
      expect(html).not.toContain('<img src=x onerror="alert(1)">');
      expect(html).toContain("\\u003c/script\\u003e");
      expect(html).toContain("/docs-json");

      // Re-creating document after setup() MUST NOT include Swagger's own `/docs` endpoints
      const secondDoc = SwaggerModule.createDocument(app, config);
      expect(secondDoc.paths["/docs"]).toBeUndefined();
      expect(secondDoc.paths["/docs-json"]).toBeUndefined();

      // Live Bun.serve({ port: 0 }) verification
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
      const liveJson = await fetch(`http://127.0.0.1:${info.port}/docs-json`);
      expect(liveJson.status).toBe(200);
      expect(((await liveJson.json()) as { openapi: string }).openapi).toBe(
        "3.1.0",
      );

      const liveHtml = await fetch(`http://127.0.0.1:${info.port}/docs`);
      expect(liveHtml.status).toBe(200);
      expect(await liveHtml.text()).toContain("bunest-openapi-spec");

      const liveHealth = await fetch(`http://127.0.0.1:${info.port}/health`);
      expect(liveHealth.status).toBe(200);
      expect(await liveHealth.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  test("respects globalPrefix exclusion by default and custom jsonDocumentUrl", async () => {
    @Controller("/items")
    class ItemsController {
      @Get()
      list() {
        return [];
      }
    }

    @Module({ controllers: [ItemsController] })
    class PrefixedAppModule {}

    const app = await BunestFactory.create(PrefixedAppModule, {
      logger: false,
      globalPrefix: "api/v1",
    });

    try {
      const config = new DocumentBuilder().setTitle("Prefixed API").build();
      const doc = SwaggerModule.createDocument(app, config);
      expect(doc.paths["/api/v1/items"]).toBeDefined();

      SwaggerModule.setup("/swagger", app, doc, {
        jsonDocumentUrl: "/openapi.json",
        customSiteTitle: "Custom Explorer",
      });

      // Swagger mounted at root (not prefixed by default)
      const uiRes = await app.fetch(new Request("http://localhost/swagger"));
      expect(uiRes.status).toBe(200);
      expect(await uiRes.text()).toContain("<title>Custom Explorer</title>");

      const specRes = await app.fetch(
        new Request("http://localhost/openapi.json"),
      );
      expect(specRes.status).toBe(200);
      expect(
        ((await specRes.json()) as { info: { title: string } }).info.title,
      ).toBe("Prefixed API");

      // Regular API endpoint remains under global prefix
      const itemsRes = await app.fetch(
        new Request("http://localhost/api/v1/items"),
      );
      expect(itemsRes.status).toBe(200);
      expect(await itemsRes.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test("handles create -> setGlobalPrefix -> createDocument -> setup before init() (both useGlobalPrefix false and true)", async () => {
    @Controller("/items")
    class DynamicPrefixController {
      @Get(":id")
      getOne() {
        return { ok: true };
      }
    }

    @Module({ controllers: [DynamicPrefixController] })
    class DynamicAppModule {}

    // Case 1: useGlobalPrefix: false (default) with setGlobalPrefix called AFTER create() and BEFORE init()
    const app1 = await BunestFactory.create(DynamicAppModule, {
      logger: false,
    });
    try {
      app1.setGlobalPrefix("api");
      const config = new DocumentBuilder()
        .setTitle("Dynamic Prefix API")
        .build();
      const doc = SwaggerModule.createDocument(app1, config);

      expect(doc.paths["/api/items/{id}"]).toBeDefined();
      expect(doc.paths["/items/{id}"]).toBeUndefined();

      SwaggerModule.setup("/docs", app1, doc);

      const docsHtml = await app1.fetch(new Request("http://localhost/docs"));
      expect(docsHtml.status).toBe(200);
      expect(await docsHtml.text()).toContain('href="/docs-json"');

      const docsJson = await app1.fetch(
        new Request("http://localhost/docs-json"),
      );
      expect(docsJson.status).toBe(200);
      expect(
        ((await docsJson.json()) as { paths: Record<string, unknown> }).paths[
          "/api/items/{id}"
        ],
      ).toBeDefined();

      const apiRes = await app1.fetch(
        new Request("http://localhost/api/items/42"),
      );
      expect(apiRes.status).toBe(200);
    } finally {
      await app1.close();
    }
  });

  test("mounts prefixed Swagger routes and emits prefixed JSON href when useGlobalPrefix is true", async () => {
    @Controller("/items")
    class PrefixedItemsController {
      @Get(":id")
      getOne() {
        return { ok: true };
      }
    }

    @Module({ controllers: [PrefixedItemsController] })
    class PrefixedDocsModule {}

    const app2 = await BunestFactory.create(PrefixedDocsModule, {
      logger: false,
    });
    try {
      app2.setGlobalPrefix("api");
      const config = new DocumentBuilder()
        .setTitle("Prefixed Docs API")
        .build();
      const doc = SwaggerModule.createDocument(app2, config);

      SwaggerModule.setup("/docs", app2, doc, { useGlobalPrefix: true });

      const prefixedHtmlRes = await app2.fetch(
        new Request("http://localhost/api/docs"),
      );
      expect(prefixedHtmlRes.status).toBe(200);
      const prefixedHtml = await prefixedHtmlRes.text();
      expect(prefixedHtml).toContain('href="/api/docs-json"');
      expect(prefixedHtml).not.toContain('href="/docs-json"');

      const prefixedJsonRes = await app2.fetch(
        new Request("http://localhost/api/docs-json"),
      );
      expect(prefixedJsonRes.status).toBe(200);
      expect(
        ((await prefixedJsonRes.json()) as { info: { title: string } }).info
          .title,
      ).toBe("Prefixed Docs API");
    } finally {
      await app2.close();
    }
  });
});
