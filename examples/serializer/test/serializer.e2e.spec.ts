import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";

describe("Serialization (NestJS 21-serializer E2E)", () => {
  it("strips @Exclude and prefixed fields, computes @Expose getters, applies @Transform, and respects groups", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    const client = mod.createTestClient(app);
    await app.init();

    try {
      // 1. Public profile: password, _internalToken, and admin-only auditNote are omitted
      const meRes = await client.get("/users/me");
      expect(meRes.status).toBe(200);
      const me = (await meRes.json()) as Record<string, unknown>;
      expect(me).toEqual({
        id: 1,
        firstName: "Ada",
        lastName: "Lovelace",
        fullName: "Ada Lovelace",
        role: "admin",
      });
      expect("password" in me).toBe(false);
      expect("_internalToken" in me).toBe(false);
      expect("auditNote" in me).toBe(false);

      // 2. Admin view: includes groups: ["admin"] field while still stripping password & _internalToken
      const adminRes = await client.get("/users/admin");
      expect(adminRes.status).toBe(200);
      const adminUser = (await adminRes.json()) as Record<string, unknown>;
      expect(adminUser).toEqual({
        id: 1,
        firstName: "Ada",
        lastName: "Lovelace",
        fullName: "Ada Lovelace",
        role: "admin",
        auditNote: "Verified founding member",
      });
      expect("password" in adminUser).toBe(false);
      expect("_internalToken" in adminUser).toBe(false);

      // 3. Collection serialization
      const listRes = await client.get("/users");
      expect(listRes.status).toBe(200);
      const users = (await listRes.json()) as Array<Record<string, unknown>>;
      expect(users).toHaveLength(2);
      expect(users[1]).toEqual({
        id: 2,
        firstName: "Grace",
        lastName: "Hopper",
        fullName: "Grace Hopper",
        role: "engineer",
      });
    } finally {
      await app.close();
    }
  });
});
