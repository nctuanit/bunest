import { describe, expect, it } from "bun:test";
import { Exclude, Type } from "@bunest/validation/transformer";
import { IsEmail, IsInt, IsString, Min, MinLength } from "@bunest/validation/validator";
import {
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  Body,
  BunestFactory,
  ClassSerializerInterceptor,
  Controller,
  DuplicateRouteException,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  ParseBoolPipe,
  Post,
  Query,
  REQUEST,
  Reflector,
  Scope,
  ScopeLeakException,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
  type BunestMiddleware,
  type BunestModule,
  type CanActivate,
  type ExecutionContext,
  type MiddlewareConsumer,
  type NextFunction,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
  type OnRequestDestroy,
  type ResponseContext,
} from "../src";

class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(3)
  name!: string;

  @Type(() => Number)
  @IsInt()
  @Min(18)
  age!: number;
}

class UserEntity {
  id: string;
  email: string;
  name: string;
  age: number;

  @Exclude()
  passwordHash: string;

  constructor(partial: Partial<UserEntity>) {
    this.id = partial.id ?? "";
    this.email = partial.email ?? "";
    this.name = partial.name ?? "";
    this.age = partial.age ?? 0;
    this.passwordHash = partial.passwordHash ?? "hashed_secret";
  }
}

describe("BunestFactory & BunestApplication End-to-End", () => {
  it("runs canonical POST /users with CreateUserDto, ValidationPipe, constructor DI -> 201 Created, invalid DTO -> 400 without invoking handler (live Bun.serve)", async () => {
    let handlerCalls = 0;
    const lifecycleEvents: string[] = [];

    @Injectable()
    class UsersService
      implements
        OnModuleInit,
        OnApplicationBootstrap,
        OnModuleDestroy,
        OnApplicationShutdown
    {
      private seq = 0;

      onModuleInit() {
        lifecycleEvents.push("init");
      }
      onApplicationBootstrap() {
        lifecycleEvents.push("bootstrap");
      }
      onModuleDestroy() {
        lifecycleEvents.push("destroy");
      }
      onApplicationShutdown() {
        lifecycleEvents.push("shutdown");
      }

      create(dto: CreateUserDto) {
        return {
          id: `u_${++this.seq}`,
          email: dto.email,
          name: dto.name,
          age: dto.age,
          isDtoInstance: dto instanceof CreateUserDto,
        };
      }

      findOne(id: string, verbose: boolean) {
        return { id, verbose };
      }
    }

    @Controller("/users")
    class UsersController {
      constructor(private readonly users: UsersService) {}

      @Post()
      create(@Body() dto: CreateUserDto) {
        handlerCalls++;
        return this.users.create(dto);
      }

      @Get(":id")
      findOne(
        @Param("id") id: string,
        @Query("verbose", new ParseBoolPipe({ optional: true }))
        verbose = false,
      ) {
        return this.users.findOne(id, verbose);
      }
    }

    @Module({
      controllers: [UsersController],
      providers: [UsersService],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    // Imperative setup AFTER create() triggers clean route recompilation
    app.useGlobalPipes(new ValidationPipe());
    app.setGlobalPrefix("/api");
    app.enableCors({ origin: "https://client.test" });

    const info = await app.listen(0);
    try {
      expect(lifecycleEvents).toEqual(["init", "bootstrap"]);
      expect(info.port).toBeGreaterThan(0);
      expect(app.getRoutes()).toHaveLength(2);

      // 1. Valid DTO -> 201 Created with real DTO instance & CORS header
      const createRes = await fetch(`${info.url}api/users`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://client.test",
        },
        body: JSON.stringify({
          email: "alice@example.com",
          name: "Alice",
          age: "28",
        }),
      });
      expect(createRes.status).toBe(201);
      expect(createRes.headers.get("access-control-allow-origin")).toBe(
        "https://client.test",
      );
      const created = (await createRes.json()) as Record<string, unknown>;
      expect(created).toEqual({
        id: "u_1",
        email: "alice@example.com",
        name: "Alice",
        age: 28,
        isDtoInstance: true,
      });
      expect(handlerCalls).toBe(1);

      // 2. Invalid DTO (bad email, short name, non-whitelisted prop) -> 400 & handler NOT called
      const badRes = await fetch(`${info.url}api/users`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://client.test",
        },
        body: JSON.stringify({
          email: "not-an-email",
          name: "Al",
          age: 16,
          role: "admin",
        }),
      });
      expect(badRes.status).toBe(400);
      expect(badRes.headers.get("access-control-allow-origin")).toBe(
        "https://client.test",
      );
      const badJson = (await badRes.json()) as {
        statusCode: number;
        error: string;
        message: string;
        details: Array<{ field: string }>;
      };
      expect(badJson.statusCode).toBe(400);
      expect(badJson.error).toBe("Bad Request");
      expect(badJson.message).toBe("Validation failed");
      expect(badJson.details.map((d) => d.field).sort()).toEqual([
        "age",
        "email",
        "name",
        "role",
      ]);
      expect(handlerCalls).toBe(1); // handler was NEVER called!

      // 3. GET /api/users/:id?verbose=false -> strict ParseBoolPipe parses "false" -> false
      const getRes = await fetch(`${info.url}api/users/u_1?verbose=false`);
      expect(getRes.status).toBe(200);
      expect(await getRes.json()).toEqual({ id: "u_1", verbose: false });
    } finally {
      await app.close();
    }

    expect(lifecycleEvents).toEqual([
      "init",
      "bootstrap",
      "destroy",
      "shutdown",
    ]);
  });

  it("wires DI-aware APP_GUARD, APP_PIPE, APP_INTERCEPTOR (ClassSerializerInterceptor), and module MiddlewareConsumer", async () => {
    const PUBLIC_KEY = "isPublic";
    const Public = () => SetMetadata(PUBLIC_KEY, true);
    const API_KEY = Symbol("API_KEY");
    const mwTrail: string[] = [];

    @Injectable()
    class ApiKeyGuard implements CanActivate {
      constructor(
        private readonly reflector: Reflector,
        @Inject(API_KEY) private readonly expectedKey: string,
      ) {}

      canActivate(ctx: ExecutionContext): boolean {
        const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
          ctx.getHandler(),
          ctx.getClass(),
        ]);
        if (isPublic) return true;

        const req = ctx.switchToHttp().getRequest<Request>();
        if (req.headers.get("x-api-key") !== this.expectedKey) {
          throw new UnauthorizedException("Invalid API key");
        }
        return true;
      }
    }

    @Injectable()
    class AuditMiddleware implements BunestMiddleware {
      constructor(@Inject(API_KEY) private readonly key: string) {}

      use(req: Request, res: ResponseContext, next: NextFunction) {
        mwTrail.push(
          `${req.method}:${new URL(req.url).pathname}:${this.key.length}`,
        );
        res.header("x-audited", "true");
        return next();
      }
    }

    @Controller("/accounts")
    class AccountsController {
      @Public()
      @Get("health")
      health() {
        return { ok: true };
      }

      @Post()
      create(@Body() dto: CreateUserDto) {
        return new UserEntity({
          id: "acc_1",
          email: dto.email,
          name: dto.name,
          age: dto.age,
          passwordHash: "SUPER_SECRET_HASH",
        });
      }
    }

    @Module({
      controllers: [AccountsController],
      providers: [
        { provide: API_KEY, useValue: "secret-123" },
        AuditMiddleware,
        { provide: APP_GUARD, useClass: ApiKeyGuard },
        { provide: APP_PIPE, useClass: ValidationPipe },
        { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
      ],
    })
    class AppModule implements BunestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer
          .apply(AuditMiddleware)
          .exclude("/accounts/health")
          .forRoutes(AccountsController);
      }
    }

    const app = await BunestFactory.create(AppModule, { logger: false });
    try {
      // 1. Public route bypasses guard & excluded from middleware
      const healthRes = await app.fetch(
        new Request("http://localhost/accounts/health"),
      );
      expect(healthRes.status).toBe(200);
      expect(healthRes.headers.get("x-audited")).toBeNull();
      expect(await healthRes.json()).toEqual({ ok: true });

      // 2. Protected route without API key -> middleware ran, guard rejects with 401 BEFORE validation
      const unauthRes = await app.fetch(
        new Request("http://localhost/accounts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ invalid: true }),
        }),
      );
      expect(unauthRes.status).toBe(401);

      // 3. Protected route with valid key & valid DTO -> middleware + guard + ValidationPipe + ClassSerializerInterceptor strips passwordHash
      const okRes = await app.fetch(
        new Request("http://localhost/accounts", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "secret-123",
          },
          body: JSON.stringify({
            email: "bob@example.com",
            name: "Bob",
            age: 30,
          }),
        }),
      );
      expect(okRes.status).toBe(201);
      expect(okRes.headers.get("x-audited")).toBe("true");
      const body = (await okRes.json()) as Record<string, unknown>;
      expect(body).toEqual({
        id: "acc_1",
        email: "bob@example.com",
        name: "Bob",
        age: 30,
      });
      expect("passwordHash" in body).toBe(false);
      expect(mwTrail).toEqual(["POST:/accounts:10", "POST:/accounts:10"]);
    } finally {
      await app.close();
    }
  });

  it("isolates REQUEST-scoped DI across 25 concurrent HTTP requests and runs OnRequestDestroy cleanup", async () => {
    let contextSeq = 0;
    const destroyedTenants: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class TenantContext implements OnRequestDestroy {
      readonly ctxId = ++contextSeq;
      readonly tenantId: string;

      constructor(@Inject(REQUEST) req: Request) {
        this.tenantId = req.headers.get("x-tenant-id") ?? "unknown";
      }

      onRequestDestroy() {
        destroyedTenants.push(this.tenantId);
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class TenantService {
      constructor(public readonly ctx: TenantContext) {}

      async readTenant(delayMs: number) {
        await Bun.sleep(delayMs);
        return {
          tenantId: this.ctx.tenantId,
          ctxId: this.ctx.ctxId,
        };
      }
    }

    @Controller({ path: "/tenant", scope: Scope.REQUEST })
    class TenantController {
      constructor(
        private readonly ctx: TenantContext,
        private readonly svc: TenantService,
      ) {}

      @Get()
      async inspect(@Query("delay") delay = "1") {
        const result = await this.svc.readTenant(Number(delay));
        return {
          ...result,
          sharedWithinRequest: this.ctx === this.svc.ctx,
        };
      }
    }

    @Module({
      controllers: [TenantController],
      providers: [TenantContext, TenantService],
    })
    class TenantModule {}

    const app = await BunestFactory.create(TenantModule, { logger: false });
    const info = await app.listen(0);

    try {
      // Zero request-scoped instances created at bootstrap
      expect(contextSeq).toBe(0);

      const responses = await Promise.all(
        Array.from({ length: 25 }, async (_, i) => {
          const tenant = `tenant-${i}`;
          const delay = (25 - i) % 7;
          const res = await fetch(`${info.url}tenant?delay=${delay}`, {
            headers: { "x-tenant-id": tenant },
          });
          const data = (await res.json()) as {
            tenantId: string;
            ctxId: number;
            sharedWithinRequest: boolean;
          };
          return { expected: tenant, status: res.status, data };
        }),
      );

      const seenCtxIds = new Set<number>();
      for (const item of responses) {
        expect(item.status).toBe(200);
        expect(item.data.tenantId).toBe(item.expected);
        expect(item.data.sharedWithinRequest).toBe(true);
        seenCtxIds.add(item.data.ctxId);
      }

      expect(seenCtxIds.size).toBe(25);
      expect(destroyedTenants).toHaveLength(25);
    } finally {
      await app.close();
    }
  });

  it("fails fast on duplicate routes and singleton guard scope leaks, and supports standalone createApplicationContext()", async () => {
    // 1. Duplicate route collision fails fast at create()
    @Controller("/items")
    class DupRoutesController {
      @Get(":id")
      byId() {
        return "a";
      }
      @Get(":itemId")
      byItemId() {
        return "b";
      }
    }
    @Module({ controllers: [DupRoutesController] })
    class DupRouteModule {}

    await expect(
      BunestFactory.create(DupRouteModule, { logger: false }),
    ).rejects.toThrow(DuplicateRouteException);

    // 2. Singleton guard injecting REQUEST-scoped provider fails fast with ScopeLeakException
    @Injectable({ scope: Scope.REQUEST })
    class ReqState {}

    @Injectable()
    class LeakyGuard implements CanActivate {
      constructor(public readonly state: ReqState) {}
      canActivate() {
        return Boolean(this.state);
      }
    }

    @Controller("/safe")
    @UseGuards(LeakyGuard)
    class SafeController {
      @Get()
      ping() {
        return "ok";
      }
    }

    @Module({
      controllers: [SafeController],
      providers: [ReqState, LeakyGuard],
    })
    class LeakyGuardModule {}

    await expect(
      BunestFactory.create(LeakyGuardModule, { logger: false }),
    ).rejects.toThrow(ScopeLeakException);

    // 3. Standalone createApplicationContext() without HTTP server
    const events: string[] = [];
    @Injectable()
    class WorkerService implements OnModuleInit, OnModuleDestroy {
      onModuleInit() {
        events.push("worker:init");
      }
      onModuleDestroy() {
        events.push("worker:destroy");
      }
      run() {
        return "done";
      }
    }
    @Module({ providers: [WorkerService] })
    class WorkerModule {}

    const ctx = await BunestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    expect(events).toEqual(["worker:init"]);
    expect(ctx.get(WorkerService).run()).toBe("done");
    await ctx.close();
    expect(events).toEqual(["worker:init", "worker:destroy"]);
  });

  it("executes REQUEST-scoped APP_GUARD (useFactory & provider-level scope override) and useExisting APP_GUARD without silently dropping them", async () => {
    const guardLog: string[] = [];

    @Injectable()
    class ExistingAllowGuard implements CanActivate {
      canActivate() {
        guardLog.push("existing");
        return true;
      }
    }

    // Class itself has default SINGLETON metadata, overridden to Scope.REQUEST on APP_GUARD provider
    @Injectable()
    class HeaderCheckGuard implements CanActivate {
      constructor(@Inject(REQUEST) private readonly req: Request) {}
      canActivate() {
        guardLog.push("override-class");
        return this.req.headers.get("x-second") === "ok";
      }
    }

    @Controller("/guarded")
    class GuardedController {
      @Get()
      secret() {
        return { access: "granted" };
      }
    }

    @Module({
      controllers: [GuardedController],
      providers: [
        ExistingAllowGuard,
        { provide: APP_GUARD, useExisting: ExistingAllowGuard },
        {
          provide: APP_GUARD,
          scope: Scope.REQUEST,
          inject: [REQUEST],
          useFactory: (req: Request): CanActivate => ({
            canActivate: () => {
              guardLog.push("factory");
              return req.headers.get("x-first") === "yes";
            },
          }),
        },
        {
          provide: APP_GUARD,
          useClass: HeaderCheckGuard,
          scope: Scope.REQUEST,
        },
      ],
    })
    class GuardedModule {}

    const app = await BunestFactory.create(GuardedModule, { logger: false });
    try {
      // Missing x-first -> blocked by REQUEST-scoped factory APP_GUARD with 403
      const r1 = await app.fetch(new Request("http://localhost/guarded"));
      expect(r1.status).toBe(403);

      // Has x-first, missing x-second -> blocked by scope-overridden class APP_GUARD with 403
      const r2 = await app.fetch(
        new Request("http://localhost/guarded", {
          headers: { "x-first": "yes" },
        }),
      );
      expect(r2.status).toBe(403);

      // Has both -> passes all 3 APP_GUARDs -> 200 OK
      const r3 = await app.fetch(
        new Request("http://localhost/guarded", {
          headers: { "x-first": "yes", "x-second": "ok" },
        }),
      );
      expect(r3.status).toBe(200);
      expect(await r3.json()).toEqual({ access: "granted" });
      expect(guardLog).toContain("existing");
      expect(guardLog).toContain("factory");
      expect(guardLog).toContain("override-class");
    } finally {
      await app.close();
    }
  });

  it("fails fast with ScopeLeakException when singleton module middleware or imperative global guard injects a REQUEST-scoped provider", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class ReqTenant {}

    @Injectable()
    class LeakyMiddleware implements BunestMiddleware {
      constructor(public readonly tenant: ReqTenant) {}
      use(_req: Request, _res: ResponseContext, next: NextFunction) {
        return next();
      }
    }

    @Controller("/mw")
    class MwController {
      @Get()
      ping() {
        return "pong";
      }
    }

    @Module({
      controllers: [MwController],
      providers: [ReqTenant],
    })
    class LeakyMwModule implements BunestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(LeakyMiddleware).forRoutes(MwController);
      }
    }

    await expect(
      BunestFactory.create(LeakyMwModule, { logger: false }),
    ).rejects.toThrow(ScopeLeakException);

    // Imperative useGlobalGuards() with singleton guard injecting REQUEST-scoped provider
    @Injectable()
    class ImperativeLeakyGuard implements CanActivate {
      constructor(public readonly tenant: ReqTenant) {}
      canActivate() {
        return Boolean(this.tenant);
      }
    }

    @Module({
      controllers: [MwController],
      providers: [ReqTenant],
    })
    class CleanModule {}

    const app = await BunestFactory.create(CleanModule, { logger: false });
    app.useGlobalGuards(ImperativeLeakyGuard);
    await expect(app.init()).rejects.toThrow(ScopeLeakException);
    await app.close();
  });

  it("applies overrides.guards and overrides.pipes to APP_GUARD and APP_PIPE multi-providers (for @bunest/testing)", async () => {
    @Injectable()
    class RealDenyGuard implements CanActivate {
      canActivate() {
        return false;
      }
    }

    @Controller("/override-test")
    class OverrideController {
      @Get()
      ok() {
        return { bypassed: true };
      }
    }

    @Module({
      controllers: [OverrideController],
      providers: [{ provide: APP_GUARD, useClass: RealDenyGuard }],
    })
    class OverrideModule {}

    // Without override -> 403 Forbidden
    const realApp = await BunestFactory.create(OverrideModule, {
      logger: false,
    });
    expect(
      (await realApp.fetch(new Request("http://localhost/override-test")))
        .status,
    ).toBe(403);
    await realApp.close();

    // With guard override -> 200 OK
    const mockedApp = await BunestFactory.create(OverrideModule, {
      logger: false,
      overrides: {
        guards: new Map([[RealDenyGuard, { canActivate: () => true }]]),
      },
    });
    const res = await mockedApp.fetch(
      new Request("http://localhost/override-test"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bypassed: true });
    await mockedApp.close();
  });
});
