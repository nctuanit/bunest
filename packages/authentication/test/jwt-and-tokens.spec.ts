import { generateKeyPairSync } from "node:crypto";
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
} from "../src/index";
import { base32Decode, hotp } from "../src/mfa/otp.util";

const SECRET_32 = "super-secret-signing-key-at-least-32-bytes!";
const SECRET_64 = "a".repeat(64);
const T0 = 1_700_000_000_000;

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
    const hsToken = hsSigner.sign({ sub: "u1", role: "admin" });
    const hsClaims = await hsVerifier.verify(hsToken);
    expect(hsClaims.sub).toBe("u1");
    expect(hsClaims.role).toBe("admin");
    expect(hsClaims.iss).toBe("https://auth.example");
    expect(hsClaims.aud).toBe("api");
    expect(hsClaims.jti).toBeString();

    // HS512
    const hs512 = new JwtSigner({ key: SECRET_64, alg: "HS512", now: () => T0 });
    const hs512Verifier = new JwtVerifier({
      key: SECRET_64,
      algorithms: ["HS512"],
      now: () => T0,
    });
    expect((await hs512Verifier.verify(hs512.sign({ sub: "u512" }))).sub).toBe(
      "u512",
    );

    // RS256 + PS256
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsSigner = new JwtSigner({
      key: rsa.privateKey,
      alg: "RS256",
      issuer: "https://idp.test",
      audience: "svc",
      now: () => T0,
    });
    const rsVerifier = new JwtVerifier({
      key: rsa.publicKey,
      algorithms: ["RS256"],
      issuer: "https://idp.test",
      audience: "svc",
      now: () => T0,
    });
    expect((await rsVerifier.verify(rsSigner.sign({ sub: "u-rsa" }))).sub).toBe(
      "u-rsa",
    );

    const psSigner = new JwtSigner({
      key: rsa.privateKey,
      alg: "PS256",
      issuer: "https://idp.test",
      audience: "svc",
      now: () => T0,
    });
    const psVerifier = new JwtVerifier({
      key: rsa.publicKey,
      algorithms: ["PS256"],
      issuer: "https://idp.test",
      audience: "svc",
      now: () => T0,
    });
    expect((await psVerifier.verify(psSigner.sign({ sub: "u-ps" }))).sub).toBe(
      "u-ps",
    );

    // ES256
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
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
    expect((await esVerifier.verify(esSigner.sign({ sub: "u-ec" }))).sub).toBe(
      "u-ec",
    );

    // EdDSA (Ed25519)
    const ed = generateKeyPairSync("ed25519");
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
    expect((await edVerifier.verify(edSigner.sign({ sub: "u-ed" }))).sub).toBe(
      "u-ed",
    );
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
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pubPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(
      () => new JwtVerifier({ key: pubPem, algorithms: ["HS256"], issuer: "a", audience: "b" }),
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
    expect((await shortVerifier.verify(shortSigner.sign({ sub: "s" }))).sub).toBe(
      "s",
    );

    // Media type normalization: application/at+jwt matches at+jwt
    const typedSigner = new JwtSigner({
      key: SECRET_32,
      issuer: "https://auth.example",
      audience: "api",
      type: "application/at+jwt",
      now: () => T0,
    });
    expect((await verifier.verify(typedSigner.sign({ sub: "u1" }))).sub).toBe(
      "u1",
    );

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
      verifier.verify(expiredSigner.sign({ sub: "u1" })),
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

    const k1 = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const k2 = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk1 = { ...k1.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "ES256" };
    const jwk2 = { ...k2.publicKey.export({ format: "jwk" }), kid: "k2", use: "sig", alg: "ES256" };

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
    expect((await verifier.verify(s1.sign({ sub: "u1" }))).sub).toBe("u1");
    expect(fetches).toBe(1);

    // Cached second verify does not refetch
    expect((await verifier.verify(s1.sign({ sub: "u1" }))).sub).toBe("u1");
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
    expect((await verifier.verify(s2.sign({ sub: "u2" }))).sub).toBe("u2");
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
      refreshToken: { ttl: "7d" as const, absoluteTtl: "30d" as const, now: () => clock },
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
