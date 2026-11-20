import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import {
  JwksClient,
  JwksModule,
  JwksService,
  JwtExpiredException,
  JwtInvalidException,
  JwtNotBeforeException,
  OAuth2Exception,
  OAuth2Module,
  OAuth2Providers,
  OAuth2Service,
  OidcModule,
  OidcService,
  base64UrlEncode,
  computePkceChallenge,
  generateNonce,
  generatePkcePair,
  generateState,
  importPublicJwk,
  verifyPkceChallenge,
  type FetchLike,
  type JwksAlgorithm,
  type JwksKey,
} from "../src";

interface SigningKeyMaterial {
  kid: string;
  alg: JwksAlgorithm;
  privateKey: CryptoKey;
  publicJwk: JwksKey;
}

async function generateSigningMaterial(
  alg: JwksAlgorithm,
  kid: string,
  includeAlgOnJwk = true,
): Promise<SigningKeyMaterial> {
  let pair: CryptoKeyPair;
  if (alg.startsWith("RS")) {
    const hash =
      alg === "RS256" ? "SHA-256" : alg === "RS384" ? "SHA-384" : "SHA-512";
    pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash,
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
  } else {
    const namedCurve =
      alg === "ES256" ? "P-256" : alg === "ES384" ? "P-384" : "P-521";
    pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
  }

  const exported = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JwksKey;

  const publicJwk: JwksKey = {
    ...exported,
    kid,
    use: "sig",
    ...(includeAlgOnJwk ? { alg } : {}),
  };
  if (!includeAlgOnJwk) {
    delete publicJwk.alg;
  }

  return {
    kid,
    alg,
    privateKey: pair.privateKey,
    publicJwk,
  };
}

