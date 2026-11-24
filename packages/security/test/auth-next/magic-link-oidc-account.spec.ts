import { describe, expect, it } from "bun:test";
import {
  AuthenticationEvents,
  AuthenticationRegistry,
  AuthenticationStorage,
  EmailVerificationHandler,
  EmailVerificationService,
  JwtSigner,
  MagicLinkError,
  MagicLinkHandler,
  MagicLinkService,
  MfaService,
  OidcAccountResolver,
  OidcService,
  PasswordHasher,
  PasswordResetHandler,
  PasswordResetService,
  SessionService,
  SignInService,
  TokenService,
  github,
  google,
  microsoft,
  type OAuthTokens,
  type OidcProfile,
  type OidcResolveContext,
} from "../../src/auth-next/index";

const T0 = 1_700_000_000_000;
const SECRET = "test-secret-for-oidc-and-account-flows-32b!";

describe("MagicLinkService, OidcService, EmailVerificationService & PasswordResetService", () => {
  it("MagicLinkService binds links to requesting browser, allows 5 pending links, and rejects unsafe redirectTo", async () => {
    let clock = T0;
    const storage = new AuthenticationStorage();
    const events = new AuthenticationEvents();
    const sent: Array<{ email: string; url: string }> = [];
    const options = {
      magicLink: {
        url: "https://app.test/magic",
        ttl: "15m" as const,
        now: () => clock,
      },
      session: { now: () => clock },
    };
    const registry = new AuthenticationRegistry(options);
    registry.registerHandler(
      "magicLink",
      new (class extends MagicLinkHandler {
        send(link: { email: string; url: string }) {
          sent.push(link);
        }
        resolveUser(email: string) {
          return email === "ada@example.com"
            ? { id: "u-ada", email: "Ada@Example.com" }
            : null;
        }
      })(),
    );
    const sessions = new SessionService(storage, options, events);
    const mfa = new MfaService(storage, options, events);
    const tokens = new TokenService(storage, options, events, mfa);
    const signIn = new SignInService(
      sessions,
      mfa,
      tokens,
      undefined,
      undefined,
      events,
    );
    const magic = new MagicLinkService(
      storage,
      registry,
      signIn,
      options,
      undefined,
      undefined,
      events,
    );

    // Invalid email creates nothing silently
    await magic.create("not-an-email");
    expect(sent.length).toBe(0);

    // Create bound link with unsafe external redirectTo -> stripped
    const created = await magic.create("  ADA@EXAMPLE.COM ", {
      redirectTo: "https://evil.test/phish",
    });
    expect(created.cookie).toContain("__Host-magic_link_tx=");
    expect(sent.length).toBe(1);
    const token = new URL(sent[0]!.url).searchParams.get("token")!;

    // Different browser (no cookie) throws MagicLinkError WITHOUT burning link
    await expect(
      magic.consume(token, { request: { headers: {} } }),
    ).rejects.toBeInstanceOf(MagicLinkError);

    // Same browser (with cookie) consumes and signs in
    const cookiePair = created.cookie!.split(";")[0]!;
    const consumed = await magic.consume(token, {
      request: { headers: { cookie: cookiePair } },
    });
    expect(consumed).not.toBeNull();
    expect(consumed!.session.userId).toBe("u-ada");
    expect(consumed!.redirectTo).toBeUndefined();

    // Single-use: second consume in same browser returns null (unknown)
    expect(
      await magic.consume(token, {
        request: { headers: { cookie: cookiePair } },
      }),
    ).toBeNull();
  });

  it("OidcService completes OIDC authorization code + PKCE + nonce + RFC 9207 iss + JWKS + linking flow", async () => {
    const rsa = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const jwk = {
      ...(await crypto.subtle.exportKey("jwk", rsa.publicKey)),
      kid: "idp-1",
      use: "sig",
      alg: "RS256",
    };
    const issuer = "https://idp.example";
    const clientId = "client-123";
    const idTokenSigner = new JwtSigner({
      key: rsa.privateKey,
      alg: "RS256",
      kid: "idp-1",
      issuer,
      audience: clientId,
      now: () => T0,
    });

    let lastNonce = "";
    const fakeFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return new Response(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            userinfo_endpoint: `${issuer}/userinfo`,
            jwks_uri: `${issuer}/jwks.json`,
            authorization_response_iss_parameter_supported: true,
          }),
          { status: 200 },
        );
      }
      if (url === `${issuer}/jwks.json`) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      if (url === `${issuer}/token`) {
        const body = init?.body?.toString() ?? "";
        expect(body).toContain("code_verifier=");
        return new Response(
          JSON.stringify({
            access_token: "at-xyz",
            token_type: "Bearer",
            id_token: await idTokenSigner.sign({
              sub: "oidc-sub-42",
              nonce: lastNonce,
              email: "grace@example.com",
              email_verified: true,
              name: "Grace Hopper",
            }),
          }),
          { status: 200 },
        );
      }
      if (url === `${issuer}/userinfo`) {
        return new Response(
          JSON.stringify({
            sub: "oidc-sub-42",
            email: "grace@example.com",
            email_verified: true,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    expect(() =>
      microsoft({
        clientId: "ms-id",
        clientSecret: "ms-sec",
        tenant: "common",
      }),
    ).toThrow("tenant id, a GUID");

    const storage = new AuthenticationStorage();
    const events = new AuthenticationEvents();
    const linkedCalls: Array<{ subject: string; linkTo?: string }> = [];

    const options = {
      session: { now: () => T0 },
      oidc: {
        callbackUrl: "https://app.test/auth/oidc/:provider/callback",
        redirectAfterLogin: "/dashboard",
        now: () => T0,
        fetch: fakeFetch,
        providers: {
          corp: {
            issuer,
            clientId,
            clientSecret: "top-secret",
          },
          google: google({ clientId: "g-id", clientSecret: "g-sec" }),
          github: github({ clientId: "gh-id", clientSecret: "gh-sec" }),
          microsoft: microsoft({
            clientId: "ms-id",
            clientSecret: "ms-sec",
            tenant: "11111111-2222-3333-4444-555555555555",
          }),
        },
      },
    };
    const registry = new AuthenticationRegistry(options);
    registry.registerHandler(
      "oidc",
      new (class extends OidcAccountResolver {
        resolveUser(
          profile: OidcProfile,
          _tokens: OAuthTokens,
          ctx: OidcResolveContext,
        ) {
          linkedCalls.push({
            subject: profile.subject,
            linkTo: ctx.linkTo?.id,
          });
          if (ctx.linkTo) return { id: ctx.linkTo.id };
          return { id: "u-grace" };
        }
      })(),
    );

    const sessions = new SessionService(storage, options, events);
    const mfa = new MfaService(storage, options, events);
    const tokens = new TokenService(storage, options, events, mfa);
    const signIn = new SignInService(
      sessions,
      mfa,
      tokens,
      undefined,
      undefined,
      events,
    );
    const oidc = new OidcService(storage, registry, signIn, sessions, options);

    // 1. Start login
    const started = await oidc.start("corp", { redirectTo: "/settings" });
    const authUrl = new URL(started.url);
    expect(authUrl.origin + authUrl.pathname).toBe(`${issuer}/authorize`);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    lastNonce = authUrl.searchParams.get("nonce")!;
    const state = authUrl.searchParams.get("state")!;
    const txCookie = started.cookies[0]!.split(";")[0]!;

    // 2. Missing iss (RFC 9207) when supported -> BadRequestException
    await expect(
      oidc.finish(
        "corp",
        { code: "code-1", state },
        { request: { headers: { cookie: txCookie } } },
      ),
    ).rejects.toThrow("missing iss");

    // 3. Full valid finish (start fresh because consume burned state)
    const started2 = await oidc.start("corp", { redirectTo: "/settings" });
    const authUrl2 = new URL(started2.url);
    lastNonce = authUrl2.searchParams.get("nonce")!;
    const state2 = authUrl2.searchParams.get("state")!;
    const txCookie2 = started2.cookies[0]!.split(";")[0]!;

    const finished = await oidc.finish(
      "corp",
      { code: "code-2", state: state2, iss: issuer },
      { request: { headers: { cookie: txCookie2 } } },
    );
    expect(finished.url).toBe("/settings");
    expect(finished.cookies.length).toBe(2);
    expect(finished.cookies[0]).toContain("__Host-sid=");

    // 4. Link flow requires live session and rejects cross-site Sec-Fetch-Site
    await expect(
      oidc.start("corp", {
        link: true,
        request: { headers: { "sec-fetch-site": "cross-site" } },
      }),
    ).rejects.toThrow("Cross-site link refused");

    const sessionCookie = finished.cookies[0]!.split(";")[0]!;
    const linkStart = await oidc.start("corp", {
      link: true,
      request: { headers: { cookie: sessionCookie } },
    });
    const linkUrl = new URL(linkStart.url);
    lastNonce = linkUrl.searchParams.get("nonce")!;
    const linkFinish = await oidc.finish(
      "corp",
      {
        code: "code-link",
        state: linkUrl.searchParams.get("state")!,
        iss: issuer,
      },
      {
        request: {
          headers: {
            cookie: `${sessionCookie}; ${linkStart.cookies[0]!.split(";")[0]!}`,
          },
        },
      },
    );
    expect(linkFinish.url).toBe("/dashboard");
    expect(linkedCalls.at(-1)).toEqual({
      subject: "oidc-sub-42",
      linkTo: "u-grace",
    });
  });

  it("EmailVerificationService & PasswordResetService enforce token binding, fingerprint, and session revocation", async () => {
    const storage = new AuthenticationStorage();
    const events = new AuthenticationEvents();
    const hasher = new PasswordHasher({ logN: 10 });
    const account = {
      id: "u-reset",
      email: "User@Example.com",
      passwordHash: await hasher.hash("initial-pw"),
      verified: false,
    };
    const sentUrls: string[] = [];
    let failVerifyOnce = true;

    const options = {
      accessToken: { key: SECRET },
      emailVerification: { url: "https://app.test/verify" },
      passwordReset: { url: "https://app.test/reset" },
    };
    const registry = new AuthenticationRegistry(options);
    registry.registerHandler(
      "emailVerification",
      new (class extends EmailVerificationHandler {
        send(link: { url: string }) {
          sentUrls.push(link.url);
        }
        markVerified(userId: string, email: string) {
          if (failVerifyOnce) {
            failVerifyOnce = false;
            throw new Error("temporary db outage");
          }
          if (userId === account.id && email === account.email) {
            account.verified = true;
            return true;
          }
          return false;
        }
      })(),
    );
    registry.registerHandler(
      "passwordReset",
      new (class extends PasswordResetHandler {
        findUser(email: string) {
          return email === account.email.toLowerCase()
            ? {
                id: account.id,
                email: account.email,
                passwordHash: account.passwordHash,
              }
            : null;
        }
        send(link: { url: string }) {
          sentUrls.push(link.url);
        }
        updatePassword(_userId: string, hash: string) {
          account.passwordHash = hash;
        }
      })(),
    );

    const sessions = new SessionService(storage, options, events);
    const mfa = new MfaService(storage, options, events);
    const tokens = new TokenService(storage, options, events, mfa);
    const signIn = new SignInService(
      sessions,
      mfa,
      tokens,
      undefined,
      undefined,
      events,
    );
    const emailSvc = new EmailVerificationService(
      storage,
      registry,
      options,
      events,
    );
    const resetSvc = new PasswordResetService(
      storage,
      registry,
      hasher,
      sessions,
      tokens,
      signIn,
      options,
      events,
    );

    // Email verification gives link back on transient handler error
    await emailSvc.send(account);
    const verifyTok = new URL(sentUrls.at(-1)!).searchParams.get("token")!;
    await expect(emailSvc.verify(verifyTok)).rejects.toThrow(
      "temporary db outage",
    );
    expect(await emailSvc.verify(verifyTok)).toEqual({
      userId: account.id,
      email: account.email,
    });
    expect(account.verified).toBe(true);

    // Create active session + refresh token before password reset
    const sess = await sessions.create(account.id);
    const tokPair = await tokens.issue(account.id);

    // Request two reset links; using one invalidates the other AND revokes sessions + tokens
    resetSvc.request(account.email);
    resetSvc.request(account.email);
    await resetSvc.onModuleDestroy();
    const resetTok1 = new URL(sentUrls.at(-2)!).searchParams.get("token")!;
    const resetTok2 = new URL(sentUrls.at(-1)!).searchParams.get("token")!;

    const res = await resetSvc.reset(resetTok1, "brand-new-pw", {
      signIn: true,
    });
    expect(res?.userId).toBe(account.id);
    expect(res?.signedIn?.session.userId).toBe(account.id);
    expect(await hasher.verify("brand-new-pw", account.passwordHash)).toBe(
      true,
    );
    // Old session & refresh token revoked!
    expect(await sessions.validate(sess.token)).toBeNull();
    await expect(tokens.refresh(tokPair.refreshToken)).rejects.toThrow();
    // Second reset link invalidated (both deleted & password fingerprint changed)
    expect(await resetSvc.reset(resetTok2, "another-pw")).toBeNull();
  });
});
