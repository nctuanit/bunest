import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Catch,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  Injectable,
  Module,
  Param,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
  type PipeTransform,
} from "@bunest/core";
import { UnknownDependencyException } from "@bunest/core";
import { Test } from "../src";

const CONFIG_TOKEN = Symbol.for("test:config");

@Injectable()
class UsersRepository {
  findAll(): string[] {
    return ["real-alice", "real-bob"];
  }
}

@Injectable()
class UsersService {
  constructor(
    private readonly repo: UsersRepository,
    @Inject(CONFIG_TOKEN) private readonly config: { prefix: string },
  ) {}

  list(): string[] {
    return this.repo.findAll().map((name) => `${this.config.prefix}:${name}`);
  }
}

@Injectable()
class AltUsersRepository {
  findAll(): string[] {
    return ["alt-zoe"];
  }
}

@Injectable()
class PrivateSecretService {
  getSecret(): string {
    return "top-secret";
  }
}

@Module({
  providers: [PrivateSecretService],
})
class SecretModule {}

@Injectable()
class StrictAuthGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Injectable()
class UppercasePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    return value.toUpperCase();
  }
}

@Injectable()
class WrapInterceptor implements BunestInterceptor {
  async intercept(_ctx: ExecutionContext, next: CallHandler): Promise<unknown> {
    const data = await next.handle();
    return { wrapped: data };
  }
}

class CustomDomainError extends Error {
  constructor(message: string) {
    super(message);
  }
}

@Catch(CustomDomainError)
@Injectable()
class DomainErrorFilter implements ExceptionFilter<CustomDomainError> {
  catch(exception: CustomDomainError, _host: ArgumentsHost): Response {
    return Response.json(
      { source: "real-filter", message: exception.message },
      { status: 418 },
    );
  }
}

@Controller("/testing")
class DemoController {
  constructor(private readonly users: UsersService) {}

  @Get("users")
  getUsers() {
    return this.users.list();
  }

  @Get("protected")
  @UseGuards(StrictAuthGuard)
  getProtected() {
    return { secret: "ok" };
  }

  @Get("echo/:word")
  @UseInterceptors(WrapInterceptor)
  echo(@Param("word", UppercasePipe) word: string) {
    return { word };
  }

  @Get("boom")
  @UseFilters(DomainErrorFilter)
  boom(): never {
    throw new CustomDomainError("domain failure");
  }
}

@Module({
  imports: [SecretModule],
  controllers: [DemoController],
  providers: [
    UsersRepository,
    AltUsersRepository,
    UsersService,
    { provide: CONFIG_TOKEN, useValue: { prefix: "prod" } },
  ],
  exports: [UsersService],
})
class DemoFeatureModule {}

