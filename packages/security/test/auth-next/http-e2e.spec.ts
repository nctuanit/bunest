import { describe, expect, it } from "bun:test";
import {
  Body,
  Controller,
  Get,
  Injectable,
  Post,
  subscribe,
  unsubscribe,
} from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  ApiKeyProvider,
  Authenticate,
  AuthenticationContext,
  AuthenticationError,
  AuthenticationEvents,
  AuthenticationModule,
  AuthenticationRegistry,
  AuthenticationStorage,
  CurrentSession,
  CurrentUser,
  JwtBearerProvider,
  MfaService,
  Public,
  SessionCookieProvider,
  SignInService,
  TokenService,
  WsAuthenticator,
  type ApiKeyRecord,
  type ApiKeySession,
  type AuthenticationEvent,
  type JwtClaims,
  type SessionRecord,
} from "../../src/auth-next/index";
import { base32Decode, hotp } from "../../src/auth-next/mfa/otp.util";

interface DemoUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

const USERS = new Map<string, DemoUser>([
  ["u1", { id: "u1", email: "ada@example.com", emailVerified: true }],
  ["u2", { id: "u2", email: "bob@example.com", emailVerified: false }],
]);

const ACCESS_SECRET = "e2e-access-token-signing-secret-32b!";
const MFA_KEY = "e2e-mfa-encryption-secret-32-bytes!!";
const API_KEYS = new Map<string, ApiKeyRecord<DemoUser>>();

function getHeader(
  headers: Record<string, string | string[]>,
  name: string,
): string | undefined {
  const val = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(val) ? val[0] : val;
}

@Injectable()
class SessionAuth extends SessionCookieProvider<DemoUser> {
  constructor(registry: AuthenticationRegistry) {
    super();
    registry.registerProvider(this, { order: 0 });
  }
  validate(session: SessionRecord) {
    return USERS.get(session.userId) ?? null;
  }
}

@Injectable()
class JwtAuth extends JwtBearerProvider<DemoUser> {
  constructor(registry: AuthenticationRegistry) {
    super({ realm: "bunest" });
    registry.registerProvider(this, { order: 1 });
  }
  validate(claims: JwtClaims) {
    return claims.sub ? (USERS.get(claims.sub) ?? null) : null;
  }
}

@Injectable()
class KeyAuth extends ApiKeyProvider<DemoUser> {
  constructor(registry: AuthenticationRegistry) {
    super({ prefix: "bk", realm: "bunest" });
    registry.registerProvider(this, { order: 2 });
  }
  protected findKey(id: string) {
    return API_KEYS.get(id) ?? null;
  }
}

@Controller("auth")
class AuthController {
  constructor(
    private readonly signIn: SignInService,
    private readonly tokens: TokenService,
    private readonly ctx: AuthenticationContext,
  ) {}

  @Public()
  @Post("login")
  async login(@Body() body: { userId: string }) {
    const issued = await this.signIn.signIn(body.userId, {
      method: "password",
    });
    return { mfa: issued.session.mfa ?? "none", sessionId: issued.session.id };
  }

  @Public()
  @Post("mfa/complete")
  async completeMfa(@Body() body: { code: string }) {
    const res = await this.signIn.completeMfa({ code: body.code });
    if (!res) {
      throw new AuthenticationError("Invalid MFA code", {
        code: "mfa_invalid",
      });
    }
    return { mfa: res.session.mfa, sessionId: res.session.id };
  }

  @Public()
  @Post("logout")
  async logout() {
    return { signedOut: await this.signIn.signOut() };
  }

  @Public()
  @Post("token")
  async issueToken(@Body() body: { userId: string }) {
    return this.tokens.issue(body.userId, { method: "password" });
  }

  @Get("me")
  me(
    @CurrentUser() user: DemoUser,
    @CurrentUser("email") email: string,
    @CurrentSession() session: SessionRecord | JwtClaims | ApiKeySession,
  ) {
    const reqUser = this.ctx.requireUser() as unknown as DemoUser;
    return {
      id: user.id,
      email,
      ctxUserId: reqUser.id,
      hasSession: session !== null,
    };
  }

