import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { SqliteService } from "@bunest/sqlite";
import { Test } from "@bunest/testing";
import {
  configureAuthSqliteApp,
  createAuthSqliteModule,
} from "../src/app.module";

describe("Auth JWT + SQLite Example (E2E)", () => {
  it("runs register (argon2id), login (JWT), RBAC @Roles, transactional rollback, headers, and graceful close", async () => {
    const TestAppModule = createAuthSqliteModule(":memory:");
    const mod = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile();

    const app = mod.createBunestApplication();
    configureAuthSqliteApp(app);
    const client = mod.createTestClient(app);
    await app.init();

    const sqlite = mod.get(SqliteService);

    try {
      // 1. Protected route rejects anonymous caller with 401 + security headers applied
      const unauthRes = await client.get("/auth/me");
      expect(unauthRes.status).toBe(401);
      expect(unauthRes.headers.get("x-content-type-options")).toBe("nosniff");
      expect(unauthRes.headers.get("x-frame-options")).toBe("DENY");

      // 2. Register standard user & admin user (passwords hashed with Argon2id)
      const regUser = await client.post("/auth/register", {
        json: { email: "alice@bunest.dev", password: "password123" },
      });
      expect(regUser.status).toBe(201);

      const storedHash = sqlite.queryOne<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE email = ?",
        ["alice@bunest.dev"],
      );
      expect(storedHash?.password_hash).toStartWith("$argon2id$");

      const regAdmin = await client.post("/auth/register", {
        json: {
          email: "admin@bunest.dev",
          password: "admin-password-123",
          roles: ["user", "admin"],
        },
      });
      expect(regAdmin.status).toBe(201);

      // 3. Login -> receive signed JWT
      const userLogin = await client.post("/auth/login", {
        json: { email: "alice@bunest.dev", password: "password123" },
      });
      expect(userLogin.status).toBe(201);
      const { accessToken: userToken } = (await userLogin.json()) as {
        accessToken: string;
      };
      expect(userToken.split(".")).toHaveLength(3);

      const adminLogin = await client.post("/auth/login", {
        json: { email: "admin@bunest.dev", password: "admin-password-123" },
      });
      const { accessToken: adminToken } = (await adminLogin.json()) as {
        accessToken: string;
      };

      // 4. Access protected /auth/me with Bearer token
      const meRes = await client.get("/auth/me", {
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(meRes.status).toBe(200);
      expect(await meRes.json()).toMatchObject({
        email: "alice@bunest.dev",
        roles: ["user"],
      });

      // 5. @Roles("admin") -> 403 for standard user, 200 for admin
      const forbiddenRes = await client.get("/admin/stats", {
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(forbiddenRes.status).toBe(403);

      // 6. Transactional task creation (commit) & rollback on error
      const okTask = await client.post("/tasks", {
        headers: { authorization: `Bearer ${userToken}` },
        json: { title: "Ship Bunest" },
      });
      expect(okTask.status).toBe(201);

      const failTask = await client.post("/tasks", {
        headers: { authorization: `Bearer ${userToken}` },
        json: { title: "Should Roll Back", failAfterInsert: "true" },
      });
      expect(failTask.status).toBe(500);

      // Verify only committed task persists and failed insert + audit rolled back atomically
      const tasksList = await client.get("/tasks", {
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(tasksList.status).toBe(200);
      expect(await tasksList.json()).toHaveLength(1);

      const adminRes = await client.get("/admin/stats", {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(adminRes.status).toBe(200);
      expect(await adminRes.json()).toEqual({
        userCount: 2,
        taskCount: 1,
        auditCount: 1,
        appliedMigrations: ["001_create_users", "002_create_tasks"],
      });
    } finally {
      await app.close();
    }

    // Graceful close releases SQLite handle cleanly
    expect(sqlite.isClosed).toBe(true);
  });
});
