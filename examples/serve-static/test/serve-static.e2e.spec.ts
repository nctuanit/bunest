import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule, configureServeStaticApp } from "../src/app.module";

describe("Serve Static (NestJS 24-serve-static E2E)", () => {
  it("serves static files with ETag/304, SPA fallback, /api endpoints, StreamableFile, and path traversal defense", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    configureServeStaticApp(app);
    await app.init();

    try {
      // 1. Static index.html at /
      const rootRes = await app.fetch(new Request("http://localhost/"));
      expect(rootRes.status).toBe(200);
      expect(await rootRes.text()).toContain("Bunest ServeStaticModule");

      // 2. Static JS asset with ETag -> 304 Not Modified
      const jsRes = await app.fetch(new Request("http://localhost/app.js"));
      expect(jsRes.status).toBe(200);
      expect(await jsRes.text()).toContain('fetch("/api/info")');
      const etag = jsRes.headers.get("etag");
      expect(etag).toBeTruthy();

      const cachedRes = await app.fetch(
        new Request("http://localhost/app.js", {
          headers: { "If-None-Match": etag! },
        }),
      );
      expect(cachedRes.status).toBe(304);

      // 3. SPA client route fallback -> index.html
      const spaRes = await app.fetch(
        new Request("http://localhost/dashboard/settings"),
      );
      expect(spaRes.status).toBe(200);
      expect(await spaRes.text()).toContain("Bunest ServeStaticModule");

      // 4. API endpoints under /api/*
      const infoRes = await app.fetch(new Request("http://localhost/api/info"));
      expect(infoRes.status).toBe(200);
      expect(await infoRes.json()).toEqual({
        name: "bunest-serve-static",
        version: "1.0.0",
        runtime: "bun",
      });

      // Unknown /api/* route must NOT fall back to SPA index.html
      const missingApi = await app.fetch(
        new Request("http://localhost/api/does-not-exist"),
      );
      expect(missingApi.status).toBe(404);

      // 5. StreamableFile download
      const dlRes = await app.fetch(
        new Request("http://localhost/api/download"),
      );
      expect(dlRes.status).toBe(200);
      expect(dlRes.headers.get("content-disposition")).toBe(
        'attachment; filename="report.csv"',
      );
      expect(await dlRes.text()).toContain("1,Bunest");

      // 6. Traversal attempt blocked
      const traversalRes = await app.fetch(
        new Request("http://localhost/%2e%2e/package.json"),
      );
      expect([403, 404]).toContain(traversalRes.status);
    } finally {
      await app.close();
    }
  });
});
