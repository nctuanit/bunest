import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import {
  JwtExpiredException,
  JwtInvalidException,
  JwtModule,
  JwtNotBeforeException,
  JwtService,
  base64UrlEncode,
} from "../src";

async function exportPem(
  key: CryptoKey,
  format: "pkcs8" | "spki",
  label: string,
): Promise<string> {
  const der = await crypto.subtle.exportKey(format, key);
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

describe("JwtService & JwtModule", () => {
  it("signs and verifies HS256, HS384, and HS512 tokens via WebCrypto", async () => {
    const secret = "super-strong-hmac-secret-key-32bytes!";
    const jwt = new JwtService({ secret });

    for (const algorithm of ["HS256", "HS384", "HS512"] as const) {
      const token = await jwt.sign(
        { sub: "user_1", role: "admin" },
        { algorithm, expiresIn: "10m", issuer: "bunest-auth", audience: "api" },
      );

      const decoded = jwt.decode(token, { complete: true });
      expect(decoded?.header.alg).toBe(algorithm);
      expect(decoded?.payload.sub).toBe("user_1");

      const verified = await jwt.verify<{ sub: string; role: string }>(token, {
        algorithms: [algorithm],
        issuer: "bunest-auth",
        audience: "api",
      });
      expect(verified.sub).toBe("user_1");
      expect(verified.role).toBe("admin");
    }
  });

  it("signs and verifies RS256 and ES256 tokens using both CryptoKey and PEM strings", async () => {
    // RSA-2048 for RS256
    const rsaPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const rsaPrivPem = await exportPem(
      rsaPair.privateKey,
      "pkcs8",
      "PRIVATE KEY",
    );
    const rsaPubPem = await exportPem(rsaPair.publicKey, "spki", "PUBLIC KEY");

    const rsaJwt = new JwtService({
      privateKey: rsaPrivPem,
      publicKey: rsaPubPem,
      signOptions: { algorithm: "RS256" },
    });
    const rsaToken = await rsaJwt.sign({ sub: "rsa_user" });
    const rsaPayload = await rsaJwt.verify<{ sub: string }>(rsaToken);
    expect(rsaPayload.sub).toBe("rsa_user");

    // ECDSA P-256 for ES256
    const ecPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const ecPrivPem = await exportPem(
      ecPair.privateKey,
      "pkcs8",
      "PRIVATE KEY",
    );
    const ecPubPem = await exportPem(ecPair.publicKey, "spki", "PUBLIC KEY");

    const ecJwt = new JwtService({
      privateKey: ecPrivPem,
      publicKey: ecPubPem,
      signOptions: { algorithm: "ES256" },
    });
    const ecToken = await ecJwt.sign({ sub: "ec_user" });
    expect((await ecJwt.verify<{ sub: string }>(ecToken)).sub).toBe("ec_user");

    // Also works with raw CryptoKey objects directly
    const rawEcJwt = new JwtService({
      privateKey: ecPair.privateKey,
      publicKey: ecPair.publicKey,
    });
    const rawToken = await rawEcJwt.sign({ sub: "raw_ec" });
    expect((await rawEcJwt.verify<{ sub: string }>(rawToken)).sub).toBe(
      "raw_ec",
    );
  });

  it("rejects alg: 'none', algorithm confusion (RS256 -> HS256), disallowed algorithms, and tampered tokens", async () => {
    const secret = "hmac-secret-123";
    const jwt = new JwtService({ secret });

    // 1. alg: "none" attack (both lowercase and uppercase)
    for (const badAlg of ["none", "NONE", "None"]) {
      const forged = `${base64UrlEncode(JSON.stringify({ alg: badAlg, typ: "JWT" }))}.${base64UrlEncode(JSON.stringify({ sub: "admin" }))}.fakesig`;
      await expect(jwt.verify(forged)).rejects.toThrow(JwtInvalidException);
    }

    // 2. Algorithm confusion attack: sign HS256 with RSA public key PEM, attempt verify on RS256 service
    const rsaPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const rsaPubPem = await exportPem(rsaPair.publicKey, "spki", "PUBLIC KEY");

    const attackerSigner = new JwtService({ secret: rsaPubPem });
    const confusedToken = await attackerSigner.sign(
      { sub: "admin" },
      { algorithm: "HS256" },
    );

    const victimVerifier = new JwtService({ publicKey: rsaPubPem });
    await expect(victimVerifier.verify(confusedToken)).rejects.toThrow(
      JwtInvalidException,
    );

    // 3. Explicit algorithm allowlist enforcement
    const hs256Token = await jwt.sign({ sub: "u1" }, { algorithm: "HS256" });
    await expect(
      jwt.verify(hs256Token, { algorithms: ["HS512"] }),
    ).rejects.toThrow(JwtInvalidException);

    // 4. Tampered payload & tampered signature
    const [h, p, s] = hs256Token.split(".") as [string, string, string];
    const tamperedPayload = base64UrlEncode(
      JSON.stringify({ sub: "admin", iat: 1 }),
    );
    await expect(jwt.verify(`${h}.${tamperedPayload}.${s}`)).rejects.toThrow(
      JwtInvalidException,
    );
    const flippedSig = (s[0] === "A" ? "B" : "A") + s.slice(1);
    await expect(jwt.verify(`${h}.${p}.${flippedSig}`)).rejects.toThrow(
      JwtInvalidException,
    );

    // 5. Malformed token decode returns null
    expect(jwt.decode("not.a.valid.jwt.token")).toBeNull();
    expect(jwt.decode("invalid")).toBeNull();

    // 6. HMAC CryptoKey hash mismatch attack: SHA-256 HMAC CryptoKey MUST reject alg: "HS512"
    const rawKeyBytes = new TextEncoder().encode("crypto-key-hmac-secret");
    const sha256SignKey = await crypto.subtle.importKey(
      "raw",
      rawKeyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sha256VerifyOnlyKey = await crypto.subtle.importKey(
      "raw",
      rawKeyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const forgedHeader = base64UrlEncode(
      JSON.stringify({ alg: "HS512", typ: "JWT" }),
    );
    const forgedPayload = base64UrlEncode(JSON.stringify({ sub: "attacker" }));
    const forgedInput = `${forgedHeader}.${forgedPayload}`;
    const sha256Sig = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        sha256SignKey,
        new TextEncoder().encode(forgedInput),
      ),
    );
    const forgedHs512WithSha256 = `${forgedInput}.${base64UrlEncode(sha256Sig)}`;

    const hmacCryptoVerifier = new JwtService({ secret: sha256VerifyOnlyKey });
    await expect(
      hmacCryptoVerifier.verify(forgedHs512WithSha256),
    ).rejects.toThrow(JwtInvalidException);
    // Even with explicit algorithms: ["HS512"], hash mismatch on CryptoKey MUST reject
    await expect(
      hmacCryptoVerifier.verify(forgedHs512WithSha256, {
        algorithms: ["HS512"],
      }),
    ).rejects.toThrow(JwtInvalidException);

    // 7. Verify-only HMAC CryptoKey succeeds on legitimate HS256 token (no InvalidAccessError!)
    const legitHs256 = await new JwtService({ secret: sha256SignKey }).sign(
      { sub: "valid-user" },
      { algorithm: "HS256" },
    );
    const verifiedLegit = await hmacCryptoVerifier.verify<{ sub: string }>(
      legitHs256,
    );
    expect(verifiedLegit.sub).toBe("valid-user");

    // 8. Malformed/empty PEM throws JwtInvalidException (401), NOT raw Error (500)
    const badPemJwt = new JwtService({
      privateKey: "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----",
      publicKey: "-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----",
      signOptions: { algorithm: "RS256" },
    });
    await expect(badPemJwt.sign({ sub: "x" })).rejects.toThrow(
      JwtInvalidException,
    );
    const dummyRs256 = `${base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64UrlEncode(JSON.stringify({ sub: "x" }))}.${base64UrlEncode("sig")}`;
    await expect(badPemJwt.verify(dummyRs256)).rejects.toThrow(
      JwtInvalidException,
    );
  });

  it("enforces exp, nbf, clockTolerance, iss, aud, sub, and jti claims", async () => {
    const jwt = new JwtService({ secret: "claims-secret" });
    const nowSec = Math.floor(Date.now() / 1000);

    // Expired token
    const expiredToken = await jwt.sign({ sub: "u1", exp: nowSec - 10 });
    await expect(jwt.verify(expiredToken)).rejects.toThrow(JwtExpiredException);
    // Accepted within clockTolerance
    expect((await jwt.verify(expiredToken, { clockTolerance: 20 })).sub).toBe(
      "u1",
    );

    // Future nbf token
    const futureToken = await jwt.sign({ sub: "u1", nbf: nowSec + 30 });
    await expect(jwt.verify(futureToken)).rejects.toThrow(
      JwtNotBeforeException,
    );
    expect((await jwt.verify(futureToken, { clockTolerance: 60 })).sub).toBe(
      "u1",
    );

    // iss, aud, sub, jti checks
    const fullToken = await jwt.sign(
      { sub: "user-42" },
      {
        issuer: "https://auth.bunest.dev",
        audience: ["web", "mobile"],
        jwtid: "jti-99",
        expiresIn: "5m",
      },
    );

    const ok = await jwt.verify(fullToken, {
      issuer: "https://auth.bunest.dev",
      audience: /^mob/,
      subject: "user-42",
      jwtid: "jti-99",
    });
    expect(ok.jti).toBe("jti-99");

    await expect(
      jwt.verify(fullToken, { issuer: "https://wrong.dev" }),
    ).rejects.toThrow(JwtInvalidException);
    await expect(
      jwt.verify(fullToken, { audience: "admin-only" }),
    ).rejects.toThrow(JwtInvalidException);
    await expect(
      jwt.verify(fullToken, { subject: "other-user" }),
    ).rejects.toThrow(JwtInvalidException);
    await expect(jwt.verify(fullToken, { jwtid: "wrong-jti" })).rejects.toThrow(
      JwtInvalidException,
    );
  });

  it("integrates JwtModule.register and JwtModule.registerAsync with DI", async () => {
    const mod = await Test.createTestingModule({
      imports: [
        JwtModule.registerAsync({
          useFactory: async () => {
            await Promise.resolve();
            return {
              secret: "async-di-secret",
              signOptions: { expiresIn: "1h" },
            };
          },
        }),
      ],
    }).compile();

    const jwt = mod.get(JwtService);
    const tok = await jwt.sign({ sub: "di_user" });
    expect((await jwt.verify<{ sub: string }>(tok)).sub).toBe("di_user");
    await mod.close();
  });
});
