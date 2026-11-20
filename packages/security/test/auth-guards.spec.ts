import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  APP_GUARD,
  Controller,
  Get,
  Injectable,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  type ExecutionContext,
  type ResponseContext,
} from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  CheckPolicies,
  CsrfGuard,
  CurrentUser,
  JWT_AUTH_GUARD_OPTIONS,
  JwtAuthGuard,
  JwtModule,
  JwtService,
  PasswordService,
  PoliciesGuard,
  Public,
  Roles,
  RolesGuard,
  SESSION_COOKIE_OPTIONS,
  SessionCookieService,
  type IPolicyHandler,
} from "../src";

describe("Auth Guards, PasswordService, SessionCookieService & CsrfGuard", () => {
  it("enforces JwtAuthGuard, @Public(), RolesGuard, PoliciesGuard, and @CurrentUser() end-to-end", async () => {
    @Injectable()
    class OwnerPolicy implements IPolicyHandler<{ sub: string; roles: string[] }> {
      handle(user: { sub: string; roles: string[] }, ctx: ExecutionContext) {
        const req = ctx.switchToHttp().getRequest<Request>();
        const pathId = new URL(req.url).pathname.split("/").pop();
        return user.sub === pathId || user.roles.includes("admin");
      }
    }

    @Controller("/secure")
    class SecureController {
      @Public()
      @Get("public")
      publicEndpoint() {
        return { open: true };
      }

      @Get("me")
      me(
        @CurrentUser() user: { sub: string; roles: string[] },
        @CurrentUser("sub") sub: string,
      ) {
        return { user, sub };
      }

      @Roles("admin")
      @Get("admin")
      adminOnly(@CurrentUser("sub") sub: string) {
        return { admin: sub };
      }

      @CheckPolicies(OwnerPolicy)
      @Get("profile/:id")
      profile(@Param("id") id: string, @CurrentUser("sub") sub: string) {
        return { profileId: id, viewer: sub };
      }

      @CheckPolicies((user: { verified?: boolean }) => Boolean(user?.verified))
      @Get("verified-only")
      verifiedOnly() {
        return { verified: true };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: "e2e-jwt-secret" })],
      controllers: [SecureController],
      providers: [
        OwnerPolicy,
        {
          provide: JWT_AUTH_GUARD_OPTIONS,
          useValue: { cookieName: "access_token" },
        },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: PoliciesGuard },
      ],
    }).compile();

    const client = moduleRef.createTestClient();
    const jwt = moduleRef.get(JwtService);

    const userToken = await jwt.sign({
      sub: "u_1",
      roles: ["member"],
      verified: false,
    });
    const adminToken = await jwt.sign({
      sub: "u_admin",
      roles: ["admin"],
      verified: true,
    });

    try {
      // 1. @Public() route works without token
      const pubRes = await client.get("/secure/public");
      expect(pubRes.status).toBe(200);
      expect(await pubRes.json()).toEqual({ open: true });

      // 2. Protected route without token -> 401
      expect((await client.get("/secure/me")).status).toBe(401);

      // 3. Bearer token works and populates @CurrentUser() & @CurrentUser("sub")
      const meRes = await client
        .withBearerToken(userToken)
        .get("/secure/me");
      expect(meRes.status).toBe(200);
      const meBody = await meRes.json<{ sub: string; user: { roles: string[] } }>();
      expect(meBody.sub).toBe("u_1");
      expect(meBody.user.roles).toEqual(["member"]);

      // 4. Cookie token fallback works when no Authorization header is sent
      const cookieRes = await client.get("/secure/me", {
        cookies: { access_token: userToken },
      });
      expect(cookieRes.status).toBe(200);
      expect((await cookieRes.json<{ sub: string }>()).sub).toBe("u_1");

      // 5. @Roles("admin") denies member (403) and allows admin (200)
      expect(
        (await client.withBearerToken(userToken).get("/secure/admin")).status,
      ).toBe(403);
      const adminRes = await client
        .withBearerToken(adminToken)
        .get("/secure/admin");
      expect(adminRes.status).toBe(200);
      expect(await adminRes.json()).toEqual({ admin: "u_admin" });

      // 6. @CheckPolicies(OwnerPolicy) allows self & admin, denies other user (403)
      expect(
        (await client.withBearerToken(userToken).get("/secure/profile/u_1"))
          .status,
      ).toBe(200);
      expect(
        (await client.withBearerToken(userToken).get("/secure/profile/u_2"))
          .status,
      ).toBe(403);
      expect(
        (await client.withBearerToken(adminToken).get("/secure/profile/u_2"))
          .status,
      ).toBe(200);

      // 7. Inline callback policy
      expect(
        (await client.withBearerToken(userToken).get("/secure/verified-only"))
          .status,
      ).toBe(403);
      expect(
        (await client.withBearerToken(adminToken).get("/secure/verified-only"))
          .status,
      ).toBe(200);
    } finally {
      await moduleRef.close();
    }
  });

  it("hashes and verifies passwords with PasswordService (argon2id default and bcrypt)", async () => {
    const svc = new PasswordService({ memoryCost: 4096, timeCost: 1 });

    const argonHash = await svc.hash("CorrectHorseBatteryStaple!");
    expect(argonHash).toContain("$argon2id$");
    expect(await svc.verify("CorrectHorseBatteryStaple!", argonHash)).toBe(true);
    expect(await svc.verify("wrong-password", argonHash)).toBe(false);
    expect(await svc.verify("anything", "not-a-valid-hash")).toBe(false);

    const bcryptHash = await svc.hash("MySecret123", {
      algorithm: "bcrypt",
      cost: 4,
    });
    expect(bcryptHash.startsWith("$2")).toBe(true);
    expect(await svc.verify("MySecret123", bcryptHash)).toBe(true);
    expect(await svc.verify("other", bcryptHash)).toBe(false);
  });

  it("handles signed HMAC SessionCookieService and double-submit CsrfGuard end-to-end", async () => {
    @Controller("/session")
    class SessionController {
      constructor(private readonly sessions: SessionCookieService) {}

      @Post("login")
      async login(@Res() res: ResponseContext) {
        await this.sessions.setSession(res, { userId: "u_99", role: "user" });
        const csrf = this.sessions.setCsrfCookie(res);
        return { csrf };
      }

      @Get("me")
      async me(@Req() req: Request) {
        const session = await this.sessions.getSession(req);
        return { session };
      }

      @UseGuards(CsrfGuard)
      @Post("transfer")
      transfer() {
        return { transferred: true };
      }

      @Post("logout")
      logout(@Res() res: ResponseContext) {
        this.sessions.clearSession(res);
        return { ok: true };
      }
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [SessionController],
      providers: [
        {
          provide: SESSION_COOKIE_OPTIONS,
          useValue: { secret: "session-hmac-secret-key" },
        },
        SessionCookieService,
        CsrfGuard,
      ],
    }).compile();

    const client = moduleRef.createTestClient();
    const sessions = moduleRef.get(SessionCookieService);

    try {
      // Login sets signed HTTP-only session cookie + readable csrf cookie
      const loginRes = await client.post("/session/login");
      expect(loginRes.status).toBe(201);
      const { csrf } = await loginRes.json<{ csrf: string }>();
      const setCookies = loginRes.setCookies();
      expect(setCookies.some((c) => c.includes("bunest_session=") && c.includes("HttpOnly"))).toBe(true);

      const cookies = loginRes.cookies();
      expect(cookies.csrf_token).toBe(csrf);
      expect(cookies.bunest_session).toBeDefined();

      // Valid signed session cookie reads back session data
      const meRes = await client.get("/session/me", {
        cookies: { bunest_session: cookies.bunest_session! },
      });
      expect(await meRes.json()).toEqual({
        session: { userId: "u_99", role: "user" },
      });

      // Tampered session cookie is rejected (returns null)
      const tamperedRes = await client.get("/session/me", {
        cookies: { bunest_session: `${cookies.bunest_session!}tampered` },
      });
      expect(await tamperedRes.json()).toEqual({ session: null });

      // Expired session rejected
      const expiredSigned = await sessions.sign({ userId: "old" }, -5);
      expect(await sessions.verify(expiredSigned)).toBeNull();

      // CSRF guard blocks missing or mismatched header on POST
      expect(
        (
          await client.post("/session/transfer", {
            cookies: { csrf_token: csrf },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await client.post("/session/transfer", {
            cookies: { csrf_token: csrf },
            headers: { "x-csrf-token": "wrong-token" },
          })
        ).status,
      ).toBe(403);

      // Matching double-submit cookie + header passes CsrfGuard
      const okTransfer = await client.post("/session/transfer", {
        cookies: { csrf_token: csrf },
        headers: { "x-csrf-token": csrf },
      });
      expect(okTransfer.status).toBe(201);
      expect(await okTransfer.json()).toEqual({ transferred: true });
    } finally {
      await moduleRef.close();
    }
  });
});