  @Authenticate({ optional: true })
  @Get("optional")
  optional(@CurrentUser() user: DemoUser | null) {
    return { user: user?.id ?? null };
  }

  @Authenticate({ verifiedEmail: true })
  @Get("verified-only")
  verifiedOnly(@CurrentUser() user: DemoUser) {
    return { ok: true, id: user.id };
  }

  @Authenticate({ mfa: true })
  @Get("step-up")
  stepUp(@CurrentUser() user: DemoUser) {
    return { stepUp: true, id: user.id };
  }

  @Authenticate({ providers: [KeyAuth] })
  @Get("api-key-only")
  apiKeyOnly(@CurrentUser() user: DemoUser) {
    return { keyUser: user.id };
  }

  @Post("rotate")
  async rotate() {
    const rotated = await this.signIn.rotateSession();
    return { sessionId: rotated?.session.id ?? null };
  }

  @Post("logout-all")
  async logoutAll(@CurrentUser() user: DemoUser) {
    await this.signIn.signOutEverywhere(user.id);
    return { ok: true };
  }
}

describe("@bunest/authentication HTTP E2E & startup checks", () => {
  it("enforces sessions, MFA step-up, JWT bearer, API keys, @Public, @Authenticate, CSRF, events, and WsAuthenticator", async () => {
    const diagEvents: unknown[] = [];
    const onDiag = (msg: unknown) => diagEvents.push(msg);
    subscribe("nestjs:authentication:sign-in", onDiag);

    const modRef = await Test.createTestingModule({
      imports: [
        AuthenticationModule.forRoot({
          accessToken: {
            key: ACCESS_SECRET,
            issuer: "bunest",
            audience: "web",
          },
          session: { cookie: { secure: false } },
          mfa: { encryption: { keys: [MFA_KEY] } },
        }),
      ],
      controllers: [AuthController],
      providers: [SessionAuth, JwtAuth, KeyAuth],
    }).compile();

    const app = modRef.createBunestApplication();
    await app.init();

    const keyAuth = app.get(KeyAuth);
    const generated = keyAuth.generate();
    API_KEYS.set(generated.id, {
      hash: generated.hash,
      user: USERS.get("u1")!,
    });

    const events = app.get(AuthenticationEvents);
    const streamEvents: AuthenticationEvent[] = [];
    const sub = events.events$.subscribe((e) => streamEvents.push(e));
    const asyncCollected: AuthenticationEvent[] = [];
    const iterator = events.events$[Symbol.asyncIterator]();
    const firstAsyncEvent = iterator.next().then((r) => {
      if (!r.done) asyncCollected.push(r.value);
    });

    try {
      // 1. Unauthenticated request -> 401 + WWW-Authenticate
      const unauth = await app.inject({ method: "GET", url: "/auth/me" });
      expect(unauth.statusCode).toBe(401);
      expect(getHeader(unauth.headers, "www-authenticate")).toContain(
        'Bearer realm="bunest"',
      );

      // 2. Optional route -> 200 with user: null
      const optAnon = await app.inject({
        method: "GET",
        url: "/auth/optional",
      });
      expect(optAnon.statusCode).toBe(200);
      expect(optAnon.json()).toEqual({ user: null });

      // 3. Cross-origin login POST refused with 403
      const csrf = await app.inject({
        method: "POST",
        url: "/auth/login",
        headers: {
          "sec-fetch-site": "cross-site",
          origin: "https://evil.example",
        },
        payload: { userId: "u1" },
      });
      expect(csrf.statusCode).toBe(403);

      // 4. Browser session login -> sets HttpOnly cookie, accesses /auth/me & /auth/verified-only
      const login = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { userId: "u1" },
      });
      expect(login.statusCode).toBe(201);
      const setCookie = getHeader(login.headers, "set-cookie")!;
      expect(setCookie).toContain("sid=");
      expect(setCookie).toContain("HttpOnly");
      const cookiePair = setCookie.split(";")[0]!;

      await firstAsyncEvent;
      expect(asyncCollected.length).toBe(1);
      expect(asyncCollected[0]!.type).toBe("sign-in");
      expect(diagEvents.length).toBeGreaterThanOrEqual(1);

      const me = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { cookie: cookiePair },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toEqual({
        id: "u1",
        email: "ada@example.com",
        ctxUserId: "u1",
        hasSession: true,
      });

      // Verified email check passes for u1
      const verified = await app.inject({
        method: "GET",
        url: "/auth/verified-only",
        headers: { cookie: cookiePair },
      });
      expect(verified.statusCode).toBe(200);

      // Step-up MFA route rejects session without MFA (401 mfa_required)
      const noMfa = await app.inject({
        method: "GET",
        url: "/auth/step-up",
        headers: { cookie: cookiePair },
      });
      expect(noMfa.statusCode).toBe(401);

      // Provider-restricted route (@Authenticate({ providers: [KeyAuth] })) rejects cookie session
      const wrongProv = await app.inject({
        method: "GET",
        url: "/auth/api-key-only",
        headers: { cookie: cookiePair },
      });
      expect(wrongProv.statusCode).toBe(401);

      // API Key succeeds on api-key-only route
      const withKey = await app.inject({
        method: "GET",
        url: "/auth/api-key-only",
        headers: { authorization: `Bearer ${generated.key}` },
      });
      expect(withKey.statusCode).toBe(200);
      expect(withKey.json()).toEqual({ keyUser: "u1" });

      // Invalid API key gets 401 with challenge
      const badKey = await app.inject({
        method: "GET",
        url: "/auth/api-key-only",
        headers: {
          authorization: `Bearer bk_${generated.id}_${"A".repeat(43)}`,
        },
      });
      expect(badKey.statusCode).toBe(401);
      expect(getHeader(badKey.headers, "www-authenticate")).toContain(
        "invalid_token",
      );

      // 5. JWT Bearer auth + unverified email (u2) -> 403 on verified-only
      const tokRes = await app.inject({
        method: "POST",
        url: "/auth/token",
        payload: { userId: "u2" },
      });
      expect(tokRes.statusCode).toBe(201);
      const { accessToken } = tokRes.json<{ accessToken: string }>();

      const meJwt = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(meJwt.statusCode).toBe(200);
      expect(meJwt.json<{ id: string }>().id).toBe("u2");

      const unverified = await app.inject({
        method: "GET",
        url: "/auth/verified-only",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(unverified.statusCode).toBe(403);

      // 6. Full MFA pending -> completeMfa -> step-up flow
      const mfaSvc = app.get(MfaService);
      const { secret } = await mfaSvc.enroll("u1", "ada@example.com");
      const nowStep = Math.floor(Date.now() / 30_000);
      const code0 = hotp(base32Decode(secret), nowStep - 1);
      expect(await mfaSvc.confirm("u1", code0)).toBe(true);

      const mfaLogin = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { userId: "u1" },
      });
      expect(mfaLogin.json<{ mfa: string }>().mfa).toBe("pending");
      const pendingCookie = getHeader(mfaLogin.headers, "set-cookie")!.split(
        ";",
      )[0]!;

      // Pending session is NOT signed in on /auth/me (401) and anonymous on /auth/optional
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/auth/me",
            headers: { cookie: pendingCookie },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/auth/optional",
            headers: { cookie: pendingCookie },
          })
        ).json(),
      ).toEqual({ user: null });

      // Complete MFA with next step code -> rotates cookie & allows /auth/step-up
      const code1 = hotp(base32Decode(secret), nowStep);
      const completed = await app.inject({
        method: "POST",
        url: "/auth/mfa/complete",
        headers: { cookie: pendingCookie },
        payload: { code: code1 },
      });
      expect(completed.statusCode).toBe(201);
      const verifiedCookie = getHeader(completed.headers, "set-cookie")!.split(
        ";",
      )[0]!;
      expect(verifiedCookie).not.toBe(pendingCookie);

      const stepUpRes = await app.inject({
        method: "GET",
        url: "/auth/step-up",
        headers: { cookie: verifiedCookie },
      });
      expect(stepUpRes.statusCode).toBe(200);
      expect(stepUpRes.json()).toEqual({ stepUp: true, id: "u1" });

      // Rotate session & sign out everywhere
      const rotated = await app.inject({
        method: "POST",
        url: "/auth/rotate",
        headers: { cookie: verifiedCookie },
      });
      expect(rotated.statusCode).toBe(201);
      const rotatedCookie = getHeader(rotated.headers, "set-cookie")!.split(
        ";",
      )[0]!;
      expect(rotatedCookie).not.toBe(verifiedCookie);

      const signOutAll = await app.inject({
        method: "POST",
        url: "/auth/logout-all",
        headers: { cookie: rotatedCookie },
      });
      expect(signOutAll.statusCode).toBe(201);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/auth/me",
            headers: { cookie: rotatedCookie },
          })
        ).statusCode,
      ).toBe(401);

      // 7. WsAuthenticator handshake test
      const wsAuth = app.get(WsAuthenticator);
      const closed: Array<{ code?: number; reason?: string }> = [];
      const wsClientGood: any = {
        close: (code?: number, reason?: string) =>
          closed.push({ code, reason }),
      };
      const wsRes = await wsAuth.authenticateConnection(wsClientGood, {
        headers: { authorization: `Bearer ${accessToken}` },
      } as any);
      expect((wsRes?.user as unknown as DemoUser | undefined)?.id).toBe("u2");
      expect(closed.length).toBe(0);

      const wsClientBad: any = {
        close: (code?: number, reason?: string) =>
          closed.push({ code, reason }),
      };
      const wsFail = await wsAuth.authenticateConnection(wsClientBad, {
        headers: {},
      } as any);
      expect(wsFail).toBeNull();
      expect(closed[0]).toEqual({ code: 1008, reason: "Unauthorized" });

      // 8. AuthenticationContext.run() outside HTTP
      const authCtx = app.get(AuthenticationContext);
      const runOut = authCtx.run(
        { user: { id: "job-user" } },
        () => (authCtx.requireUser() as unknown as { id: string }).id,
      );
      expect(runOut).toBe("job-user");
      expect(streamEvents.length).toBeGreaterThan(0);
    } finally {
      sub.unsubscribe();
      await iterator.return?.();
      unsubscribe("nestjs:authentication:sign-in", onDiag);
      await app.close();
    }
  });

  it("supports forRootAsync() and enforces startup & production in-memory storage guards", async () => {
    // Unknown option fails during compile/startup
    await expect(
      Test.createTestingModule({
        imports: [AuthenticationModule.forRoot({ unknownOption: true } as any)],
      }).compile(),
    ).rejects.toThrow("is not an option");

    // Production guard refuses in-memory storage unless allowInMemoryStorage: true
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const prodFail = await Test.createTestingModule({
        imports: [
          AuthenticationModule.forRootAsync({
            useFactory: () => ({
              accessToken: { key: ACCESS_SECRET },
            }),
          }),
        ],
      }).compile();
      const prodFailApp = prodFail.createBunestApplication();
      await expect(prodFailApp.init()).rejects.toThrow(
        'NODE_ENV is "production"',
      );

      // With allowInMemoryStorage: true it starts cleanly
      const prodOk = await Test.createTestingModule({
        imports: [
          AuthenticationModule.forRootAsync({
            useFactory: () => ({
              accessToken: { key: ACCESS_SECRET },
              allowInMemoryStorage: true,
            }),
          }),
        ],
      }).compile();
      const prodOkApp = prodOk.createBunestApplication();
      await prodOkApp.init();
      expect(prodOkApp.get(AuthenticationStorage)).toBeDefined();
      await prodOkApp.close();
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});
