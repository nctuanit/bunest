import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { createModernAuthAppModule } from "../src/app.module";

describe("Modern Auth Integrations — Better Auth + API Keys + ABAC (E2E)", () => {
  it("handles /api/auth/* sign-in/sign-out, cookie sessions, service API keys, and ABAC owner-only policies", async () => {
    const mod = await Test.createTestingModule({
      imports: [createModernAuthAppModule()],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    try {
      // 1. Public endpoint works without auth
      const pubRes = await app.fetch(
        new Request("http://localhost/projects/public-status"),
      );
      expect(pubRes.status).toBe(200);

      // 2. Protected route blocks unauthenticated requests with 401
      const unauth = await app.fetch(
        new Request("http://localhost/projects/me"),
      );
      expect(unauth.status).toBe(401);

      // 3. Sign in as member via Better Auth /api/auth/sign-in/email
      const memberSignIn = await app.fetch(
        new Request("http://localhost/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "member@bunest.dev",
            password: "password123",
          }),
        }),
      );
      expect(memberSignIn.status).toBe(200);
      const memberCookie = memberSignIn.headers
        .getSetCookie()[0]!
        .split(";")[0]!;

      // Member can read /projects/me but cannot delete (403 ABAC)
      const memberMe = await app.fetch(
        new Request("http://localhost/projects/me", {
          headers: { cookie: memberCookie },
        }),
      );
      expect(memberMe.status).toBe(200);
      expect(await memberMe.json()).toMatchObject({
        user: { email: "member@bunest.dev", role: "member" },
        totalBetterAuthSessions: 1,
      });

      const memberDelete = await app.fetch(
        new Request("http://localhost/projects/proj-1", {
          method: "DELETE",
          headers: { cookie: memberCookie },
        }),
      );
      expect(memberDelete.status).toBe(403);

      // 4. Sign in as owner, mint a prefixed API key, and delete project via API key!
      const ownerSignIn = await app.fetch(
        new Request("http://localhost/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "owner@bunest.dev",
            password: "password123",
          }),
        }),
      );
      const ownerCookie = ownerSignIn.headers
        .getSetCookie()[0]!
        .split(";")[0]!;

      const keyRes = await app.fetch(
        new Request("http://localhost/projects/api-keys", {
          method: "POST",
          headers: { cookie: ownerCookie },
        }),
      );
      expect(keyRes.status).toBe(201);
      const { key: serviceKey } = (await keyRes.json()) as { key: string };

      const apiKeyDelete = await app.fetch(
        new Request("http://localhost/projects/proj-1", {
          method: "DELETE",
          headers: { authorization: `Bearer ${serviceKey}` },
        }),
      );
      expect(apiKeyDelete.status).toBe(200);
      expect(await apiKeyDelete.json()).toEqual({
        deleted: "proj-1",
        by: "owner@bunest.dev",
      });

      // 5. Better Auth /api/auth/sign-out invalidates browser session immediately
      const signOutRes = await app.fetch(
        new Request("http://localhost/api/auth/sign-out", {
          method: "POST",
          headers: { cookie: memberCookie },
        }),
      );
      expect(signOutRes.status).toBe(200);

      const afterSignOut = await app.fetch(
        new Request("http://localhost/projects/me", {
          headers: { cookie: memberCookie },
        }),
      );
      expect(afterSignOut.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
