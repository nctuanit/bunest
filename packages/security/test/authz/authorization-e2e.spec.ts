import { describe, expect, it } from "bun:test";
import { Controller, Get, Injectable, Param } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  AuthenticationModule,
  AuthenticationRegistry,
  CurrentUser,
  JwtBearerProvider,
  JwtSigner,
  Public,
  type JwtClaims,
} from "../../src/auth-next/index";
import {
  AuthorizationModule,
  AuthorizationService,
  Can,
  Policy,
  type PolicyBefore,
} from "../../src/authz/index";

interface AppUser {
  id: string;
  role: "admin" | "member";
}

interface Order {
  id: string;
  ownerId: string;
}

const ORDERS = new Map<string, Order>([
  ["o1", { id: "o1", ownerId: "u1" }],
  ["o2", { id: "o2", ownerId: "u2" }],
]);

const USERS = new Map<string, AppUser>([
  ["admin", { id: "admin", role: "admin" }],
  ["u1", { id: "u1", role: "member" }],
  ["u2", { id: "u2", role: "member" }],
]);

const JWT_SECRET = "authz-e2e-integration-secret-32-bytes!";

@Policy()
class OrderPolicy implements PolicyBefore<AppUser> {
  before(user: AppUser | null): boolean | undefined {
    if (user?.role === "admin") return true;
    return undefined;
  }

  accessArea(user: AppUser | null): boolean {
    return user !== null;
  }

  read(user: AppUser | null, orderId: string): boolean {
    if (!user) return false;
    return ORDERS.get(orderId)?.ownerId === user.id;
  }

  delete(user: AppUser | null, order: Order): boolean {
    return user !== null && order.ownerId === user.id;
  }
}

@Injectable()
class JwtAuth extends JwtBearerProvider<AppUser> {
  constructor(registry: AuthenticationRegistry) {
    super();
    registry.registerProvider(this);
  }
  validate(claims: JwtClaims) {
    return claims.sub ? (USERS.get(claims.sub) ?? null) : null;
  }
}

@Can(OrderPolicy, "accessArea")
@Controller("orders")
class OrdersController {
  constructor(private readonly authz: AuthorizationService) {}

  @Public()
  @Get("health")
  health() {
    return { status: "ok" };
  }

  @Can.Anyone()
  @Get("catalog")
  catalog(@CurrentUser() user: AppUser | null) {
    return { items: ["book"], viewer: user?.id ?? null };
  }

  @Can(OrderPolicy, "read", (ctx) => {
    const req = ctx.switchToHttp().getRequest() as Request;
    const id = new URL(req.url).pathname.split("/").pop()!;
    return [id] as const;
  })
  @Get(":id")
  read(@Param("id") id: string, @CurrentUser() user: AppUser) {
    return { order: ORDERS.get(id), by: user.id };
  }

  @Can.Anyone()
  @Get("service-check/:id")
  async serviceCheck(
    @Param("id") id: string,
    @CurrentUser() user: AppUser | null,
  ) {
    const order = ORDERS.get(id)!;
    await this.authz.authorize(OrderPolicy, "delete", user, order);
    return { deleted: id };
  }
}

@Controller("undecorated")
class UndecoratedController {
  @Get("secret")
  secret() {
    return { leaked: true };
  }
}

describe("@bunest/authorization HTTP E2E & @bunest/authentication integration", () => {
  it("enforces deny-by-default, @Can stacking, @Can.Anyone, @Public, and AuthorizationErrorInterceptor", async () => {
    const modRef = await Test.createTestingModule({
      imports: [
        // AuthenticationModule MUST be imported BEFORE AuthorizationModule so AuthenticationGuard runs first!
        AuthenticationModule.forRoot({
          accessToken: { key: JWT_SECRET },
        }),
        AuthorizationModule.forRootAsync({
          policies: [OrderPolicy],
          useFactory: () => ({}),
        }),
      ],
      controllers: [OrdersController, UndecoratedController],
      providers: [JwtAuth],
    }).compile();

    const app = modRef.createBunestApplication();
    await app.init();

    const signer = new JwtSigner({ key: JWT_SECRET });
    const tokenU1 = await signer.sign({ sub: "u1" });
    const tokenU2 = await signer.sign({ sub: "u2" });
    const tokenAdmin = await signer.sign({ sub: "admin" });

    try {
      // 1. @Public() route works without @Can.Anyone() and without credentials!
      const health = await app.inject({ method: "GET", url: "/orders/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok" });

      // 2. @Can.Anyone() lifts class-level @Can(); authenticated user passes
      const catalog = await app.inject({
        method: "GET",
        url: "/orders/catalog",
        headers: { authorization: `Bearer ${tokenU1}` },
      });
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json()).toEqual({ items: ["book"], viewer: "u1" });

      // 3. Undecorated route is denied-by-default (403 even when authenticated!)
      const secretRes = await app.inject({
        method: "GET",
        url: "/undecorated/secret",
        headers: { authorization: `Bearer ${tokenAdmin}` },
      });
      expect(secretRes.statusCode).toBe(403);

      // 4. @Can with args resolver allows owner & admin, denies non-owner (403)
      const ownOrder = await app.inject({
        method: "GET",
        url: "/orders/o1",
        headers: { authorization: `Bearer ${tokenU1}` },
      });
      expect(ownOrder.statusCode).toBe(200);
      expect(ownOrder.json<{ order: Order }>().order.id).toBe("o1");

      const otherOrder = await app.inject({
        method: "GET",
        url: "/orders/o1",
        headers: { authorization: `Bearer ${tokenU2}` },
      });
      expect(otherOrder.statusCode).toBe(403);

      const adminOrder = await app.inject({
        method: "GET",
        url: "/orders/o1",
        headers: { authorization: `Bearer ${tokenAdmin}` },
      });
      expect(adminOrder.statusCode).toBe(200);

      // 5. AuthorizationErrorInterceptor converts service authorize() throws into HTTP 403
      const svcForbidden = await app.inject({
        method: "GET",
        url: "/orders/service-check/o1",
        headers: { authorization: `Bearer ${tokenU2}` },
      });
      expect(svcForbidden.statusCode).toBe(403);

      const svcAllowed = await app.inject({
        method: "GET",
        url: "/orders/service-check/o1",
        headers: { authorization: `Bearer ${tokenU1}` },
      });
      expect(svcAllowed.statusCode).toBe(200);
      expect(svcAllowed.json()).toEqual({ deleted: "o1" });
    } finally {
      await app.close();
    }
  });

  it("fails at startup when AuthorizationModule is imported before AuthenticationModule (guard ordering check)", async () => {
    const modRef = await Test.createTestingModule({
      imports: [
        // Wrong order: AuthorizationGuard registered BEFORE AuthenticationGuard!
        AuthorizationModule.forRoot({ policies: [OrderPolicy] }),
        AuthenticationModule.forRoot({
          accessToken: { key: JWT_SECRET },
        }),
      ],
      controllers: [OrdersController],
      providers: [JwtAuth],
    }).compile();

    const app = modRef.createBunestApplication();
    await expect(app.init()).rejects.toThrow("runs before");
  });
});
