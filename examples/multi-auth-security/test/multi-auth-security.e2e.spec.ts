import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateTotp(secretBase32: string, stepOffset = 0): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = Buffer.from(
    new Bun.CryptoHasher("sha1", key).update(msg).digest(),
  );
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

describe("Multi-Auth Security (JWT + Refresh Rotation + TOTP MFA + API Key + ABAC Policy)", () => {
  it("enforces full auth chain, refresh reuse revocation, TOTP MFA, API keys, and ABAC policy rules", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    try {
      // 1. Unauthenticated request blocked with 401
      const unauth = await app.fetch(new Request("http://localhost/auth/me"));
      expect(unauth.status).toBe(401);

      // 2. Alice signs in with Argon2id password -> receives JWT + refresh token
      const loginRes = await app.fetch(
        new Request("http://localhost/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "alice@bunest.dev",
            password: "alice-secret-pass",
          }),
        }),
      );
      expect(loginRes.status).toBe(200);
      const aliceSession = (await loginRes.json()) as {
        accessToken: string;
        refreshToken: string;
      };
      expect(aliceSession.accessToken).toBeTruthy();
      expect(aliceSession.refreshToken).toBeTruthy();

      // 3. Refresh token rotation works, and replaying the spent refresh token revokes the family
      const rotateRes = await app.fetch(
        new Request("http://localhost/auth/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: aliceSession.refreshToken }),
        }),
      );
      expect(rotateRes.status).toBe(200);
      const rotated = (await rotateRes.json()) as {
        accessToken: string;
        refreshToken: string;
      };
      expect(rotated.refreshToken).not.toBe(aliceSession.refreshToken);

      // Reusing old refresh token -> rejected & whole family revoked
      const replayRes = await app.fetch(
        new Request("http://localhost/auth/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: aliceSession.refreshToken }),
        }),
      );
      expect(replayRes.status).toBe(401);

      const revokedSuccessor = await app.fetch(
        new Request("http://localhost/auth/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: rotated.refreshToken }),
        }),
      );
      expect(revokedSuccessor.status).toBe(401);

      // 4. ABAC DocumentPolicy: Alice owns doc-1 (200), cannot read Bob's doc-2 (403)
      const ownDocRes = await app.fetch(
        new Request("http://localhost/documents/doc-1", {
          headers: { authorization: `Bearer ${rotated.accessToken}` },
        }),
      );
      expect(ownDocRes.status).toBe(200);

      const foreignDocRes = await app.fetch(
        new Request("http://localhost/documents/doc-2", {
          headers: { authorization: `Bearer ${rotated.accessToken}` },
        }),
      );
      expect(foreignDocRes.status).toBe(403);

      // 5. Alice mints a prefixed API key (bnst_<id>_<secret>) and authenticates with it
      const keyRes = await app.fetch(
        new Request("http://localhost/auth/api-keys", {
          method: "POST",
          headers: { authorization: `Bearer ${rotated.accessToken}` },
        }),
      );
      expect(keyRes.status).toBe(201);
      const { key: apiKey } = (await keyRes.json()) as { key: string };
      expect(apiKey.startsWith("bnst_")).toBe(true);

      const apiKeyMe = await app.fetch(
        new Request("http://localhost/auth/me", {
          headers: { authorization: `Bearer ${apiKey}` },
        }),
      );
      expect(apiKeyMe.status).toBe(200);
      expect(await apiKeyMe.json()).toMatchObject({
        email: "alice@bunest.dev",
        authMethod: "api-key",
      });

      // 6. TOTP MFA enrollment, confirmation, and MFA-elevated sign-in
      const enrollRes = await app.fetch(
        new Request("http://localhost/auth/mfa/enroll", {
          method: "POST",
          headers: { authorization: `Bearer ${rotated.accessToken}` },
        }),
      );
      expect(enrollRes.status).toBe(201);
      const { secret, uri } = (await enrollRes.json()) as {
        secret: string;
        uri: string;
      };
      expect(uri).toContain("otpauth://totp/");

      const confirmRes = await app.fetch(
        new Request("http://localhost/auth/mfa/confirm", {
          method: "POST",
          headers: {
            authorization: `Bearer ${rotated.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ code: generateTotp(secret) }),
        }),
      );
      expect(confirmRes.status).toBe(200);

      // Login without TOTP fails now; login with valid TOTP emits amr: ["mfa"]
      const noTotpLogin = await app.fetch(
        new Request("http://localhost/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "alice@bunest.dev",
            password: "alice-secret-pass",
          }),
        }),
      );
      expect(noTotpLogin.status).toBe(401);

      const mfaLogin = await app.fetch(
        new Request("http://localhost/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "alice@bunest.dev",
            password: "alice-secret-pass",
            totpCode: generateTotp(secret, 1),
          }),
        }),
      );
      expect(mfaLogin.status).toBe(200);
      const mfaTokens = (await mfaLogin.json()) as { accessToken: string };
      const mfaMe = await app.fetch(
        new Request("http://localhost/auth/me", {
          headers: { authorization: `Bearer ${mfaTokens.accessToken}` },
        }),
      );
      expect(await mfaMe.json()).toMatchObject({
        email: "alice@bunest.dev",
        amr: ["mfa"],
      });

      // 7. Admin overrides DocumentPolicy via `before()` hook and can patch Bob's doc-2
      const adminLogin = await app.fetch(
        new Request("http://localhost/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "admin@bunest.dev",
            password: "admin-secret-pass",
          }),
        }),
      );
      const { accessToken: adminJwt } = (await adminLogin.json()) as {
        accessToken: string;
      };
      const adminPatch = await app.fetch(
        new Request("http://localhost/documents/doc-2", {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${adminJwt}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ title: "Updated by Admin" }),
        }),
      );
      expect(adminPatch.status).toBe(200);
      expect(await adminPatch.json()).toMatchObject({
        id: "doc-2",
        title: "Updated by Admin",
      });
    } finally {
      await app.close();
    }
  });
});
