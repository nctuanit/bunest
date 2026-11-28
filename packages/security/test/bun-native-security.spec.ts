import { describe, expect, it } from "bun:test";
import {
  computePkceChallenge,
  computePkceChallengeSync,
  generatePkcePair,
  isValidPkceVerifier,
  SessionCookieService,
  verifyPkceChallenge,
} from "../src/index";
import {
  decodeJws,
  signJws,
  toKeyObject,
  verifySignature,
} from "../src/auth-next/jwt/jws.util";
import { serializeCookie } from "../src/auth-next/session/cookies.util";

function toPem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

describe("Wave 4: @bunest/security Bun-native primitives", () => {
  describe("PKCE via Bun.CryptoHasher.hash (RFC 7636)", () => {
    // RFC 7636 Appendix B official test vector
    const RFC7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const RFC7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    it("matches RFC 7636 Appendix B S256 test vector synchronously and asynchronously", async () => {
      expect(isValidPkceVerifier(RFC7636_VERIFIER)).toBe(true);
      expect(computePkceChallengeSync(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
      expect(await computePkceChallenge(RFC7636_VERIFIER)).toBe(
        RFC7636_CHALLENGE,
      );
      expect(
        await verifyPkceChallenge(RFC7636_VERIFIER, RFC7636_CHALLENGE),
      ).toBe(true);
      expect(
        await verifyPkceChallenge(RFC7636_VERIFIER, "wrong-challenge-value"),
      ).toBe(false);
    });

    it("generates and verifies fresh PKCE pairs", async () => {
      const pair = await generatePkcePair();
      expect(pair.codeChallengeMethod).toBe("S256");
      expect(isValidPkceVerifier(pair.codeVerifier)).toBe(true);
      expect(computePkceChallengeSync(pair.codeVerifier)).toBe(
        pair.codeChallenge,
      );
      expect(
        await verifyPkceChallenge(pair.codeVerifier, pair.codeChallenge),
      ).toBe(true);
    });

    it("rejects invalid PKCE verifiers (too short, too long, illegal chars)", async () => {
      expect(() => computePkceChallengeSync("too-short")).toThrow(
        /Invalid PKCE code_verifier/,
      );
      expect(() => computePkceChallengeSync("a".repeat(129))).toThrow(
        /Invalid PKCE code_verifier/,
      );
      expect(() =>
        computePkceChallengeSync("a".repeat(42) + " "),
      ).toThrow(/Invalid PKCE code_verifier/);
      expect(await verifyPkceChallenge("too-short", RFC7636_CHALLENGE)).toBe(
        false,
      );
      expect(await verifyPkceChallenge(RFC7636_VERIFIER, "")).toBe(false);
    });
  });

  describe("JWS DER/PEM parsing via Bun.concatArrayBuffers", () => {
    it("parses RSA PKCS#8 PEM, synthesizes SPKI via concatBytes, and signs/verifies RS256", async () => {
      const pair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      );
      const pkcs8Der = new Uint8Array(
        await crypto.subtle.exportKey("pkcs8", pair.privateKey),
      );
      const privatePem = toPem("PRIVATE KEY", pkcs8Der);

      const jwsPrivate = toKeyObject(privatePem);
      expect(jwsPrivate.type).toBe("private");
      expect(jwsPrivate.asymmetricKeyType).toBe("rsa");
      expect(jwsPrivate.asymmetricKeyDetails?.modulusLength).toBe(2048);
      // extractRsaPrivateInfo synthesizes spkiDer via concatBytes (Bun.concatArrayBuffers)
      expect(jwsPrivate.spkiDer).toBeInstanceOf(Uint8Array);
      expect(jwsPrivate.spkiDer!.byteLength).toBeGreaterThan(200);

      const token = await signJws(
        { alg: "RS256", typ: "JWT" },
        { sub: "user-rsa", exp: Math.floor(Date.now() / 1000) + 300 },
        jwsPrivate,
      );
      const decoded = decodeJws(token);
      expect(decoded.header.alg).toBe("RS256");
      expect(decoded.payload.sub).toBe("user-rsa");

      // Verify using the derived public key (uses the synthesized spkiDer)
      await verifySignature("RS256", jwsPrivate.toPublicKey(), decoded);

      // Tampering signature must fail
      const tampered = {
        ...decoded,
        signature: Buffer.from(decoded.signature),
      };
      tampered.signature[0] = tampered.signature[0]! ^ 0xff;
      await expect(
        verifySignature("RS256", jwsPrivate.toPublicKey(), tampered),
      ).rejects.toThrow(/invalid signature/);
    });

    it("parses EC P-256 PKCS#8 PEM and signs/verifies ES256", async () => {
      const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      const pkcs8Der = new Uint8Array(
        await crypto.subtle.exportKey("pkcs8", pair.privateKey),
      );
      const spkiDer = new Uint8Array(
        await crypto.subtle.exportKey("spki", pair.publicKey),
      );

      const jwsPrivate = toKeyObject(toPem("PRIVATE KEY", pkcs8Der));
      const jwsPublic = toKeyObject(toPem("PUBLIC KEY", spkiDer));
      expect(jwsPrivate.asymmetricKeyType).toBe("ec");
      expect(jwsPrivate.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");

      const token = await signJws(
        { alg: "ES256" },
        { sub: "user-ec", exp: Math.floor(Date.now() / 1000) + 300 },
        jwsPrivate,
      );
      const decoded = decodeJws(token);
      await verifySignature("ES256", jwsPublic, decoded);
      await verifySignature("ES256", jwsPrivate.toPublicKey(), decoded);
    });
  });

  describe("SessionCookieService HMAC via Bun.CryptoHasher", () => {
    it("signs, verifies, and rejects tampered or expired session cookies", async () => {
      const svc = new SessionCookieService({
        secret: "super-secret-session-key-32-bytes!",
        ttlSeconds: 60,
      });

      const signed = await svc.sign({ userId: "u_123", role: "admin" });
      const verified = await svc.verify<{ userId: string; role: string }>(
        signed,
      );
      expect(verified).toEqual({ userId: "u_123", role: "admin" });

      // Tampered payload fails HMAC check
      const [payloadPart, sigPart] = signed.split(".");
      const tampered = `${payloadPart}x.${sigPart}`;
      expect(await svc.verify(tampered)).toBeNull();

      // Different secret fails HMAC check
      const otherSvc = new SessionCookieService({
        secret: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      });
      expect(await otherSvc.verify(signed)).toBeNull();

      // Expired session fails
      const futureSec = Math.floor(Date.now() / 1000) + 120;
      expect(await svc.verify(signed, futureSec)).toBeNull();
    });
  });

  describe("cookies.util serializeCookie RFC 6265 validation", () => {
    it("serializes valid cookies and rejects CRLF / semicolon injection in name, path, and domain", () => {
      const valid = serializeCookie("__Host-sid", "abc 123", {
        maxAge: 3600,
        secure: true,
        sameSite: "strict",
        path: "/",
      });
      expect(valid).toBe(
        "__Host-sid=abc%20123; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Strict",
      );

      expect(() =>
        serializeCookie("bad;name", "v", { maxAge: 60 }),
      ).toThrow(TypeError);
      expect(() =>
        serializeCookie("bad\r\nname", "v", { maxAge: 60 }),
      ).toThrow(TypeError);
      expect(() =>
        serializeCookie("sid", "v", {
          maxAge: 60,
          path: "/; Secure\r\nX-Injected: 1",
        }),
      ).toThrow(TypeError);
      expect(() =>
        serializeCookie("sid", "v", {
          maxAge: 60,
          domain: "example.com; Path=/evil",
        }),
      ).toThrow(TypeError);
      expect(() =>
        serializeCookie("sid", "v", {
          maxAge: 60,
          domain: "example.com\r\nSet-Cookie: pwn=1",
        }),
      ).toThrow(TypeError);
    });
  });
});
