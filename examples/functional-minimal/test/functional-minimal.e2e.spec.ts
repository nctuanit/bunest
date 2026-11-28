import { describe, expect, it } from "bun:test";
import { createMinimalApp } from "../src/app";

describe("Zero-Boilerplate Functional Microservice (E2E)", () => {
  it("runs defineRoutes + BunestFactory.createRoutes() with DI, s.* validation, and automatic OpenAPI 3.1", async () => {
    const app = await createMinimalApp();
    await app.init();

    try {
      // 1. Invalid URL rejected with 400
      const badRes = await app.fetch(
        new Request("http://localhost/links", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "not-a-valid-url" }),
        }),
      );
      expect(badRes.status).toBe(400);

      // 2. Valid shorten request -> 201
      const createRes = await app.fetch(
        new Request("http://localhost/links", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://bun.sh",
            customCode: "bun",
          }),
        }),
      );
      expect(createRes.status).toBe(201);
      expect(await createRes.json()).toEqual({
        code: "bun",
        url: "https://bun.sh",
        hits: 0,
      });

      // 3. Resolve increments hit count
      const hitRes = await app.fetch(new Request("http://localhost/links/bun"));
      expect(hitRes.status).toBe(200);
      expect(await hitRes.json()).toEqual({
        code: "bun",
        url: "https://bun.sh",
        hits: 1,
      });

      // 4. OpenAPI 3.1 generated cleanly with tags & schemas
      const specRes = await app.fetch(new Request("http://localhost/docs-json"));
      expect(specRes.status).toBe(200);
      const doc = (await specRes.json()) as {
        paths: Record<string, Record<string, { tags?: string[]; summary?: string }>>;
      };
      expect(doc.paths["/links"]?.post?.tags).toEqual(["links"]);
      expect(doc.paths["/links"]?.post?.summary).toBe("Create a short link");
    } finally {
      await app.close();
    }
  });
});
