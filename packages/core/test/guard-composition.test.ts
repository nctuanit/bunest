import { describe, expect, it } from "bun:test";
import {
  APP_GUARD,
  AllGuards,
  AnyGuard,
  Controller,
  DomainException,
  ForbiddenException,
  Get,
  Injectable,
  InternalServerErrorException,
  Module,
  NotGuard,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "../src/common/index";
import { BunestFactory } from "../src/index";

describe("Guard composition (AnyGuard, AllGuards, NotGuard)", () => {
  @Injectable()
  class SecretService {
    readonly validApiKey = "secret-api-key";
  }

  @Injectable()
  class JwtGuard implements CanActivate {
    canActivate(ctx: ExecutionContext): boolean {
      const req = ctx.switchToHttp().getRequest<Request>();
      const auth = req.headers.get("authorization");
      if (auth === "Bearer valid-jwt") return true;
      throw new UnauthorizedException("Invalid JWT");
    }
  }

  @Injectable()
  class ApiKeyGuard implements CanActivate {
    constructor(private readonly secrets: SecretService) {}

    canActivate(ctx: ExecutionContext): boolean {
      const req = ctx.switchToHttp().getRequest<Request>();
      return req.headers.get("x-api-key") === this.secrets.validApiKey;
    }
  }

  @Injectable()
  class AdminGuard implements CanActivate {
    canActivate(ctx: ExecutionContext): boolean {
      const req = ctx.switchToHttp().getRequest<Request>();
      return req.headers.get("x-role") === "admin";
    }
  }

  @Injectable()
  class MaintenanceGuard implements CanActivate {
    canActivate(ctx: ExecutionContext): boolean {
      const req = ctx.switchToHttp().getRequest<Request>();
      return req.headers.get("x-maintenance") === "1";
    }
  }

  @Injectable()
  class BrokenDbGuard implements CanActivate {
    canActivate(): boolean {
      throw new InternalServerErrorException("DB offline");
    }
  }

  @Controller("composed")
  class ComposedController {
    @Get("any")
    @UseGuards(AnyGuard(JwtGuard, ApiKeyGuard))
    anyRoute() {
      return { ok: "any" };
    }

    @Get("nested")
    @UseGuards(AnyGuard(AllGuards(JwtGuard, AdminGuard), ApiKeyGuard))
    nestedRoute() {
      return { ok: "nested" };
    }

    @Get("not")
    @UseGuards(NotGuard(MaintenanceGuard))
    notRoute() {
      return { ok: "not" };
    }

    @Get("db-error")
    @UseGuards(AnyGuard(BrokenDbGuard, ApiKeyGuard))
    dbErrorRoute() {
      return { ok: "never" };
    }
  }

  @Module({
    controllers: [ComposedController],
    providers: [
      SecretService,
      JwtGuard,
      ApiKeyGuard,
      AdminGuard,
      MaintenanceGuard,
      BrokenDbGuard,
    ],
  })
  class TestModule {}

  it("allows request when ANY guard passes (DI-injected ApiKeyGuard or JwtGuard), and rejects with 401 when all fail", async () => {
    const app = await BunestFactory.create(TestModule, { logger: false });
    await app.init();

    try {
      // 1. First guard (JwtGuard) passes -> 200
      const resJwt = await app.fetch(
        new Request("http://localhost/composed/any", {
          headers: { authorization: "Bearer valid-jwt" },
        }),
      );
      expect(resJwt.status).toBe(200);
      expect(await resJwt.json()).toEqual({ ok: "any" });

      // 2. First guard throws 401, second guard (DI-injected ApiKeyGuard) passes -> 200
      const resApiKey = await app.fetch(
        new Request("http://localhost/composed/any", {
          headers: { "x-api-key": "secret-api-key" },
        }),
      );
      expect(resApiKey.status).toBe(200);
      expect(await resApiKey.json()).toEqual({ ok: "any" });

      // 3. Both guards fail -> preserves UnauthorizedException (401)
      const resNone = await app.fetch(
        new Request("http://localhost/composed/any"),
      );
      expect(resNone.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("supports nested AnyGuard(AllGuards(JwtGuard, AdminGuard), ApiKeyGuard)", async () => {
    const app = await BunestFactory.create(TestModule, { logger: false });
    await app.init();

    try {
      // JWT alone (not admin, no API key) -> 403 Forbidden
      const resJwtOnly = await app.fetch(
        new Request("http://localhost/composed/nested", {
          headers: { authorization: "Bearer valid-jwt" },
        }),
      );
      expect(resJwtOnly.status).toBe(403);

      // JWT + Admin -> 200
      const resAdmin = await app.fetch(
        new Request("http://localhost/composed/nested", {
          headers: { authorization: "Bearer valid-jwt", "x-role": "admin" },
        }),
      );
      expect(resAdmin.status).toBe(200);

      // ApiKey alone -> 200
      const resApiKey = await app.fetch(
        new Request("http://localhost/composed/nested", {
          headers: { "x-api-key": "secret-api-key" },
        }),
      );
      expect(resApiKey.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("supports NotGuard() and never swallows non-auth 500 errors in AnyGuard()", async () => {
    const app = await BunestFactory.create(TestModule, { logger: false });
    await app.init();

    try {
      const resOpen = await app.fetch(
        new Request("http://localhost/composed/not"),
      );
      expect(resOpen.status).toBe(200);

      const resMaint = await app.fetch(
        new Request("http://localhost/composed/not", {
          headers: { "x-maintenance": "1" },
        }),
      );
      expect(resMaint.status).toBe(403);

      // 500 from BrokenDbGuard must NOT be swallowed by AnyGuard
      const res500 = await app.fetch(
        new Request("http://localhost/composed/db-error", {
          headers: { "x-api-key": "secret-api-key" },
        }),
      );
      expect(res500.status).toBe(500);
    } finally {
      await app.close();
    }
  });

  it("throws when AnyGuard() or AllGuards() is called with no guards or invalid items", () => {
    expect(() => AnyGuard()).toThrow("requires at least one guard");
    expect(() => AllGuards()).toThrow("requires at least one guard");
    expect(() =>
      NotGuard({} as unknown as CanActivate),
    ).toThrow("Invalid guard");
  });

  it("rethrows ForbiddenException when last failing guard throws 403", async () => {
    const deny403: CanActivate = {
      canActivate() {
        throw new ForbiddenException("No access");
      },
    };
    const GuardCls = AnyGuard(deny403);
    const guard = new GuardCls();
    await expect(
      guard.canActivate({} as ExecutionContext),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("Guard composition with Scope.REQUEST child guards", () => {
  it("instantiates Scope.REQUEST child guards per request inside AnyGuard()", async () => {
    const { Scope } = await import("../src/common/index");
    let constructions = 0;

    @Injectable({ scope: Scope.REQUEST })
    class RequestScopedAuthGuard implements CanActivate {
      readonly instanceId: number;
      constructor() {
        constructions += 1;
        this.instanceId = constructions;
      }
      canActivate(ctx: ExecutionContext): boolean {
        const req = ctx.switchToHttp().getRequest<Request>();
        return req.headers.get("x-req-ok") === "1";
      }
    }

    @Injectable()
    class FallbackGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        const req = ctx.switchToHttp().getRequest<Request>();
        return req.headers.get("x-fallback") === "1";
      }
    }

    @Controller("scoped-any")
    class ScopedAnyController {
      @Get()
      @UseGuards(AnyGuard(RequestScopedAuthGuard, FallbackGuard))
      ping() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [ScopedAnyController],
      providers: [RequestScopedAuthGuard, FallbackGuard],
    })
    class ScopedAnyModule {}

    const app = await BunestFactory.create(ScopedAnyModule, { logger: false });
    await app.init();

    try {
      const r1 = await app.fetch(
        new Request("http://localhost/scoped-any", {
          headers: { "x-req-ok": "1" },
        }),
      );
      expect(r1.status).toBe(200);

      const r2 = await app.fetch(
        new Request("http://localhost/scoped-any", {
          headers: { "x-fallback": "1" },
        }),
      );
      expect(r2.status).toBe(200);

      // Must be instantiated once per request (NOT cached as singleton)
      expect(constructions).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("resolves APP_GUARD with AnyGuard(...) through DI and Scope.REQUEST child guards", async () => {
    const { Scope } = await import("../src/common/index");
    let reqConstructions = 0;

    @Injectable()
    class TokenConfig {
      readonly expected = "app-guard-token";
    }

    @Injectable({ scope: Scope.REQUEST })
    class ReqHeaderGuard implements CanActivate {
      constructor() {
        reqConstructions += 1;
      }
      canActivate(ctx: ExecutionContext): boolean {
        const req = ctx.switchToHttp().getRequest<Request>();
        if (req.headers.get("x-req-token") === "yes") return true;
        throw new DomainException({
          code: "REQ_UNAUTHORIZED",
          kind: "unauthorized",
          message: "Missing request token",
        });
      }
    }

    @Injectable()
    class ConfigTokenGuard implements CanActivate {
      constructor(private readonly cfg: TokenConfig) {}
      canActivate(ctx: ExecutionContext): boolean {
        const req = ctx.switchToHttp().getRequest<Request>();
        return req.headers.get("x-cfg-token") === this.cfg.expected;
      }
    }

    @Controller("app-guard-composed")
    class AppGuardComposedController {
      @Get()
      ping() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [AppGuardComposedController],
      providers: [
        TokenConfig,
        ReqHeaderGuard,
        ConfigTokenGuard,
        {
          provide: APP_GUARD,
          useClass: AnyGuard(ReqHeaderGuard, ConfigTokenGuard),
        },
      ],
    })
    class AppGuardComposedModule {}

    const app = await BunestFactory.create(AppGuardComposedModule, {
      logger: false,
    });
    await app.init();

    try {
      // First child throws DomainException(unauthorized), second DI-injected child allows
      const resCfg = await app.fetch(
        new Request("http://localhost/app-guard-composed", {
          headers: { "x-cfg-token": "app-guard-token" },
        }),
      );
      expect(resCfg.status).toBe(200);

      // Both fail -> rethrows DomainException(unauthorized) as 401
      const resDenied = await app.fetch(
        new Request("http://localhost/app-guard-composed"),
      );
      expect(resDenied.status).toBe(401);

      // Scope.REQUEST child guard instantiated once per request
      expect(reqConstructions).toBe(2);
    } finally {
      await app.close();
    }
  });
});
