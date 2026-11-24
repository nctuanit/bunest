import { describe, expect, it } from "bun:test";
import {
  AuthenticationError,
  AuthenticationEvents,
  AuthenticationStorage,
  JwksClient,
  JwtError,
  JwtSigner,
  JwtVerifier,
  MfaService,
  RefreshTokenError,
  TokenService,
  type AuthenticationEvent,
} from "../../src/auth-next/index";
import { base32Decode, hotp } from "../../src/auth-next/mfa/otp.util";

const SECRET_32 = "super-secret-signing-key-at-least-32-bytes!";
const SECRET_64 = "a".repeat(64);
const T0 = 1_700_000_000_000;

function derToPem(der: ArrayBuffer | Uint8Array, label: string): string {
  const b64 = Buffer.from(
    der instanceof Uint8Array ? der : new Uint8Array(der),
  ).toString("base64");
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

function readDerTlv(
  buf: Uint8Array,
  offset: number,
): { tag: number; start: number; end: number; next: number } {
  const tag = buf[offset]!;
  const lenByte = buf[offset + 1]!;
  let len = lenByte;
  let start = offset + 2;
  if ((lenByte & 0x80) !== 0) {
    const count = lenByte & 0x7f;
    len = 0;
    for (let i = 0; i < count; i++) {
      len = (len << 8) | buf[offset + 2 + i]!;
    }
    start = offset + 2 + count;
  }
  return { tag, start, end: start + len, next: start + len };
}

function wrapDer(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length;
  const header =
    len < 0x80
      ? new Uint8Array([tag, len])
      : len < 0x100
        ? new Uint8Array([tag, 0x81, len])
        : new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

function pkcs8InnerOctets(pkcs8: Uint8Array): Uint8Array {
  const seq = readDerTlv(pkcs8, 0);
  const ver = readDerTlv(pkcs8, seq.start);
  const alg = readDerTlv(pkcs8, ver.next);
  const oct = readDerTlv(pkcs8, alg.next);
  return pkcs8.subarray(oct.start, oct.end);
}

function pkcs8ToSec1P256Der(pkcs8: Uint8Array): Uint8Array {
  const inner = pkcs8InnerOctets(pkcs8);
  const seq = readDerTlv(inner, 0);
  const ver = readDerTlv(inner, seq.start);
  const priv = readDerTlv(inner, ver.next);
  const rest = inner.subarray(priv.next, seq.end);
  // [0] EXPLICIT OID 1.2.840.10045.3.1.7 (prime256v1 / P-256)
  const curveParam = new Uint8Array([
    0xa0, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  ]);
  const head = inner.subarray(seq.start, priv.next);
  const body = new Uint8Array(head.length + curveParam.length + rest.length);
  body.set(head, 0);
  body.set(curveParam, head.length);
  body.set(rest, head.length + curveParam.length);
  return wrapDer(0x30, body);
}

async function generateRsaPair() {
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
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  return {
    ...pair,
    privatePem: derToPem(pkcs8, "PRIVATE KEY"),
    publicPem: derToPem(spki, "PUBLIC KEY"),
    pkcs1Pem: derToPem(pkcs8InnerOctets(pkcs8), "RSA PRIVATE KEY"),
  };
}

async function generateEcP256Pair() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return {
    ...pair,
    sec1Pem: derToPem(pkcs8ToSec1P256Der(pkcs8), "EC PRIVATE KEY"),
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
}

async function generateEd25519Pair() {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return {
    ...pair,
    privatePem: derToPem(pkcs8, "PRIVATE KEY"),
  };
}

describe("JwtSigner, JwtVerifier, JwksClient & TokenService", () => {
  it("signs and verifies HS256/HS512, RS256, PS256, ES256, and EdDSA tokens", async () => {
    // HS256
    const hsSigner = new JwtSigner({
      key: SECRET_32,
      issuer: "https://auth.example",
      audience: "api",
      ttl: "10m",
      now: () => T0,
    });
    const hsVerifier = new JwtVerifier({
      key: SECRET_32,
      issuer: "https://auth.example",
      audience: "api",
      now: () => T0 + 1_000,
    });
    const hsToken = await hsSigner.sign({ sub: "u1", role: "admin" });
    const hsClaims = await hsVerifier.verify(hsToken);
    expect(hsClaims.sub).toBe("u1");
    expect(hsClaims.role).toBe("admin");
    expect(hsClaims.iss).toBe("https://auth.example");
    expect(hsClaims.aud).toBe("api");
    expect(hsClaims.jti).toBeString();

    // HS512
    const hs512 = new JwtSigner({
      key: SECRET_64,
      alg: "HS512",
      now: () => T0,
    });
    const hs512Verifier = new JwtVerifier({
      key: SECRET_64,
      algorithms: ["HS512"],
      now: () => T0,
    });
    expect(
      (await hs512Verifier.verify(await hs512.sign({ sub: "u512" }))).sub,
    ).toBe("u512");

    // RS256 + PS256
    const rsa = await generateRsaPair();
    const rsSigner = new JwtSigner({
      key: rsa.privatePem,
      alg: "RS256",
      issuer: "https://idp.test",
      audience: "svc",
      now: () => T0,
    });
    const rsVerifier = new JwtVerifier({
      key: rsa.publicPem,
      algorithms: ["RS256"],
      issuer: "https://idp.test",
      audience: "svc",
      now: () => T0,
    });
    expect(
      (await rsVerifier.verify(await rsSigner.sign({ sub: "u-rsa" }))).sub,
    ).toBe("u-rsa");

    const psSigner = new JwtSigner({
      key: rsa.privatePem,
      alg: "PS256",
      issuer: "https://idp.test",
      audience: "svc",
      now: () => T0,
    });
    const psVerifier = new JwtVerifier({
      key: rsa.publicPem,
      algorithms: ["PS256"],
      issuer: "https://idp.test",
      audience: "svc",
      now: () => T0,
    });
    expect(
      (await psVerifier.verify(await psSigner.sign({ sub: "u-ps" }))).sub,
    ).toBe("u-ps");

    // ES256
    const ec = await generateEcP256Pair();
    const esSigner = new JwtSigner({
      key: ec.privateKey,
      issuer: "https://idp.test",
      audience: "svc",
      now: () => T0,
    });
    const esVerifier = new JwtVerifier({
      key: ec.publicKey,
      issuer: "https://idp.test",
      audience: "svc",
      now: () => T0,
    });
    expect(
      (await esVerifier.verify(await esSigner.sign({ sub: "u-ec" }))).sub,
    ).toBe("u-ec");

    // EdDSA (Ed25519)
    const ed = await generateEd25519Pair();
    const edSigner = new JwtSigner({
      key: ed.privateKey,
      issuer: "https://idp.test",
      audience: "svc",
      now: () => T0,
    });
    const edVerifier = new JwtVerifier({
      key: ed.publicKey,
      issuer: "https://idp.test",
      audience: "svc",
      now: () => T0,
    });
    expect(
      (await edVerifier.verify(await edSigner.sign({ sub: "u-ed" }))).sub,
    ).toBe("u-ed");

    // PEM string verification (including private PEM passed to JwtVerifier for Ed25519/EC/RSA)
    const edPrivPem = ed.privatePem;
    const edPemSigner = new JwtSigner({ key: edPrivPem, now: () => T0 });
    const edPemVerifier = new JwtVerifier({ key: edPrivPem, now: () => T0 });
    expect(
      (await edPemVerifier.verify(await edPemSigner.sign({ sub: "u-ed-pem" })))
        .sub,
    ).toBe("u-ed-pem");

    // PKCS#1 RSA PEM + SEC1 EC PEM
    const rsaPkcs1Pem = rsa.pkcs1Pem;
    const rsaPkcs1Signer = new JwtSigner({ key: rsaPkcs1Pem, now: () => T0 });
    const rsaPkcs1Verifier = new JwtVerifier({
      key: rsaPkcs1Pem,
      now: () => T0,
    });
    expect(
      (
        await rsaPkcs1Verifier.verify(
          await rsaPkcs1Signer.sign({ sub: "u-pkcs1" }),
        )
      ).sub,
    ).toBe("u-pkcs1");

    const ecSec1Pem = ec.sec1Pem;
    const ecSec1Signer = new JwtSigner({ key: ecSec1Pem, now: () => T0 });
    const ecSec1Verifier = new JwtVerifier({ key: ecSec1Pem, now: () => T0 });
    expect(
      (await ecSec1Verifier.verify(await ecSec1Signer.sign({ sub: "u-sec1" })))
        .sub,
    ).toBe("u-sec1");
  });

  it("strictly rejects alg:none, key confusion, crit headers, short secrets, and invalid claims", async () => {
    const verifier = new JwtVerifier({
      key: SECRET_32,
      issuer: "https://auth.example",
      audience: "api",
      type: "at+jwt",
      maxAge: "5m",
      now: () => T0,
    });

    // alg: none attack
    const noneHeader = Buffer.from(
      JSON.stringify({ alg: "none", typ: "at+jwt" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "attacker",
        iss: "https://auth.example",
        aud: "api",
        iat: Math.floor(T0 / 1000),
        exp: Math.floor(T0 / 1000) + 600,
      }),
    ).toString("base64url");
    await expect(verifier.verify(`${noneHeader}.${payload}.`)).rejects.toThrow(
      JwtError,
    );

    // RSA public key PEM used as HS256 secret -> rejected
    const rsa = await generateRsaPair();
    const pubPem = rsa.publicPem;
    expect(
      () =>
        new JwtVerifier({
          key: pubPem,
          algorithms: ["HS256"],
          issuer: "a",
          audience: "b",
        }),
    ).toThrow(TypeError);

    // Public key without issuer & audience -> rejected
    expect(() => new JwtVerifier({ key: rsa.publicKey })).toThrow(TypeError);

    // Short secret rejected unless allowShortSecret
    expect(() => new JwtSigner({ key: "too-short" })).toThrow(TypeError);
    const shortSigner = new JwtSigner({
      key: "too-short",
      allowShortSecret: true,
      now: () => T0,
    });
    const shortVerifier = new JwtVerifier({
      key: "too-short",
      allowShortSecret: true,
      now: () => T0,
    });
    expect(
      (await shortVerifier.verify(await shortSigner.sign({ sub: "s" }))).sub,
    ).toBe("s");

    // Media type normalization: application/at+jwt matches at+jwt
    const typedSigner = new JwtSigner({
      key: SECRET_32,
      issuer: "https://auth.example",
      audience: "api",
      type: "application/at+jwt",
      now: () => T0,
    });
    expect(
      (await verifier.verify(await typedSigner.sign({ sub: "u1" }))).sub,
    ).toBe("u1");

    // Expired token rejected
    const expiredSigner = new JwtSigner({
      key: SECRET_32,
      issuer: "https://auth.example",
      audience: "api",
      type: "at+jwt",
      ttl: "1m",
      now: () => T0 - 120_000,
    });
    await expect(
      verifier.verify(await expiredSigner.sign({ sub: "u1" })),
    ).rejects.toThrow("token expired");

    // crit header rejected
    const critHeader = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "at+jwt", crit: ["exp"] }),
    ).toString("base64url");
    await expect(
      verifier.verify(`${critHeader}.${payload}.sig`),
    ).rejects.toThrow("unsupported critical header");
  });

  it("JwksClient caches keys, rotates on unknown kid with cooldown, and rejects non-HTTPS", async () => {
    expect(() => new JwksClient("http://evil.example/jwks.json")).toThrow(
      TypeError,
    );

    const k1 = await generateEcP256Pair();
    const k2 = await generateEcP256Pair();
    const jwk1 = {
      ...k1.publicJwk,
      kid: "k1",
      use: "sig",
      alg: "ES256",
    };
    const jwk2 = {
      ...k2.publicJwk,
      kid: "k2",
      use: "sig",
      alg: "ES256",
    };

    let clock = T0;
    let fetches = 0;
    let activeKeys = [jwk1];

    const jwks = new JwksClient("https://idp.example/.well-known/jwks.json", {
      now: () => clock,
      cooldown: "30s",
      fetch: (async () => {
        fetches++;
        return new Response(JSON.stringify({ keys: activeKeys }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const verifier = new JwtVerifier({
      jwks,
      algorithms: ["ES256"],
      issuer: "https://idp.example",
      audience: "my-app",
      now: () => clock,
    });

    const s1 = new JwtSigner({
      key: k1.privateKey,
      kid: "k1",
      issuer: "https://idp.example",
      audience: "my-app",
      now: () => clock,
    });
    expect((await verifier.verify(await s1.sign({ sub: "u1" }))).sub).toBe(
      "u1",
    );
    expect(fetches).toBe(1);

    // Cached second verify does not refetch
    expect((await verifier.verify(await s1.sign({ sub: "u1" }))).sub).toBe(
      "u1",
    );
    expect(fetches).toBe(1);

    // Key rotation after cooldown fetches new key
    activeKeys = [jwk1, jwk2];
    clock += 31_000;
    const s2 = new JwtSigner({
      key: k2.privateKey,
      kid: "k2",
      issuer: "https://idp.example",
      audience: "my-app",
      now: () => clock,
    });
    expect((await verifier.verify(await s2.sign({ sub: "u2" }))).sub).toBe(
      "u2",
    );
    expect(fetches).toBe(2);
  });

  it("TokenService issues, rotates, detects reuse & revokes family, protects locked claims, and enforces MFA", async () => {
    let clock = T0;
    const storage = new AuthenticationStorage();
    const events = new AuthenticationEvents();
    const seen: AuthenticationEvent[] = [];
    events.events$.subscribe((e) => seen.push(e));

    const opts = {
      accessToken: {
        key: SECRET_32,
        issuer: "https://app.test",
        audience: "mobile",
        ttl: "15m" as const,
        now: () => clock,
      },
      refreshToken: {
        ttl: "7d" as const,
        absoluteTtl: "30d" as const,
        now: () => clock,
      },
      mfa: { encryption: { keys: ["m".repeat(32)] }, now: () => clock },
    };
    const mfa = new MfaService(storage, opts, events);
    const tokens = new TokenService(storage, opts, events, mfa);
    const verifier = new JwtVerifier({
      key: SECRET_32,
      issuer: "https://app.test",
      audience: "mobile",
      now: () => clock,
    });

    // Issue strips spoofed MFA amr values
    const first = await tokens.issue("u1", {
      method: "password",
      claims: { tenant: "t1", amr: ["pwd", "mfa", "otp"] },
    });
    const c1 = await verifier.verify(first.accessToken);
    expect(c1.sub).toBe("u1");
    expect(c1.tenant).toBe("t1");
    expect(c1.amr).toEqual(["pwd"]);

    // Refresh with claims mapper cannot alter locked claims
    const second = await tokens.refresh(first.refreshToken, {
      claims: (current) => ({
        ...current,
        tenant: "t2",
        sub: "hacked",
        amr: ["mfa"],
      }),
    });
    const c2 = await verifier.verify(second.accessToken);
    expect(c2.sub).toBe("u1");
    expect(c2.tenant).toBe("t2");
    expect(c2.amr).toEqual(["pwd"]);

    // Reusing old refresh token revokes the entire family
    await expect(tokens.refresh(first.refreshToken)).rejects.toThrow(
      RefreshTokenError,
    );
    expect(seen.some((e) => e.type === "refresh-token-reused")).toBe(true);
    await expect(tokens.refresh(second.refreshToken)).rejects.toMatchObject({
      reason: "invalid",
    });

    // MFA enrolled user must pass secondFactor on issue()
    const { secret } = await mfa.enroll("u2", "u2@test");
    const codeAt = (offset = 0) =>
      hotp(base32Decode(secret), Math.floor(clock / 30_000) + offset);
    expect(await mfa.confirm("u2", codeAt())).toBe(true);
    clock += 30_000;

    await expect(tokens.issue("u2")).rejects.toMatchObject({
      code: "mfa_required",
    });
    const withMfa = await tokens.issue("u2", {
      secondFactor: { code: codeAt() },
    });
    const cMfa = await verifier.verify(withMfa.accessToken);
    expect(cMfa.amr).toEqual(["mfa"]);

    // Revoke single family
    expect(await tokens.revoke(withMfa.refreshToken)).toBe(true);
    await expect(tokens.refresh(withMfa.refreshToken)).rejects.toThrow(
      RefreshTokenError,
    );

    // refreshToken: false mode
    const stateless = new TokenService(storage, {
      accessToken: opts.accessToken,
      refreshToken: false,
    });
    const accessOnly = await stateless.issue("u3");
    expect(accessOnly.accessToken).toBeString();
    expect("refreshToken" in accessOnly).toBe(false);
    await expect(stateless.refresh("anything")).rejects.toThrow();
    await expect(stateless.revoke("anything")).rejects.toThrow();
  });

  it("AuthenticationError defaults to status 401 and supports code/details/challenge", () => {
    const err = new AuthenticationError("bad token", {
      code: "invalid_token",
      challenge: 'Bearer realm="api"',
      details: { attempt: 1 },
    });
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_token");
    expect(err.challenge).toBe('Bearer realm="api"');
    expect(err.details).toEqual({ attempt: 1 });
  });
});
