import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";

describe("Hello World Example", () => {
  it("serves GET / and GET /health via TestingModule + app.fetch()", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    try {
      const res1 = await app.fetch(new Request("http://localhost/"));
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as { message: string; runtime: string };
      expect(body1.message).toBe("Hello, Bunest!");
      expect(body1.runtime).toContain("Bun");

      const res2 = await app.fetch(new Request("http://localhost/?name=Ada"));
      expect(res2.status).toBe(200);
      expect(await res2.json()).toEqual({
        message: "Hello, Ada!",
        runtime: `Bun ${Bun.version}`,
      });

      const healthRes = await app.fetch(new Request("http://localhost/health"));
      expect(healthRes.status).toBe(200);
      expect(await healthRes.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });
});