async function signJwtWithMaterial(
  material: SigningKeyMaterial,
  payload: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header: Record<string, unknown> = {
    alg: material.alg,
    typ: "JWT",
    kid: material.kid,
    ...headerOverrides,
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const data = new TextEncoder().encode(signingInput);

  let rawSig: ArrayBuffer;
  if (material.alg.startsWith("RS")) {
    rawSig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      material.privateKey,
      data,
    );
  } else {
    const hash =
      material.alg === "ES256"
        ? "SHA-256"
        : material.alg === "ES384"
          ? "SHA-384"
          : "SHA-512";
    rawSig = await crypto.subtle.sign(
      { name: "ECDSA", hash },
      material.privateKey,
      data,
    );
  }

  return `${signingInput}.${base64UrlEncode(new Uint8Array(rawSig))}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("JWKS Client (RS256/384/512, ES256/384/512, rotation, DoS cooldown, security)", () => {
  it("verifies RS256, RS384, RS512, ES256, ES384, and ES512 tokens against exported JWKs", async () => {
    const algs: readonly JwksAlgorithm[] = [
      "RS256",
      "RS384",
      "RS512",
      "ES256",
      "ES384",
      "ES512",
    ];
    const materials = await Promise.all(
      algs.map((alg) => generateSigningMaterial(alg, `kid-${alg}`)),
    );

    let fetches = 0;
    const fetchFn: FetchLike = async () => {
      fetches++;
      return jsonResponse({ keys: materials.map((m) => m.publicJwk) });
    };

    const jwks = new JwksClient({
      jwksUri: "https://idp.example.com/.well-known/jwks.json",
      fetchFn,
    });

    const nowSec = Math.floor(Date.now() / 1000);
    for (const mat of materials) {
      const token = await signJwtWithMaterial(mat, {
        sub: `user-${mat.alg}`,
        iss: "https://idp.example.com",
        aud: "bunest-api",
        iat: nowSec,
        exp: nowSec + 300,
      });

      const verified = await jwks.verifyJwtWithJwks<{ sub: string }>(token, {
        issuer: "https://idp.example.com",
        audience: "bunest-api",
        algorithms: [mat.alg],
      });
      expect(verified.sub).toBe(`user-${mat.alg}`);
    }

    // All 6 verifications served from a single cached JWKS fetch
    expect(fetches).toBe(1);
  });

  it("handles automatic key rotation on unknown kid (with single-flight deduplication) and rate-limits unknown-kid DoS floods", async () => {
    const keyV1 = await generateSigningMaterial("RS256", "key-v1");
    const keyV2 = await generateSigningMaterial("ES256", "key-v2");

    let activeKeys: JwksKey[] = [keyV1.publicJwk];
    let fetchCount = 0;
    let fakeNow = 1_700_000_000_000;

    const fetchFn: FetchLike = async () => {
      fetchCount++;
      // Small async tick to test concurrent single-flight deduplication
      await Promise.resolve();
      return jsonResponse({ keys: activeKeys });
    };

    const jwks = new JwksClient({
      jwksUri: "https://idp.example.com/.well-known/jwks.json",
      cacheTtlMs: 300_000,
      rateLimitRefreshMs: 60_000,
      fetchFn,
      nowFn: () => fakeNow,
    });

    const nowSec = Math.floor(fakeNow / 1000);
    const tokenV1 = await signJwtWithMaterial(keyV1, {
      sub: "alice",
      exp: nowSec + 300,
    });

    // 1. Initial verification loads key-v1 (fetch #1)
    expect((await jwks.verifyJwtWithJwks<{ sub: string }>(tokenV1)).sub).toBe(
      "alice",
    );
    expect(fetchCount).toBe(1);

    // 2. Provider rotates keys to include key-v2; 5 concurrent requests arrive for key-v2
    activeKeys = [keyV1.publicJwk, keyV2.publicJwk];
    const tokenV2 = await signJwtWithMaterial(keyV2, {
      sub: "bob",
      exp: nowSec + 300,
    });

    const concurrentResults = await Promise.all([
      jwks.verifyJwtWithJwks<{ sub: string }>(tokenV2),
      jwks.verifyJwtWithJwks<{ sub: string }>(tokenV2),
      jwks.verifyJwtWithJwks<{ sub: string }>(tokenV2),
      jwks.verifyJwtWithJwks<{ sub: string }>(tokenV2),
      jwks.verifyJwtWithJwks<{ sub: string }>(tokenV2),
    ]);
    for (const res of concurrentResults) {
      expect(res.sub).toBe("bob");
    }
    // Single-flight deduplication: only 1 forced refresh occurred (total = 2)
    expect(fetchCount).toBe(2);

    // 3. Unknown-kid DoS flood within cooldown window -> 0 additional fetches!
    for (let i = 0; i < 20; i++) {
      const evilToken = await signJwtWithMaterial(
        keyV2,
        { sub: "attacker", exp: nowSec + 300 },
        { kid: `evil-kid-${i}` },
      );
      await expect(jwks.verifyJwtWithJwks(evilToken)).rejects.toThrow(
        JwtInvalidException,
      );
    }
    expect(fetchCount).toBe(2);

    // 4. Advance clock past rateLimitRefreshMs -> allows 1 forced refresh again
    fakeNow += 61_000;
    const keyV3 = await generateSigningMaterial("ES256", "key-v3");
    activeKeys = [keyV2.publicJwk, keyV3.publicJwk];
    const tokenV3 = await signJwtWithMaterial(keyV3, {
      sub: "charlie",
      exp: nowSec + 600,
    });
    expect((await jwks.verifyJwtWithJwks<{ sub: string }>(tokenV3)).sub).toBe(
      "charlie",
    );
    expect(fetchCount).toBe(3);

    // 5. Advance clock past cacheTtlMs -> normal TTL refresh
    fakeNow += 301_000;
    expect((await jwks.verifyJwtWithJwks<{ sub: string }>(tokenV3)).sub).toBe(
      "charlie",
    );
    expect(fetchCount).toBe(4);
  });

  it("strictly rejects symmetric oct JWKs, alg: 'none', HS256 confusion, disallowed algs, and claim mismatches", async () => {
    const rsaKey = await generateSigningMaterial("RS256", "rsa-1");
    const ecKey = await generateSigningMaterial("ES256", "ec-1");
    const octJwk: JwksKey = {
      kty: "oct",
      kid: "sym-oct-1",
      alg: "HS256",
      k: base64UrlEncode("super-secret-symmetric-key"),
    };
    const encJwk: JwksKey = {
      ...rsaKey.publicJwk,
      kid: "rsa-enc",
      use: "enc",
    };

    // Direct importPublicJwk rejections
    await expect(importPublicJwk(octJwk)).rejects.toThrow(JwtInvalidException);
    await expect(
      importPublicJwk({ ...rsaKey.publicJwk, alg: "none" }),
    ).rejects.toThrow(JwtInvalidException);
    await expect(importPublicJwk(encJwk, "RS256")).rejects.toThrow(
      JwtInvalidException,
    );
    await expect(importPublicJwk(ecKey.publicJwk, "ES384")).rejects.toThrow(
      JwtInvalidException,
    );

    let fetchCount = 0;
    const jwks = new JwksClient({
      jwksUri: "https://idp.example.com/.well-known/jwks.json",
      fetchFn: async () => {
        fetchCount++;
        return jsonResponse({
          keys: [rsaKey.publicJwk, ecKey.publicJwk, octJwk, encJwk],
        });
      },
    });

    const nowSec = Math.floor(Date.now() / 1000);

    // 1. Token claiming alg: "none" rejected before fetching
    const noneToken = `${base64UrlEncode(JSON.stringify({ alg: "none", kid: "rsa-1" }))}.${base64UrlEncode(JSON.stringify({ sub: "admin" }))}.sig`;
    await expect(jwks.verifyJwtWithJwks(noneToken)).rejects.toThrow(
      JwtInvalidException,
    );
    expect(fetchCount).toBe(0);

    // 2. Token claiming HS256 rejected before fetching
    const hsToken = `${base64UrlEncode(JSON.stringify({ alg: "HS256", kid: "sym-oct-1" }))}.${base64UrlEncode(JSON.stringify({ sub: "admin" }))}.sig`;
    await expect(jwks.verifyJwtWithJwks(hsToken)).rejects.toThrow(
      JwtInvalidException,
    );
    expect(fetchCount).toBe(0);

    // 3. Token claiming RS256 pointing at oct JWK kid -> rejected without extra refresh!
    const octPointingToken = await signJwtWithMaterial(
      rsaKey,
      { sub: "evil", exp: nowSec + 300 },
      { kid: "sym-oct-1" },
    );
    await expect(jwks.verifyJwtWithJwks(octPointingToken)).rejects.toThrow(
      JwtInvalidException,
    );
    expect(fetchCount).toBe(1);

    // 4. Token pointing at use:"enc" key -> rejected
    const encPointingToken = await signJwtWithMaterial(
      rsaKey,
      { sub: "evil", exp: nowSec + 300 },
      { kid: "rsa-enc" },
    );
    await expect(jwks.verifyJwtWithJwks(encPointingToken)).rejects.toThrow(
      JwtInvalidException,
    );

    // 5. Algorithm allowlist mismatch
    const validRsa = await signJwtWithMaterial(rsaKey, {
      sub: "u1",
      iss: "https://idp.example.com",
      aud: "app-1",
      exp: nowSec + 300,
    });
    await expect(
      jwks.verifyJwtWithJwks(validRsa, { algorithms: ["ES256"] }),
    ).rejects.toThrow(JwtInvalidException);

    // 6. Tampered payload / signature
    const [h, p, s] = validRsa.split(".") as [string, string, string];
    const tampered = `${h}.${base64UrlEncode(JSON.stringify({ sub: "admin", exp: nowSec + 300 }))}.${s}`;
    await expect(jwks.verifyJwtWithJwks(tampered)).rejects.toThrow(
      JwtInvalidException,
    );

    // 7. Expired token throws JwtExpiredException (and passes with clockTolerance)
    const expired = await signJwtWithMaterial(rsaKey, {
      sub: "u1",
      exp: nowSec - 15,
    });
    await expect(jwks.verifyJwtWithJwks(expired)).rejects.toThrow(
      JwtExpiredException,
    );
    expect(
      (await jwks.verifyJwtWithJwks<{ sub: string }>(expired, { clockTolerance: 30 }))
        .sub,
    ).toBe("u1");

    // 8. Future nbf throws JwtNotBeforeException
    const futureNbf = await signJwtWithMaterial(rsaKey, {
      sub: "u1",
      nbf: nowSec + 60,
      exp: nowSec + 300,
    });
    await expect(jwks.verifyJwtWithJwks(futureNbf)).rejects.toThrow(
      JwtNotBeforeException,
    );

    // 9. Wrong issuer / wrong audience
    await expect(
      jwks.verifyJwtWithJwks(validRsa, { issuer: "https://other.example.com" }),
    ).rejects.toThrow(JwtInvalidException);
    await expect(
      jwks.verifyJwtWithJwks(validRsa, { audience: "wrong-aud" }),
    ).rejects.toThrow(JwtInvalidException);

    // 10. HTTP error and fetch timeout throw JwtInvalidException
    const failingJwks = new JwksClient({
      jwksUri: "https://down.example.com/.well-known/jwks.json",
      fetchFn: async () => new Response("Internal Error", { status: 500 }),
    });
    await expect(failingJwks.verifyJwtWithJwks(validRsa)).rejects.toThrow(
      JwtInvalidException,
    );

    const slowJwks = new JwksClient({
      jwksUri: "https://slow.example.com/.well-known/jwks.json",
      timeoutMs: 25,
      fetchFn: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    });
    await expect(slowJwks.verifyJwtWithJwks(validRsa)).rejects.toThrow(
      JwtInvalidException,
    );
  });

  it("integrates JwksModule.registerAsync with DI where JwksClient and JwksService share the same token", async () => {
    const ecKey = await generateSigningMaterial("ES256", "di-ec-1", false);
    const mod = await Test.createTestingModule({
      imports: [
        JwksModule.registerAsync({
          useFactory: async () => {
            await Promise.resolve();
            return {
              jwksUri: "https://di.example.com/.well-known/jwks.json",
              fetchFn: async () => jsonResponse({ keys: [ecKey.publicJwk] }),
            };
          },
        }),
      ],
    }).compile();

    const asClient = mod.get(JwksClient);
    const asService = mod.get(JwksService);
    expect(asClient).toBe(asService);

    const token = await signJwtWithMaterial(ecKey, {
      sub: "di-subject",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect(
      (await asService.verifyJwtWithJwks<{ sub: string }>(token)).sub,
    ).toBe("di-subject");

    await mod.close();
  });
});

describe("PKCE, Provider Presets & OAuth2Service / OAuth2Module", () => {
  it("generates and verifies RFC 7636 S256 PKCE pairs, state, and nonce", async () => {
    const pkce = await generatePkcePair();
    expect(pkce.codeChallengeMethod).toBe("S256");
    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.codeVerifier.length).toBeLessThanOrEqual(128);
    expect(pkce.codeChallenge).toBe(await computePkceChallenge(pkce.codeVerifier));
    expect(await verifyPkceChallenge(pkce.codeVerifier, pkce.codeChallenge)).toBe(
      true,
    );
    expect(
      await verifyPkceChallenge(`${pkce.codeVerifier}x`, pkce.codeChallenge),
    ).toBe(false);
    expect(await verifyPkceChallenge("too-short", pkce.codeChallenge)).toBe(false);

    const s1 = generateState();
    const s2 = generateState();
    const n1 = generateNonce();
    expect(s1.length).toBeGreaterThanOrEqual(43);
    expect(s1).not.toBe(s2);
    expect(n1.length).toBeGreaterThanOrEqual(43);
  });

  it("builds accurate endpoint presets for google, github, microsoft, okta, and auth0", () => {
    const google = OAuth2Providers.google({
      accessType: "offline",
      prompt: "consent",
      hostedDomain: "acme.dev",
    });
    expect(google.issuer).toBe("https://accounts.google.com");
    expect(google.authorizationUrl).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(google.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(google.extraAuthorizationParams).toEqual({
      access_type: "offline",
      prompt: "consent",
      hd: "acme.dev",
    });

    const gh = OAuth2Providers.github();
    expect(gh.authorizationUrl).toBe("https://github.com/login/oauth/authorize");
    expect(gh.userInfoUrl).toBe("https://api.github.com/user");
    const ghEnt = OAuth2Providers.github({ enterpriseDomain: "git.corp.internal" });
    expect(ghEnt.userInfoUrl).toBe("https://git.corp.internal/api/v3/user");

    const ms = OAuth2Providers.microsoft({ tenant: "contoso-tenant" });
    expect(ms.issuer).toBe(
      "https://login.microsoftonline.com/contoso-tenant/v2.0",
    );
    expect(ms.jwksUri).toBe(
      "https://login.microsoftonline.com/contoso-tenant/discovery/v2.0/keys",
    );

    const oktaDefault = OAuth2Providers.okta({ domain: "dev-123.okta.com" });
    expect(oktaDefault.issuer).toBe("https://dev-123.okta.com/oauth2/default");
    expect(oktaDefault.discoveryUrl).toBe(
      "https://dev-123.okta.com/oauth2/default/.well-known/openid-configuration",
    );
    const oktaOrg = OAuth2Providers.okta({
      domain: "https://dev-123.okta.com/",
      authorizationServerId: "",
    });
    expect(oktaOrg.issuer).toBe("https://dev-123.okta.com");
    expect(oktaOrg.tokenUrl).toBe("https://dev-123.okta.com/oauth2/v1/token");

    const auth0 = OAuth2Providers.auth0({
      domain: "tenant.us.auth0.com",
      audience: "https://api.myapp.dev",
    });
    expect(auth0.issuer).toBe("https://tenant.us.auth0.com/");
    expect(auth0.jwksUri).toBe(
      "https://tenant.us.auth0.com/.well-known/jwks.json",
    );
    expect(auth0.extraAuthorizationParams).toEqual({
      audience: "https://api.myapp.dev",
    });
  });

  it("handles authorization URLs, code exchange (POST & Basic), refresh tokens, UserInfo, and error responses", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: FetchLike = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });

      if (url === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.get("code") === "bad-code") {
          return jsonResponse(
            { error: "invalid_grant", error_description: "Code expired" },
            400,
          );
        }
        if (body.get("grant_type") === "authorization_code") {
          return jsonResponse({
            access_token: "at_123",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "rt_456",
            scope: "openid email",
          });
        }
        if (body.get("grant_type") === "refresh_token") {
          return jsonResponse({
            access_token: "at_refreshed",
            token_type: "Bearer",
            expires_in: 1800,
          });
        }
      }

      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth !== "Bearer at_123") {
          return new Response("Unauthorized", { status: 401 });
        }
        return jsonResponse({
          sub: "google-sub-1",
          email: "dev@bunest.dev",
          name: "Bunest Dev",
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    const mod = await Test.createTestingModule({
      imports: [
        OAuth2Module.registerAsync({
          useFactory: () => ({
            ...OAuth2Providers.google({ accessType: "offline" }),
            clientId: "client-id-1",
            clientSecret: "client-secret-1",
            redirectUri: "https://app.example.com/callback",
            clientAuthMethod: "client_secret_basic",
            fetchFn,
          }),
        }),
      ],
    }).compile();

    const oauth2 = mod.get(OAuth2Service);

    // 1. Authorization URL includes PKCE S256, state, scopes, and extra params
    const authUrl = await oauth2.buildAuthorizationUrl({
      extraParams: { prompt: "select_account" },
    });
    const parsedUrl = new URL(authUrl.url);
    expect(parsedUrl.searchParams.get("client_id")).toBe("client-id-1");
    expect(parsedUrl.searchParams.get("response_type")).toBe("code");
    expect(parsedUrl.searchParams.get("state")).toBe(authUrl.state);
    expect(parsedUrl.searchParams.get("code_challenge")).toBe(
      authUrl.codeChallenge!,
    );
    expect(parsedUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsedUrl.searchParams.get("access_type")).toBe("offline");
    expect(parsedUrl.searchParams.get("prompt")).toBe("select_account");
    expect(
      await verifyPkceChallenge(authUrl.codeVerifier!, authUrl.codeChallenge!),
    ).toBe(true);

    // 2. Exchange authorization code using Basic auth + PKCE code_verifier
    const tokens = await oauth2.exchangeAuthorizationCode({
      code: "auth-code-xyz",
      codeVerifier: authUrl.codeVerifier,
    });
    expect(tokens.accessToken).toBe("at_123");
    expect(tokens.refreshToken).toBe("rt_456");
    expect(tokens.expiresIn).toBe(3600);

    const tokenReq = requests[0]!;
    const sentAuth = new Headers(tokenReq.init?.headers).get("authorization");
    expect(sentAuth).toBe(
      `Basic ${Buffer.from("client-id-1:client-secret-1").toString("base64")}`,
    );
    const sentBody = new URLSearchParams(String(tokenReq.init?.body));
    expect(sentBody.get("code_verifier")).toBe(authUrl.codeVerifier!);
    expect(sentBody.get("redirect_uri")).toBe("https://app.example.com/callback");

    // 3. Invalid code throws OAuth2Exception with oauthError
    await expect(
      oauth2.exchangeAuthorizationCode({ code: "bad-code" }),
    ).rejects.toThrow(OAuth2Exception);

    // 4. Refresh token
    const refreshed = await oauth2.refreshAccessToken("rt_456");
    expect(refreshed.accessToken).toBe("at_refreshed");

    // 5. Fetch UserInfo
    const userInfo = await oauth2.fetchUserInfo("at_123");
    expect(userInfo.email).toBe("dev@bunest.dev");
    expect(userInfo.sub).toBe("google-sub-1");

    // 6. GitHub-style form-urlencoded token response & HTTP 200 error payload
    const ghService = new OAuth2Service({
      ...OAuth2Providers.github(),
      clientId: "gh-client",
      clientSecret: "gh-secret",
      fetchFn: async (_input, init) => {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.get("code") === "expired") {
          return new Response(
            JSON.stringify({
              error: "bad_verification_code",
              error_description: "The code passed is incorrect or expired.",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          "access_token=gho_form_token&scope=read%3Auser&token_type=bearer",
          {
            status: 200,
            headers: { "content-type": "application/x-www-form-urlencoded" },
          },
        );
      },
    });
    const ghToken = await ghService.exchangeAuthorizationCode({
      code: "gh-ok-code",
    });
    expect(ghToken.accessToken).toBe("gho_form_token");
    expect(ghToken.scope).toBe("read:user");
    await expect(
      ghService.exchangeAuthorizationCode({ code: "expired" }),
    ).rejects.toThrow(OAuth2Exception);

    await mod.close();
  });
});

describe("OidcService & OidcModule (Discovery + PKCE + ID Token Verification)", () => {
  it("performs full OIDC discovery, PKCE S256 + nonce auth URL, code exchange, and cryptographic ID token verification", async () => {
    const idpIssuer = "https://idp.bunest.dev";
    const clientId = "bunest-web-client";
    const signingKey = await generateSigningMaterial("RS256", "oidc-rsa-1");

    let discoveryFetches = 0;
    let jwksFetches = 0;
    let nextIdTokenClaims: Record<string, unknown> | null = null;
    let lastCodeChallenge: string | undefined;

    const nowSec = Math.floor(Date.now() / 1000);

    const fetchFn: FetchLike = async (input, init) => {
      const url = String(input);

      if (url === `${idpIssuer}/.well-known/openid-configuration`) {
        discoveryFetches++;
        return jsonResponse({
          issuer: idpIssuer,
          authorization_endpoint: `${idpIssuer}/oauth/authorize`,
          token_endpoint: `${idpIssuer}/oauth/token`,
          userinfo_endpoint: `${idpIssuer}/oauth/userinfo`,
          jwks_uri: `${idpIssuer}/.well-known/jwks.json`,
        });
      }

      if (url === `${idpIssuer}/.well-known/jwks.json`) {
        jwksFetches++;
        return jsonResponse({ keys: [signingKey.publicJwk] });
      }

      if (url === `${idpIssuer}/oauth/token`) {
        const body = new URLSearchParams(String(init?.body ?? ""));
        const verifier = body.get("code_verifier");
        if (lastCodeChallenge) {
          if (!verifier || !(await verifyPkceChallenge(verifier, lastCodeChallenge))) {
            return jsonResponse({ error: "invalid_grant" }, 400);
          }
        }
        const idToken = await signJwtWithMaterial(
          signingKey,
          nextIdTokenClaims ?? {
            iss: idpIssuer,
            sub: "oidc-user-42",
            aud: clientId,
            iat: nowSec,
            exp: nowSec + 600,
            email: "alice@bunest.dev",
          },
        );
        return jsonResponse({
          access_token: "oidc_access_token",
          token_type: "Bearer",
          expires_in: 600,
          id_token: idToken,
        });
      }

      if (url === `${idpIssuer}/oauth/userinfo`) {
        return jsonResponse({
          sub: "oidc-user-42",
          email: "alice@bunest.dev",
          name: "Alice",
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    const mod = await Test.createTestingModule({
      imports: [
        OidcModule.registerAsync({
          useFactory: () => ({
            issuer: idpIssuer,
            clientId,
            clientSecret: "top-secret",
            redirectUri: "https://app.bunest.dev/auth/callback",
            fetchFn,
          }),
        }),
      ],
    }).compile();

    const oidc = mod.get(OidcService);

    // 1. Discover & cache
    const doc = await oidc.discover();
    expect(doc.issuer).toBe(idpIssuer);
    await oidc.discover();
    expect(discoveryFetches).toBe(1);

    // 2. Build authorization URL with PKCE S256 + nonce + openid scope
    const authReq = await oidc.buildAuthorizationUrl({
      scopes: ["email", "profile"],
    });
    const authUrl = new URL(authReq.url);
    expect(authUrl.origin + authUrl.pathname).toBe(
      `${idpIssuer}/oauth/authorize`,
    );
    expect(authUrl.searchParams.get("scope")).toContain("openid");
    expect(authUrl.searchParams.get("nonce")).toBe(authReq.nonce);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    lastCodeChallenge = authReq.codeChallenge;

    // 3. Exchange code & verify valid ID token (including multi-aud + matching azp + matching nonce)
    nextIdTokenClaims = {
      iss: idpIssuer,
      sub: "oidc-user-42",
      aud: [clientId, "secondary-service"],
      azp: clientId,
      nonce: authReq.nonce,
      iat: nowSec,
      exp: nowSec + 600,
      email: "alice@bunest.dev",
    };

    const result = await oidc.exchangeCodeAndVerifyIdToken({
      code: "valid-code",
      codeVerifier: authReq.codeVerifier,
      expectedNonce: authReq.nonce,
    });
    expect(result.claims.sub).toBe("oidc-user-42");
    expect(result.claims.email).toBe("alice@bunest.dev");
    expect(result.claims.nonce).toBe(authReq.nonce);
    expect(jwksFetches).toBe(1);

    // UserInfo works via discovered userinfo_endpoint
    const profile = await oidc.fetchUserInfo(result.tokens.accessToken);
    expect(profile.name).toBe("Alice");

    // 4. Reject expired ID token
    const expiredIdToken = await signJwtWithMaterial(signingKey, {
      iss: idpIssuer,
      sub: "oidc-user-42",
      aud: clientId,
      iat: nowSec - 120,
      exp: nowSec - 10,
      nonce: authReq.nonce,
    });
    await expect(
      oidc.verifyIdToken(expiredIdToken, { expectedNonce: authReq.nonce }),
    ).rejects.toThrow(JwtExpiredException);

    // 5. Reject wrong issuer
    const wrongIssToken = await signJwtWithMaterial(signingKey, {
      iss: "https://evil-idp.attacker.com",
      sub: "oidc-user-42",
      aud: clientId,
      iat: nowSec,
      exp: nowSec + 300,
      nonce: authReq.nonce,
    });
    await expect(
      oidc.verifyIdToken(wrongIssToken, { expectedNonce: authReq.nonce }),
    ).rejects.toThrow(JwtInvalidException);

    // 6. Reject wrong audience
    const wrongAudToken = await signJwtWithMaterial(signingKey, {
      iss: idpIssuer,
      sub: "oidc-user-42",
      aud: "other-client-id",
      iat: nowSec,
      exp: nowSec + 300,
      nonce: authReq.nonce,
    });
    await expect(
      oidc.verifyIdToken(wrongAudToken, { expectedNonce: authReq.nonce }),
    ).rejects.toThrow(JwtInvalidException);

    // 7. Reject wrong nonce
    const wrongNonceToken = await signJwtWithMaterial(signingKey, {
      iss: idpIssuer,
      sub: "oidc-user-42",
      aud: clientId,
      iat: nowSec,
      exp: nowSec + 300,
      nonce: "tampered-nonce",
    });
    await expect(
      oidc.verifyIdToken(wrongNonceToken, { expectedNonce: authReq.nonce }),
    ).rejects.toThrow(JwtInvalidException);

    // 8. Reject multi-audience ID token missing azp or with wrong azp
    const missingAzpToken = await signJwtWithMaterial(signingKey, {
      iss: idpIssuer,
      sub: "oidc-user-42",
      aud: [clientId, "another-aud"],
      iat: nowSec,
      exp: nowSec + 300,
    });
    await expect(oidc.verifyIdToken(missingAzpToken)).rejects.toThrow(
      JwtInvalidException,
    );

    const wrongAzpToken = await signJwtWithMaterial(signingKey, {
      iss: idpIssuer,
      sub: "oidc-user-42",
      aud: [clientId, "another-aud"],
      azp: "another-aud",
      iat: nowSec,
      exp: nowSec + 300,
    });
    await expect(oidc.verifyIdToken(wrongAzpToken)).rejects.toThrow(
      JwtInvalidException,
    );

    // 9. Reject future nbf ID token and stale auth_time exceeding maxAge
    const futureNbfIdToken = await signJwtWithMaterial(signingKey, {
      iss: idpIssuer,
      sub: "oidc-user-42",
      aud: clientId,
      iat: nowSec,
      nbf: nowSec + 120,
      exp: nowSec + 600,
    });
    await expect(oidc.verifyIdToken(futureNbfIdToken)).rejects.toThrow(
      JwtNotBeforeException,
    );

    const staleAuthTimeToken = await signJwtWithMaterial(signingKey, {
      iss: idpIssuer,
      sub: "oidc-user-42",
      aud: clientId,
      iat: nowSec,
      exp: nowSec + 600,
      auth_time: nowSec - 600,
    });
    await expect(
      oidc.verifyIdToken(staleAuthTimeToken, { maxAge: 60 }),
    ).rejects.toThrow(JwtInvalidException);

    await mod.close();
  });

  it("rejects OIDC discovery documents whose issuer does not strictly match configured issuer", async () => {
    const oidc = new OidcService({
      issuer: "https://trusted-idp.example.com",
      clientId: "client-1",
      fetchFn: async () =>
        jsonResponse({
          issuer: "https://spoofed-idp.example.com",
          authorization_endpoint: "https://spoofed-idp.example.com/auth",
          token_endpoint: "https://spoofed-idp.example.com/token",
          jwks_uri: "https://spoofed-idp.example.com/jwks",
        }),
    });

    await expect(oidc.discover()).rejects.toThrow(OAuth2Exception);
  });
});