describe("Test.createTestingModule & TestingModuleBuilder", () => {
  it("supports overrideProvider with useValue, useClass, useFactory (async), and useExisting", async () => {
    // 1. useValue (both class token & symbol token inside imported module)
    const mod1 = await Test.createTestingModule({
      imports: [DemoFeatureModule],
    })
      .overrideProvider(UsersRepository)
      .useValue({ findAll: () => ["mock-1", "mock-2"] })
      .overrideProvider(CONFIG_TOKEN)
      .useValue({ prefix: "test" })
      .setLogger(false)
      .compile();

    expect(mod1.get(UsersService).list()).toEqual([
      "test:mock-1",
      "test:mock-2",
    ]);
    await mod1.close();

    // 2. useClass (with DI dependency of its own)
    @Injectable()
    class FakeRepo {
      constructor(
        @Inject(CONFIG_TOKEN) private readonly cfg: { prefix: string },
      ) {}
      findAll(): string[] {
        return [`fake-${this.cfg.prefix}`];
      }
    }

    const mod2 = await Test.createTestingModule({
      imports: [DemoFeatureModule],
    })
      .overrideProvider(UsersRepository)
      .useClass(FakeRepo)
      .compile();

    expect(mod2.get(UsersService).list()).toEqual(["prod:fake-prod"]);
    await mod2.close();

    // 3. useFactory (async with injected token)
    const mod3 = await Test.createTestingModule({
      imports: [DemoFeatureModule],
    })
      .overrideProvider(UsersRepository)
      .useFactory({
        factory: async (cfg: { prefix: string }) => {
          await Bun.sleep(2);
          return { findAll: () => [`factory-${cfg.prefix}`] };
        },
        inject: [CONFIG_TOKEN],
      })
      .compile();

    expect(mod3.get(UsersService).list()).toEqual(["prod:factory-prod"]);
    await mod3.close();

    // 4. useExisting
    const mod4 = await Test.createTestingModule({
      imports: [DemoFeatureModule],
    })
      .overrideProvider(UsersRepository)
      .useExisting(AltUsersRepository)
      .compile();

    expect(mod4.get(UsersService).list()).toEqual(["prod:alt-zoe"]);
    await mod4.close();
  });

  it("supports overrideGuard, overridePipe, overrideInterceptor, and overrideFilter (useValue, useClass, useFactory)", async () => {
    // Baseline without overrides: guard denies (403), pipe uppercases, interceptor wraps, real filter returns 418
    const baseMod = await Test.createTestingModule({
      imports: [DemoFeatureModule],
    }).compile();
    const baseClient = baseMod.createTestClient();

    (await baseClient.get("/testing/protected")).expectStatus(403);
    expect(await (await baseClient.get("/testing/echo/hello")).json()).toEqual({
      wrapped: { word: "HELLO" },
    });
    const baseBoom = await baseClient.get("/testing/boom");
    baseBoom.expectStatus(418);
    expect(await baseBoom.json()).toEqual({
      source: "real-filter",
      message: "domain failure",
    });
    await baseMod.close();

    // With all 4 enhancer overrides active
    @Injectable()
    class ReversePipe implements PipeTransform<string, string> {
      transform(value: string): string {
        return value.split("").reverse().join("");
      }
    }

    const ALLOW_FLAG = Symbol("allow");
    const overriddenMod = await Test.createTestingModule({
      imports: [DemoFeatureModule],
      providers: [{ provide: ALLOW_FLAG, useValue: true }],
    })
      .overrideGuard(StrictAuthGuard)
      .useFactory({
        factory: (allow: boolean) => ({ canActivate: () => allow }),
        inject: [ALLOW_FLAG],
      })
      .overridePipe(UppercasePipe)
      .useClass(ReversePipe)
      .overrideInterceptor(WrapInterceptor)
      .useValue({
        intercept: async (_ctx: ExecutionContext, next: CallHandler) => ({
          mocked: await next.handle(),
        }),
      })
      .overrideFilter(DomainErrorFilter)
      .useValue({
        catch: (err: CustomDomainError) =>
          Response.json(
            { source: "mock-filter", message: err.message },
            { status: 400 },
          ),
      })
      .compile();

    const client = overriddenMod.createTestClient();

    const protectedRes = await client.get("/testing/protected");
    protectedRes.expectStatus(200);
    expect(await protectedRes.json()).toEqual({ secret: "ok" });

    const echoRes = await client.get("/testing/echo/bunest");
    echoRes.expectStatus(200);
    expect(await echoRes.json()).toEqual({ mocked: { word: "tsenub" } });

    const boomRes = await client.get("/testing/boom");
    boomRes.expectStatus(400);
    expect(await boomRes.json()).toEqual({
      source: "mock-filter",
      message: "domain failure",
    });

    // Also verify overrideGuard.useValue with custom exception
    const customGuardMod = await Test.createTestingModule({
      imports: [DemoFeatureModule],
    })
      .overrideGuard(StrictAuthGuard)
      .useValue({
        canActivate: () => {
          throw new ForbiddenException("custom-deny");
        },
      })
      .compile();
    const customRes = await customGuardMod
      .createTestClient()
      .get("/testing/protected");
    customRes.expectStatus(403);
    expect(((await customRes.json()) as { message: string }).message).toBe(
      "custom-deny",
    );

    await overriddenMod.close();
    await customGuardMod.close();
  });

  it("supports select(ModuleClass) strict lookups and transient resolve()", async () => {
    let transientCounter = 0;

    @Injectable({ scope: Scope.TRANSIENT })
    class TransientTracker {
      readonly id = ++transientCounter;
    }

    const mod = await Test.createTestingModule({
      imports: [DemoFeatureModule],
      providers: [TransientTracker],
    }).compile();

    // PrivateSecretService is only visible inside SecretModule
    const secretScope = mod.select(SecretModule);
    expect(secretScope.get(PrivateSecretService).getSecret()).toBe(
      "top-secret",
    );

    // Not visible strictly inside DemoFeatureModule
    const featureScope = mod.select(DemoFeatureModule);
    expect(() => featureScope.get(PrivateSecretService)).toThrow(
      UnknownDependencyException,
    );

    // Unknown module fails clearly
    class UnregisteredModule {}
    expect(() => mod.select(UnregisteredModule)).toThrow(
      /not part of this TestingModule graph/,
    );

    // Transient resolve returns distinct instances
    const t1 = await mod.resolve(TransientTracker);
    const t2 = await mod.resolve(TransientTracker);
    expect(t1.id).not.toBe(t2.id);

    await mod.close();
  });

  it("runs lifecycle hooks cleanly and never double-fires shutdown hooks across app.close() + moduleRef.close()", async () => {
    const events: string[] = [];

    @Injectable()
    class LifecycleService
      implements
        OnModuleInit,
        OnApplicationBootstrap,
        OnModuleDestroy,
        OnApplicationShutdown
    {
      onModuleInit() {
        events.push("init");
      }
      onApplicationBootstrap() {
        events.push("bootstrap");
      }
      onModuleDestroy() {
        events.push("destroy");
      }
      onApplicationShutdown(signal?: string) {
        events.push(`shutdown:${signal ?? "none"}`);
      }
    }

    const mod = await Test.createTestingModule({
      providers: [LifecycleService],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();
    expect(events).toEqual(["init", "bootstrap"]);

    await app.close("SIGTERM");
    await mod.close("SIGTERM");
    expect(events).toEqual([
      "init",
      "bootstrap",
      "destroy",
      "shutdown:SIGTERM",
    ]);

    // Also verify calling ONLY moduleRef.close() closes live listening app + fires shutdown once
    events.length = 0;
    const mod2 = await Test.createTestingModule({
      providers: [LifecycleService],
    }).compile();
    const app2 = mod2.createBunestApplication();
    const info = await app2.listen(0);
    expect(info.port).toBeGreaterThan(0);

    await mod2.close();
    expect(events).toEqual(["init", "bootstrap", "destroy", "shutdown:none"]);
    expect(app2.getUrl()).toBeUndefined();
  });

  it("propagates provider override errors cleanly when pipe throws", async () => {
    const mod = await Test.createTestingModule({
      imports: [DemoFeatureModule],
    })
      .overridePipe(UppercasePipe)
      .useValue({
        transform: () => {
          throw new BadRequestException("blocked-by-pipe");
        },
      })
      .compile();

    const res = await mod.createTestClient().get("/testing/echo/hi");
    res.expectStatus(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      statusCode: 400,
      message: "blocked-by-pipe",
    });

    await mod.close();
  });
});
