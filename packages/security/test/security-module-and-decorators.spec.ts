import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  Auth,
  CheckPolicies,
  CurrentUser,
  JwtService,
  Protected,
  Public,
  Roles,
  SecurityModule,
  setRequestUser,
} from "../src";

describe("@bunest/security @Auth, @Protected & SecurityModule.forRoot()", () => {
  test("@Auth(...roles) and @Protected(options) enforce JWT auth, RBAC roles, ABAC policies, and custom guards declaratively", async () => {
    @Injectable()
    class ApiKeyGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<Request>();
        const key = req.headers.get("x-api-key");
        if (key === "secret-editor-key") {
          setRequestUser(req, { sub: "svc-editor", roles: ["editor"] });
          return true;
        }
        if (key === "secret-viewer-key") {
          setRequestUser(req, { sub: "svc-viewer", roles: ["viewer"] });
          return true;
        }
        throw new UnauthorizedException("Invalid API key");
      }
    }

    @Controller("/declarative")
    class DeclarativeController {
      @Get("open")
      open() {
        return { open: true };
      }

      @Auth()
      @Get("authed")
      authed(@CurrentUser("sub") sub: string) {
        return { sub };
      }

      @Auth("admin", "moderator")
      @Get("admin")
      admin(@CurrentUser("sub") sub: string) {
        return { admin: sub };
      }

      @Protected({ roles: ["admin"] })
      @Get("protected-admin")
      protectedAdmin() {
        return { ok: true };
      }

      @Protected({ guards: [ApiKeyGuard] })
      @Get("api-key-only")
      apiKeyOnly(@CurrentUser("sub") sub: string) {
        return { caller: sub };
      }

      @Protected({ guards: [ApiKeyGuard], roles: ["editor"] })
      @Get("api-key-editor")
      apiKeyEditor(@CurrentUser("sub") sub: string) {
        return { editor: sub };
      }

      @Protected({
        roles: ["admin"],
        policies: [(user: { verified?: boolean }) => Boolean(user?.verified)],
      })
      @Get("protected-policy")
      protectedPolicy() {
        return { verifiedAdmin: true };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        SecurityModule.forRoot({
          jwt: { secret: "composite-secret" },
          globalGuards: false,
        }),
      ],
      controllers: [DeclarativeController],
      providers: [ApiKeyGuard],
    }).compile();

    const client = moduleRef.createTestClient();
    const jwt = moduleRef.get(JwtService);

    const memberToken = await jwt.sign({ sub: "u_member", roles: ["member"] });
    const unverifiedAdminToken = await jwt.sign({
      sub: "u_admin_unverified",
      roles: ["admin"],
      verified: false,
    });
    const verifiedAdminToken = await jwt.sign({
      sub: "u_admin",
      roles: ["admin"],
      verified: true,
    });

    try {
      // Undecorated route stays open when globalGuards: false
      expect((await client.get("/declarative/open")).status).toBe(200);

      // @Auth() requires valid JWT
      expect((await client.get("/declarative/authed")).status).toBe(401);
      const authedRes = await client
        .withBearerToken(memberToken)
        .get("/declarative/authed");
      expect(authedRes.status).toBe(200);
      expect(await authedRes.json()).toEqual({ sub: "u_member" });

      // @Auth("admin", "moderator") requires JWT + matching role
      expect((await client.get("/declarative/admin")).status).toBe(401);
      expect(
        (await client.withBearerToken(memberToken).get("/declarative/admin"))
          .status,
      ).toBe(403);
      expect(
        (
          await client
            .withBearerToken(verifiedAdminToken)
            .get("/declarative/admin")
        ).status,
      ).toBe(200);

      // @Protected({ roles: ["admin"] })
      expect(
        (
          await client
            .withBearerToken(memberToken)
            .get("/declarative/protected-admin")
        ).status,
      ).toBe(403);
      expect(
        (
          await client
            .withBearerToken(verifiedAdminToken)
            .get("/declarative/protected-admin")
        ).status,
      ).toBe(200);

      // @Protected({ guards: [ApiKeyGuard] }) uses custom guard directly
      expect((await client.get("/declarative/api-key-only")).status).toBe(401);
      const apiKeyRes = await client.get("/declarative/api-key-only", {
        headers: { "x-api-key": "secret-viewer-key" },
      });
      expect(apiKeyRes.status).toBe(200);
      expect(await apiKeyRes.json()).toEqual({ caller: "svc-viewer" });

      // @Protected({ guards: [ApiKeyGuard], roles: ["editor"] }) chains ApiKeyGuard + RolesGuard
      expect(
        (
          await client.get("/declarative/api-key-editor", {
            headers: { "x-api-key": "secret-viewer-key" },
          })
        ).status,
      ).toBe(403);
      const editorRes = await client.get("/declarative/api-key-editor", {
        headers: { "x-api-key": "secret-editor-key" },
      });
      expect(editorRes.status).toBe(200);
      expect(await editorRes.json()).toEqual({ editor: "svc-editor" });

      // @Protected({ roles, policies }) chains JwtAuthGuard + RolesGuard + PoliciesGuard
      expect(
        (
          await client
            .withBearerToken(unverifiedAdminToken)
            .get("/declarative/protected-policy")
        ).status,
      ).toBe(403);
      expect(
        (
          await client
            .withBearerToken(verifiedAdminToken)
            .get("/declarative/protected-policy")
        ).status,
      ).toBe(200);
    } finally {
      await moduleRef.close();
    }
  });

  test("SecurityModule.forRoot({ jwt, throttler, globalGuards: true, securityHeaders: true }) wires full global security in one line", async () => {
    @Controller("/one-line")
    class OneLineController {
      @Public()
      @Get("health")
      health() {
        return { status: "ok" };
      }

      @Get("me")
      me(@CurrentUser("sub") sub: string) {
        return { sub };
      }

      @Roles("admin")
      @Get("secret")
      secret() {
        return { secret: true };
      }

      @CheckPolicies((u: { active?: boolean }) => Boolean(u?.active))
      @Get("active")
      active() {
        return { active: true };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        SecurityModule.forRoot({
          jwt: { secret: "one-line-jwt-secret" },
          throttler: { throttlers: [{ ttl: 10_000, limit: 10 }] },
          globalGuards: true,
          securityHeaders: { frameOptions: "SAMEORIGIN" },
        }),
      ],
      controllers: [OneLineController],
    }).compile();

    const client = moduleRef.createTestClient();
    const jwt = moduleRef.get(JwtService);

    const userToken = await jwt.sign({
      sub: "u1",
      roles: ["user"],
      active: false,
    });
    const adminToken = await jwt.sign({
      sub: "u_admin",
      roles: ["admin"],
      active: true,
    });

    try {
      // @Public() works + security headers + rate limit headers present automatically!
      const pubRes = await client.get("/one-line/health");
      expect(pubRes.status).toBe(200);
      expect(pubRes.headers.get("x-content-type-options")).toBe("nosniff");
      expect(pubRes.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(pubRes.headers.get("x-ratelimit-limit")).toBe("10");

      // Protected globally without manual APP_GUARD
      expect((await client.get("/one-line/me")).status).toBe(401);
      const meRes = await client.withBearerToken(userToken).get("/one-line/me");
      expect(meRes.status).toBe(200);
      expect(await meRes.json()).toEqual({ sub: "u1" });

      // Global RolesGuard works automatically
      expect(
        (await client.withBearerToken(userToken).get("/one-line/secret"))
          .status,
      ).toBe(403);
      expect(
        (await client.withBearerToken(adminToken).get("/one-line/secret"))
          .status,
      ).toBe(200);

      // Global PoliciesGuard works automatically
      expect(
        (await client.withBearerToken(userToken).get("/one-line/active"))
          .status,
      ).toBe(403);
      expect(
        (await client.withBearerToken(adminToken).get("/one-line/active"))
          .status,
      ).toBe(200);
    } finally {
      await moduleRef.close();
    }
  });
});
