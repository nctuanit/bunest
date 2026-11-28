import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule, configureCatsApp } from "../src/app.module";
import type { Cat } from "../src/cats/interfaces/cat.interface";

describe("Cats App (NestJS 01-cats-app E2E)", () => {
  it("runs full pipeline: middleware, RolesGuard, ValidationPipe, ParseIntPipe, interceptors, filter, and custom @Actor()", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    configureCatsApp(app);
    const client = mod.createTestClient(app);
    await app.init();

    try {
      // 1. GET /cats -> wrapped by TransformInterceptor, middleware & logging headers set
      const listRes = await client.get("/cats");
      expect(listRes.status).toBe(200);
      expect(listRes.headers.get("x-middleware-applied")).toBe("cats-logger");
      expect(listRes.headers.get("x-response-time")).toMatch(/^\d+\.\d+ms$/);
      const listBody = (await listRes.json()) as { data: Cat[] };
      expect(listBody.data).toHaveLength(1);
      expect(listBody.data[0]?.name).toBe("Milo");

      // 2. POST /cats without admin role -> 403 via RolesGuard + HttpExceptionFilter
      const forbiddenRes = await client.post("/cats", {
        headers: { "x-roles": "viewer" },
        json: { name: "Luna", age: 2, breed: "Siamese" },
      });
      expect(forbiddenRes.status).toBe(403);
      const forbiddenBody = (await forbiddenRes.json()) as {
        statusCode: number;
        path: string;
      };
      expect(forbiddenBody.statusCode).toBe(403);
      expect(forbiddenBody.path).toBe("/cats");

      // 3. POST /cats with admin role + invalid payload -> 400 via ValidationPipe
      const invalidRes = await client.post("/cats", {
        headers: { "x-roles": "admin", "x-user": "alice" },
        json: { name: "X", age: -5, breed: "A" },
      });
      expect(invalidRes.status).toBe(400);

      // 4. POST /cats with admin role + valid DTO -> 201 + @Actor() captured
      const createdRes = await client.post("/cats", {
        headers: { "x-roles": "admin", "x-user": "alice" },
        json: { name: "Luna", age: 2, breed: "Siamese" },
      });
      expect(createdRes.status).toBe(201);
      const created = (await createdRes.json()) as { data: Cat };
      expect(created.data).toEqual({
        id: 2,
        name: "Luna",
        age: 2,
        breed: "Siamese",
        createdBy: "alice",
      });

      // 5. GET /cats/:id with ParseIntPipe
      const oneRes = await client.get("/cats/2");
      expect(oneRes.status).toBe(200);
      expect(((await oneRes.json()) as { data: Cat }).data.name).toBe("Luna");

      const badIdRes = await client.get("/cats/not-a-number");
      expect(badIdRes.status).toBe(400);

      const missingRes = await client.get("/cats/999");
      expect(missingRes.status).toBe(404);
      expect(((await missingRes.json()) as { path: string }).path).toBe(
        "/cats/999",
      );
    } finally {
      await app.close();
    }
  });
});
