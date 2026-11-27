import { describe, expect, it } from "bun:test";
import {
  BunestFactory,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  Scope,
} from "@bunest/core";
import {
  DevtoolsModule,
  DevtoolsService,
  type DevtoolsApplicationGraph,
} from "../src";
import { renderDevtoolsHtml } from "../src/devtools/devtools.viewer";

describe("Interactive Devtools HTML/SVG Viewer", () => {
  it("serves a self-contained zero-dep HTML/SVG viewer at GET /_devtools with nodes, edges, routes, and dark/light theme", async () => {
    @Injectable()
    class CatalogRepo {}

    @Injectable()
    class CatalogService {
      constructor(public readonly repo: CatalogRepo) {}
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestTracker {}

    @Controller("/catalog")
    class CatalogController {
      constructor(public readonly catalog: CatalogService) {}

      @Get(":sku")
      @HttpCode(200)
      getSku(@Param("sku") sku: string) {
        return { sku };
      }
    }

    @Module({
      controllers: [CatalogController],
      providers: [CatalogRepo, CatalogService, RequestTracker],
      exports: [CatalogService],
    })
    class CatalogModule {}

    @Module({
      imports: [CatalogModule, DevtoolsModule.forRoot()],
    })
    class AppModule {}

    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const app = await BunestFactory.create(AppModule, {
      logger: false,
      snapshot: true,
    });
    const devtools = app.get(DevtoolsService);
    devtools.attachApplication(app);

    try {
      const res = await app.fetch(new Request("http://localhost/_devtools"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");

      const html = await res.text();
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain('<svg id="devtools-svg"');
      expect(html).toContain("CatalogModule");
      expect(html).toContain("CatalogController");
      expect(html).toContain("CatalogService");
      expect(html).toContain("CatalogRepo");
      expect(html).toContain("RequestTracker");
      expect(html).toContain("/catalog/:sku");
      expect(html).toContain("dg-scope-request");
      expect(html).toContain("dg-edge-provider-dependency");
      expect(html).toContain("prefers-color-scheme: dark");
      expect(html).toContain('data-theme');
      expect(html).toContain('id="btn-zoom-in"');
      expect(html).toContain('id="search-input"');
      expect(html).toContain('id="node-details"');
      expect(html).toContain("/_devtools/graph");
      expect(html).toContain("/_devtools/routes");
      expect(html).toContain("/_devtools/mermaid");

      // Zero external CDN / script / stylesheet dependencies
      expect(html).not.toMatch(/<script[^>]+src=/i);
      expect(html).not.toMatch(/<link[^>]+href=/i);
      expect(html).not.toMatch(/@import\s+url/i);
      expect(html).not.toMatch(/https?:\/\/(?:cdn|unpkg|jsdelivr|fonts\.)/i);
      // CSP-safe: no inline onclick/onload attributes
      expect(html).not.toMatch(/\son(?:click|change|input|load)=/i);

      // Production gate blocks GET /_devtools as well
      process.env.NODE_ENV = "production";
      const prodRes = await app.fetch(new Request("http://localhost/_devtools"));
      expect(prodRes.status).toBe(403);
    } finally {
      process.env.NODE_ENV = prevEnv;
      await app.close();
    }
  });

  it("mounts viewer at custom configured path and hides it when exposeEndpoints is false", async () => {
    @Module({
      imports: [DevtoolsModule.forRoot({ path: "/_inspect", enabled: true })],
    })
    class CustomPathApp {}

    const app1 = await BunestFactory.create(CustomPathApp, { logger: false });
    try {
      const res = await app1.fetch(new Request("http://localhost/_inspect"));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("/_inspect/graph");
      expect(html).toContain("/_inspect/routes");
      expect(html).toContain("/_inspect/mermaid");
    } finally {
      await app1.close();
    }

    @Module({
      imports: [DevtoolsModule.register({ http: false })],
    })
    class DisabledHttpApp {}

    const app2 = await BunestFactory.create(DisabledHttpApp, { logger: false });
    try {
      const res = await app2.fetch(new Request("http://localhost/_devtools"));
      expect(res.status).toBe(404);
    } finally {
      await app2.close();
    }
  });

  it("renders boot-profile initTimeMs timings from both graph nodes and serializedGraph metadata, and escapes XSS safely", () => {
    const syntheticGraph: DevtoolsApplicationGraph = {
      generatedAt: "2026-11-26T00:00:00.000Z",
      modules: [
        {
          id: "mod-app",
          name: "AppModule",
          isGlobal: false,
          isDynamic: false,
          imports: ["mod-xss"],
          exports: [],
          reExports: [],
          controllers: ["HealthController"],
          providers: ["SlowDbPool"],
          initTimeMs: 12.45,
        },
        {
          id: "mod-xss",
          name: 'Evil</script><img src=x onerror="alert(1)">Module',
          isGlobal: true,
          isDynamic: false,
          imports: [],
          exports: ["FastCache"],
          reExports: [],
          controllers: [],
          providers: ["FastCache"],
        },
      ],
      edges: [
        { from: "mod-app", to: "mod-xss", type: "import" },
        {
          from: "mod-app::SlowDbPool",
          to: "FastCache",
          type: "provider-dependency",
        },
      ],
      providers: [
        {
          id: "mod-app::SlowDbPool",
          moduleId: "mod-app",
          moduleName: "AppModule",
          token: "SlowDbPool",
          kind: "class",
          scope: Scope.SINGLETON,
          isExported: false,
          dependencies: ["FastCache"],
          initTimeMs: 42.75,
        },
        {
          id: "mod-xss::FastCache",
          moduleId: "mod-xss",
          moduleName: 'Evil</script><img src=x onerror="alert(1)">Module',
          token: "FastCache",
          kind: "class",
          scope: Scope.SINGLETON,
          isExported: true,
          dependencies: [],
        },
      ],
      controllers: [
        {
          moduleId: "mod-app",
          moduleName: "AppModule",
          name: "HealthController",
          path: "/health",
          scope: Scope.SINGLETON,
          routeCount: 1,
          initTimeMs: 1.25,
        },
      ],
      routes: [
        {
          method: "GET",
          path: "/",
          fullPath: "/health",
          controller: "HealthController",
          handler: "check",
          parameters: [],
          guards: [],
          pipes: [],
          interceptors: [],
          filters: [],
          httpCode: 200,
          isSse: false,
        },
      ],
      serializedGraph: {
        nodes: {
          "mod-xss:provider:FastCache": {
            id: "mod-xss:provider:FastCache",
            label: "FastCache",
            parent: "mod-xss",
            metadata: {
              type: "provider",
              sourceModuleName: 'Evil</script><img src=x onerror="alert(1)">Module',
              initTime: 3.5,
            },
          },
        },
        edges: {},
        entrypoints: {},
        extras: { orphanedEnhancers: [], attachedEnhancers: [] },
        status: "complete",
      },
    };

    const html = renderDevtoolsHtml(syntheticGraph, { basePath: "/_devtools" });

    // Boot-profile timings rendered for direct initTimeMs AND serializedGraph initTime fallback
    expect(html).toContain("42.75ms");
    expect(html).toContain("12.45ms");
    expect(html).toContain("3.50ms");
    expect(html).toContain("1.25ms");
    expect(html).toContain("Boot Profile (4)");
    expect(html).toContain('data-init-ms="42.75"');
    expect(html).toContain("SlowDbPool (42.75ms)");

    // XSS payload must NOT break out of HTML or <script> tags
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("Evil</script>");
    expect(html).toContain("Evil&lt;/script&gt;&lt;img");
    expect(html).toContain("Evil<\\/script>");
  });
});
