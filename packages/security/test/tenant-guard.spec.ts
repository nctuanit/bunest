import { describe, expect, it } from "bun:test";
import {
  APP_GUARD,
  ClsModule,
  ClsService,
  Controller,
  Get,
  Injectable,
  Param,
  Req,
  UseGuards,
  type ExecutionContext,
} from "@bunest/core";
import { getCurrentRequestContext } from "@bunest/core/http";
import { Test } from "@bunest/testing";
import {
  AuthenticationGuard,
  AuthenticationModule,
  AuthenticationProvider,
  AuthenticationRegistry,
  type AuthenticationResult,
} from "../src/auth-next/index";
import {
  CurrentTenant,
  JwtAuthGuard,
  JwtModule,
  JwtService,
  Public,
  RequireTenant,
  SecurityModule,
  TENANT_GUARD_OPTIONS,
  TenantGuard,
  TenantRoles,
  getRequestTenant,
  type TenantGuardOptions,
} from "../src/index";

describe("Multi-Tenant Auth Guard (TenantGuard, @RequireTenant, @TenantRoles, @CurrentTenant)", () => {
  it("resolves tenant from user/header/param/subdomain, blocks cross-tenant spoofing, enforces @TenantRoles, and propagates into ClsService + RequestContext", async () => {
    @Injectable()
    class DownstreamTenantService {
      constructor(private readonly cls: ClsService) {}

      readAmbientTenant() {
        return {
          clsTenant: this.cls.get<string>("tenantId"),
          reqCtxTenant: (
            getCurrentRequestContext() as unknown as Record<string, unknown>
          )?.tenantId,
        };
      }
    }

    @Controller("/mt")
    class MultiTenantController {
      constructor(private readonly downstream: DownstreamTenantService) {}

      @Public()
      @Get("open")
      open() {
        return { open: true };
      }

      @RequireTenant()
      @Get("default")
      defaultTenant(
        @CurrentTenant() tenant: string,
        @Req() req: Request,
      ) {
        return {
          tenant,
          fromWeakMap: getRequestTenant(req),
          ...this.downstream.readAmbientTenant(),
        };
      }

      @RequireTenant({ sources: ["param", "user"], paramName: "orgId" })
      @Get("orgs/:orgId/billing")
      orgBilling(
        @Param("orgId") orgId: string,
        @CurrentTenant() tenant: string,
      ) {
        return { orgId, tenant, ...this.downstream.readAmbientTenant() };
      }

      @RequireTenant({ sources: ["header", "user"] })
      @TenantRoles("admin")
      @Get("admin-only")
      adminOnly(@CurrentTenant() tenant: string) {
        return { tenant, admin: true };
      }

      @RequireTenant({
        sources: ["header", "user"],
        requireAllRoles: true,
      })
      @TenantRoles("billing", "owner")
      @Get("owner-billing")
      ownerBilling(@CurrentTenant() tenant: string) {
        return { tenant, ok: true };
      }

      @Public()
      @RequireTenant({
        requireAuthenticated: false,
        sources: ["subdomain", "header"],
        baseDomain: "saas.example.com",
      })
      @Get("public-branding")
      publicBranding(@CurrentTenant() tenant: string) {
        return { tenant, ...this.downstream.readAmbientTenant() };
      }

      @RequireTenant({
        sources: ["header"],
        requireMembership: false,
      })
      @Get("opt-out-membership")
      optOutMembership(@CurrentTenant() tenant: string) {
        return { tenant };
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ middleware: { mount: true } }),
        JwtModule.register({ secret: "tenant-guard-test-secret" }),
      ],
      controllers: [MultiTenantController],
      providers: [
        DownstreamTenantService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: TenantGuard },
      ],
    }).compile();

    const client = mod.createTestClient();
    const jwt = mod.get(JwtService);

    const singleTenantToken = await jwt.sign({
      sub: "u-single",
      tenantId: "acme",
    });

    const multiTenantToken = await jwt.sign({
      sub: "u-multi",
      tenants: ["acme", "beta"],
      tenantRoles: {
        acme: ["admin", "billing", "owner"],
        beta: ["viewer", "billing"],
      },
    });

    const noTenantToken = await jwt.sign({
      sub: "u-orphan",
    });

    try {
      // 1. Route without @RequireTenant passes freely
      expect((await client.get("/mt/open")).status).toBe(200);

      // 2. Unauthenticated request to @RequireTenant fails with 401
      expect(
        (
          await client.get("/mt/default", {
            headers: { "x-tenant-id": "acme" },
          })
        ).status,
      ).toBe(401);

      // 3. Single-tenant user resolves from JWT user.tenantId & propagates to ClsService + RequestContext + @CurrentTenant
      const rDefault = await client
        .withBearerToken(singleTenantToken)
        .get("/mt/default");
      expect(rDefault.status).toBe(200);
      expect(await rDefault.json()).toEqual({
        tenant: "acme",
        fromWeakMap: "acme",
        clsTenant: "acme",
        reqCtxTenant: "acme",
      });

      // 4. ANTI-SPOOFING: single-tenant user ("acme") sending x-tenant-id: beta is BLOCKED (403)!
      expect(
        (
          await client.withBearerToken(singleTenantToken).get("/mt/default", {
            headers: { "x-tenant-id": "beta" },
          })
        ).status,
      ).toBe(403);

      // 5. Matching x-tenant-id: acme passes cleanly
      expect(
        (
          await client.withBearerToken(singleTenantToken).get("/mt/default", {
            headers: { "x-tenant-id": "acme" },
          })
        ).status,
      ).toBe(200);

      // 6. ANTI-SPOOFING on route param: user bound to "acme" cannot access /orgs/beta/billing (403)
      expect(
        (
          await client
            .withBearerToken(singleTenantToken)
            .get("/mt/orgs/beta/billing")
        ).status,
      ).toBe(403);
      const rOwnOrg = await client
        .withBearerToken(singleTenantToken)
        .get("/mt/orgs/acme/billing");
      expect(rOwnOrg.status).toBe(200);
      expect((await rOwnOrg.json<{ clsTenant: string }>()).clsTenant).toBe("acme");

      // 7. Multi-tenant user: @TenantRoles("admin") succeeds on acme, FAILS on beta (no cross-tenant role leak!), FAILS on gamma (non-member!)
      const rAcmeAdmin = await client
        .withBearerToken(multiTenantToken)
        .get("/mt/admin-only", { headers: { "x-tenant-id": "acme" } });
      expect(rAcmeAdmin.status).toBe(200);
      expect(await rAcmeAdmin.json()).toEqual({ tenant: "acme", admin: true });

      expect(
        (
          await client
            .withBearerToken(multiTenantToken)
            .get("/mt/admin-only", { headers: { "x-tenant-id": "beta" } })
        ).status,
      ).toBe(403);

      expect(
        (
          await client
            .withBearerToken(multiTenantToken)
            .get("/mt/admin-only", { headers: { "x-tenant-id": "gamma" } })
        ).status,
      ).toBe(403);

      // 8. requireAllRoles: acme has ["admin","billing","owner"] -> 200; beta only has ["viewer","billing"] -> 403
      expect(
        (
          await client
            .withBearerToken(multiTenantToken)
            .get("/mt/owner-billing", { headers: { "x-tenant-id": "acme" } })
        ).status,
      ).toBe(200);
      expect(
        (
          await client
            .withBearerToken(multiTenantToken)
            .get("/mt/owner-billing", { headers: { "x-tenant-id": "beta" } })
        ).status,
      ).toBe(403);

      // 9. Public tenant route resolves subdomain (acme.saas.example.com) and rejects conflicting subdomain + header
      const rSub = await client.get("/mt/public-branding", {
        headers: { host: "acme.saas.example.com" },
      });
      expect(rSub.status).toBe(200);
      expect(
        await rSub.json<{
          tenant: string;
          clsTenant: string;
          reqCtxTenant: string;
        }>(),
      ).toEqual({
        tenant: "acme",
        clsTenant: "acme",
        reqCtxTenant: "acme",
      });

      // Conflicting subdomain ("acme") vs header ("beta") -> 403 smuggling prevention
      expect(
        (
          await client.get("/mt/public-branding", {
            headers: {
              host: "acme.saas.example.com",
              "x-tenant-id": "beta",
            },
          })
        ).status,
      ).toBe(403);

      // Malformed tenant ID (injection attempt) -> 403
      expect(
        (
          await client.get("/mt/public-branding", {
            headers: { "x-tenant-id": "acme; DROP TABLE users" },
          })
        ).status,
      ).toBe(403);

      // Missing tenant on public tenant route -> 403 (or 401 when unauthenticated)
      expect(
        (
          await client.get("/mt/public-branding", {
            headers: { host: "www.saas.example.com" },
          })
        ).status,
      ).toBe(401);

      // Authenticated user with no tenant anywhere -> 403
      expect(
        (await client.withBearerToken(noTenantToken).get("/mt/default")).status,
      ).toBe(403);

      // FAIL-CLOSED ANTI-SPOOFING: unbound user (no tenant claims) sending x-tenant-id: acme MUST be rejected (403)!
      expect(
        (
          await client.withBearerToken(noTenantToken).get("/mt/default", {
            headers: { "x-tenant-id": "acme" },
          })
        ).status,
      ).toBe(403);

      // Explicit opt-out requireMembership: false allows unbound user to resolve header tenant
      const rOptOut = await client
        .withBearerToken(noTenantToken)
        .get("/mt/opt-out-membership", {
          headers: { "x-tenant-id": "acme" },
        });
      expect(rOptOut.status).toBe(200);
      expect(await rOptOut.json()).toEqual({ tenant: "acme" });

      // Prototype-chain key ("toString") cannot bypass Object.hasOwn check in tenantRoles
      const protoToken = await jwt.sign({
        sub: "u-proto",
        tenants: ["toString"],
        tenantRoles: { acme: ["admin"] },
      });
      expect(
        (
          await client.withBearerToken(protoToken).get("/mt/admin-only", {
            headers: { "x-tenant-id": "toString" },
          })
        ).status,
      ).toBe(403);
    } finally {
      await mod.close();
    }
  });

  it("supports custom validateMembership/getTenantRoles, AuthenticationModule (auth-next), and SecurityModule wiring", async () => {
    @Injectable()
    class HeaderUserProvider extends AuthenticationProvider {
      constructor(registry: AuthenticationRegistry) {
        super();
        registry.registerProvider(this);
      }

      async authenticate(
        context: ExecutionContext,
      ): Promise<AuthenticationResult | null> {
        const req = context.switchToHttp().getRequest<Request>();
        const userId = req.headers.get("x-test-user");
        if (!userId) return null;
        return {
          user: {
            id: userId,
            orgId: req.headers.get("x-test-org") ?? undefined,
          },
          session: {
            id: "sess-1",
            metadata: { tenantId: req.headers.get("x-test-session-tenant") ?? undefined },
          },
        };
      }
    }

    @Controller("/next-mt")
    class AuthNextTenantController {
      constructor(private readonly cls: ClsService) {}

      @UseGuards(TenantGuard)
      @RequireTenant({ sources: ["header", "user"] })
      @TenantRoles("editor")
      @Get("docs")
      docs(@CurrentTenant() tenant: string) {
        return { tenant, clsTenant: this.cls.get<string>("tenantId") };
      }
    }

    const guardOptions: TenantGuardOptions = {
      validateMembership: async (user: any, tenantId) =>
        user?.id === "super-admin" || user?.orgId === tenantId,
      getTenantRoles: async (user: any, tenantId) =>
        user?.id === "super-admin" && tenantId === "partner-co"
          ? ["editor"]
          : [],
    };

    const mod = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ middleware: { mount: true } }),
        AuthenticationModule.forRoot(),
      ],
      controllers: [AuthNextTenantController],
      providers: [
        HeaderUserProvider,
        { provide: TENANT_GUARD_OPTIONS, useValue: guardOptions },
        TenantGuard,
      ],
    }).compile();

    const client = mod.createTestClient();
    try {
      expect(mod.get(AuthenticationGuard)).toBeDefined();

      // Super-admin approved via custom validateMembership + getTenantRoles
      const ok = await client.get("/next-mt/docs", {
        headers: {
          "x-test-user": "super-admin",
          "x-tenant-id": "partner-co",
        },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({
        tenant: "partner-co",
        clsTenant: "partner-co",
      });

      // Regular user fails custom validateMembership on another tenant
      expect(
        (
          await client.get("/next-mt/docs", {
            headers: {
              "x-test-user": "alice",
              "x-test-org": "acme",
              "x-tenant-id": "partner-co",
            },
          })
        ).status,
      ).toBe(403);
    } finally {
      await mod.close();
    }

    // SecurityModule.forRoot({ jwt, tenantGuard, globalGuards: true }) auto-wires TenantGuard
    @Controller("/sec-mt")
    class SecTenantController {
      @RequireTenant()
      @Get("me")
      me(@CurrentTenant() tenant: string) {
        return { tenant };
      }
    }

    const secMod = await Test.createTestingModule({
      imports: [
        SecurityModule.forRoot({
          jwt: { secret: "sec-mod-tenant-secret" },
          tenantGuard: { sources: ["user", "header"] },
          globalGuards: true,
        }),
      ],
      controllers: [SecTenantController],
    }).compile();

    const secClient = secMod.createTestClient();
    const secJwt = secMod.get(JwtService);
    try {
      const tok = await secJwt.sign({ sub: "u1", orgId: "org-42" });
      const res = await secClient.withBearerToken(tok).get("/sec-mt/me");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tenant: "org-42" });

      expect(
        (
          await secClient.withBearerToken(tok).get("/sec-mt/me", {
            headers: { "x-tenant-id": "org-99" },
          })
        ).status,
      ).toBe(403);
    } finally {
      await secMod.close();
    }
  });
});
