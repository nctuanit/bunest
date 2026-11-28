import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule, configureRestCrudApp } from "../src/app.module";
import { UsersService, type UserRecord } from "../src/users/users.service";

describe("REST CRUD Example (E2E)", () => {
  it("executes full Users CRUD, DTO ValidationPipe 400 checks, 404 filter, and OpenAPI /docs-json", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    configureRestCrudApp(app);
    const client = mod.createTestClient(app);
    await app.init();

    try {
      const usersService = mod.get(UsersService);

      // 1. Invalid DTO -> 400 with normalized validation details; handler MUST NOT be invoked
      const invalidRes = await client.post("/users", {
        json: {
          name: "A",
          email: "not-an-email",
          age: 5,
          unknownField: "evil",
        },
      });
      expect(invalidRes.status).toBe(400);
      const invalidBody = (await invalidRes.json()) as {
        statusCode: number;
        path: string;
        details?: unknown[];
      };
      expect(invalidBody.statusCode).toBe(400);
      expect(invalidBody.path).toBe("/users");
      expect(Array.isArray(invalidBody.details)).toBe(true);
      expect(invalidBody.details!.length).toBeGreaterThan(0);
      expect(usersService.createInvocations).toBe(0);

      // 2. POST /users -> 201
      const createdRes = await client.post("/users", {
        json: { name: "Ada Lovelace", email: "ada@bunest.dev", age: 36 },
      });
      expect(createdRes.status).toBe(201);
      const created = (await createdRes.json()) as UserRecord;
      expect(created.id).toBe("usr_1");
      expect(created.name).toBe("Ada Lovelace");
      expect(created.email).toBe("ada@bunest.dev");
      expect(created.age).toBe(36);

      // 3. GET /users -> 200
      const listRes = await client.get("/users");
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toHaveLength(1);

      // 4. GET /users/:id -> 200
      const getRes = await client.get(`/users/${created.id}`);
      expect(getRes.status).toBe(200);
      expect(((await getRes.json()) as UserRecord).email).toBe(
        "ada@bunest.dev",
      );

      // 5. PATCH /users/:id -> 200
      const patchRes = await client.patch(`/users/${created.id}`, {
        json: { name: "Augusta Ada", age: 37 },
      });
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as UserRecord;
      expect(patched.name).toBe("Augusta Ada");
      expect(patched.age).toBe(37);

      // 6. DELETE /users/:id -> 204
      const delRes = await client.delete(`/users/${created.id}`);
      expect(delRes.status).toBe(204);

      // 7. GET deleted user -> 404 formatted by ApiExceptionFilter
      const missingRes = await client.get(`/users/${created.id}`);
      expect(missingRes.status).toBe(404);
      const missingBody = (await missingRes.json()) as {
        statusCode: number;
        path: string;
      };
      expect(missingBody.statusCode).toBe(404);
      expect(missingBody.path).toBe(`/users/${created.id}`);

      // 8. Swagger OpenAPI 3.1 document at /docs-json & UI at /docs
      const openApiRes = await client.get("/docs-json");
      expect(openApiRes.status).toBe(200);
      const doc = (await openApiRes.json()) as {
        openapi: string;
        info: { title: string };
        paths: Record<string, unknown>;
        components?: { schemas?: Record<string, unknown> };
      };
      expect(doc.openapi).toBe("3.1.0");
      expect(doc.info.title).toBe("Bunest REST CRUD API");
      expect(doc.paths["/users"]).toBeDefined();
      expect(doc.paths["/users/{id}"]).toBeDefined();
      expect(doc.components?.schemas?.CreateUserDto).toBeDefined();

      const htmlRes = await client.get("/docs");
      expect(htmlRes.status).toBe(200);
      expect(await htmlRes.text()).toContain("Bunest REST CRUD API");
    } finally {
      await app.close();
    }
  });
});
