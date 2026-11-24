# Testing

`@bunest/testing` brings **full `@nestjs/testing` API parity** directly to **Bun** (`bun:test`)—combining `Test.createTestingModule()`, provider/enhancer/module overrides, zero-dependency auto-mocking (`useMocker` + `createAutoMocker`), `ContextId` request-scope testing, and structured log assertions (`TestingLogger` / `CapturingLogger`) with **zero-socket in-memory HTTP E2E testing** (`request(app)`, `TestClient`, `app.inject()`), live ephemeral-port testing (`app.listen(0)`), SSE stream helpers, and an optional Node `http.Server` bridge for legacy `supertest`.

## Installation & Setup

Install `@bunest/testing` as a dev dependency alongside `@bunest/core`:

```bash
bun add -d @bunest/testing
```

`@bunest/core` includes a built-in zero-dependency Reflect Metadata shim ([ADR-017](/architecture/adrs)), so no `import "reflect-metadata"` boilerplate is needed in your test files:

```bash
# Run all unit & E2E tests with Bun's native runner
bun test
```

> tip **E2E File Naming (`*.e2e.spec.ts`)** Unlike Jest's default `*.e2e-spec.ts` pattern, `bun test` auto-discovers files ending in `.spec.ts`, `.test.ts`, `_spec.ts`, or `_test.ts`. Name your E2E test files `*.e2e.spec.ts` (with a dot before `spec`) so `bun test` picks them up automatically.

> info **Zero External Mock Dependencies** `@bunest/testing` requires no Jest, `jest-mock`, RxJS, Express, or external HTTP packages. Its auto-mocker (`ModuleMocker` / `createAutoMocker`), fluent Supertest-style `request(app)` client, cookie jar, and SSE parser are built natively on Bun and Web Standards ([ADR-001](/architecture/adrs)).

---

## Unit Testing with `Test.createTestingModule`

`Test.createTestingModule(metadata, options?)` creates an isolated `TestingModuleBuilder` backed by Bunest's real `ModuleScanner`, `DIContainer`, and `LifecycleManager`:

@@filename(users.service.spec.ts)

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Test, type TestingModule } from "@bunest/testing";
import { UsersController } from "./users.controller";
import { UsersRepository } from "./users.repository";
import { UsersService } from "./users.service";

describe("UsersController", () => {
  let moduleRef: TestingModule;
  let controller: UsersController;
  let service: UsersService;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        UsersService,
        {
          provide: UsersRepository,
          useValue: {
            findAll: () => [{ id: "u_1", name: "Alice" }],
          },
        },
      ],
    }).compile();

    controller = moduleRef.get(UsersController);
    service = moduleRef.get(UsersService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it("returns users from UsersService", () => {
    expect(controller.findAll()).toEqual([{ id: "u_1", name: "Alice" }]);
    expect(service.count()).toBe(1);
  });
});
```

### Overriding Providers

When importing an existing feature module or `AppModule`, replace any provider token (class, `string`, or `symbol`) before `compile()` using `overrideProvider(token)` with `useValue`, `useClass`, `useFactory`, or `useExisting`:

@@filename(overrides.spec.ts)

```ts
import { describe, expect, it } from "bun:test";
import { Scope } from "@bunest/core";
import { Test } from "@bunest/testing";
import { UsersModule } from "./users.module";
import { UsersRepository } from "./users.repository";
import { UsersService } from "./users.service";
import { CONFIG_TOKEN } from "./config.tokens";

describe("Provider overrides", () => {
  it("supports useValue, useClass, useFactory, and useExisting", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UsersModule],
    })
      // Replace with a mock object (also supports explicit `useValue(null)` / `useValue(undefined)`)
      .overrideProvider(CONFIG_TOKEN)
      .useValue({ apiPrefix: "test" })
      // Replace with a class (inherits @Injectable scope & lifecycle hooks; optional explicit scope)
      .overrideProvider(UsersRepository)
      .useClass(InMemoryUsersRepository, Scope.SINGLETON)
      .compile();

    expect(moduleRef.get(UsersService).list()).toEqual([]);
    await moduleRef.close();
  });

  it("supports async useFactory overrides with injected tokens", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UsersModule],
    })
      .overrideProvider(UsersRepository)
      .useFactory({
        factory: async (cfg: { apiPrefix: string }) => ({
          findAll: () => [`${cfg.apiPrefix}:alice`],
        }),
        inject: [CONFIG_TOKEN],
      })
      .compile();

    expect(moduleRef.get(UsersService).list()).toEqual(["prod:alice"]);
    await moduleRef.close();
  });
});
```

> tip **Edge-Case Semantics** `overrideProvider(Token).useValue(undefined)` and `.useValue(null)` short-circuit cleanly without instantiating the original class. `overrideProvider(Token).useClass(MockClass)` inherits `MockClass`'s `@Injectable({ scope })` metadata and executes its lifecycle hooks (`onModuleInit`, `onModuleDestroy`, etc.), even when replacing a `useValue` or `useExisting` provider.

### Overriding Guards, Pipes, Interceptors & Exception Filters

Swap route-level (`@UseGuards`, `@UsePipes`, `@UseInterceptors`, `@UseFilters`), DI global (`APP_GUARD`, `APP_PIPE`, `APP_INTERCEPTOR`, `APP_FILTER`), or imperative (`app.useGlobal*`) enhancers using `overrideGuard`, `overridePipe`, `overrideInterceptor`, and `overrideFilter`:

@@filename(enhancer-overrides.spec.ts)

```ts
import { describe, expect, it } from "bun:test";
import { Test, request } from "@bunest/testing";
import { AppModule } from "./app.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { DomainErrorFilter } from "./filters/domain-error.filter";
import { AuditInterceptor } from "./interceptors/audit.interceptor";
import { TrimPipe } from "./pipes/trim.pipe";

describe("Enhancer overrides", () => {
  it("overrides guards, pipes, interceptors, and exception filters cleanly", async () => {
    const ALLOW_FLAG = Symbol("ALLOW_FLAG");

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      providers: [{ provide: ALLOW_FLAG, useValue: true }],
    })
      .overrideGuard(JwtAuthGuard)
      .useFactory({
        factory: (allow: boolean) => ({ canActivate: () => allow }),
        inject: [ALLOW_FLAG],
      })
      .overridePipe(TrimPipe)
      .useValue({ transform: (v: unknown) => v })
      .overrideInterceptor(AuditInterceptor)
      .useValue({
        intercept: async (_ctx, next) => ({
          audited: false,
          data: await next.handle(),
        }),
      })
      .overrideFilter(DomainErrorFilter)
      .useValue({
        catch: (err: Error) =>
          Response.json({ mockedError: err.message }, { status: 400 }),
      })
      .compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    await request(app).get("/protected").expect(200);
    await app.close();
  });
});
```

Key guarantees for enhancer overrides in Bunest:

- **Full `useValue` / `useClass` / `useFactory` / `useExisting` support** across decorator-level `@Use*`, `APP_*` multi-providers, and imperative `app.useGlobal*()`.
- **Module-private DI visibility:** `useFactory` / `useExisting` overrides on module-owned enhancers resolve `inject` tokens inside the enhancer's declaring module (falling back to the testing root module).
- **`@Catch(...)` preservation:** `overrideFilter(TypedFilter).useValue(...)` and `.useFactory(...)` preserve `TypedFilter`'s `@Catch(...)` exception types automatically so a typed filter never silently becomes a catch-all. Using `.useClass(ReplacementFilter)` honors `ReplacementFilter`'s own `@Catch(...)` metadata.
- **Kind & provider isolation:** Overriding a class via `overrideProvider(X)` and `overrideGuard(X)` (or `overridePipe(X)`) tracks them in separate override maps so they never clobber one another, and `overrideGuard(GuardClass).useValue(...)` skips dependency/scope-leak validation on the bypassed original class.

### Overriding Entire Modules (`overrideModule`)

Replace an imported static module, nested module, `@Global()` module, `forwardRef()` circular module, or `DynamicModule` before module scanning with `overrideModule(target).useModule(replacement)`:

@@filename(override-module.spec.ts)

```ts
import { Module } from "@bunest/core";
import { Test } from "@bunest/testing";
import { AppModule } from "./app.module";
import { DatabaseModule, DatabaseService } from "./database.module";

@Module({
  providers: [
    {
      provide: DatabaseService,
      useValue: { query: async () => [{ id: 1, mock: true }] },
    },
  ],
  exports: [DatabaseService],
})
class FakeDatabaseModule {}

const moduleRef = await Test.createTestingModule({
  imports: [AppModule],
})
  .overrideModule(DatabaseModule)
  .useModule(FakeDatabaseModule)
  .compile();
```

`overrideModule()` also matches exact `DynamicModule` references first and falls back to matching `dynamicModule.module`, making it straightforward to swap `ConfigModule.forRoot(...)` or `DatabaseModule.forRootAsync(...)`.

---

## Auto-Mocking with `useMocker` & `createAutoMocker`

Instead of manually mocking every transitive dependency in a unit test, register a fallback `MockFactory` via `.useMocker(factory)` or use Bunest's zero-dependency `createAutoMocker()` / `ModuleMocker`:

@@filename(orders.service.spec.ts)

```ts
import { describe, expect, it } from "bun:test";
import { Test, createAutoMocker, type MockFunction } from "@bunest/testing";
import { InventoryClient } from "./inventory.client";
import { OrdersService } from "./orders.service";
import { PaymentGateway } from "./payment.gateway";

describe("OrdersService (auto-mocked)", () => {
  it("auto-mocks missing class dependencies as reusable spy instances", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrdersService],
    })
      .useMocker(
        createAutoMocker({
          // Optional explicit mocks checked before automatic class stubbing
          overrides: [[PaymentGateway, { charge: async () => ({ ok: true }) }]],
        }),
      )
      .compile();

    const orders = moduleRef.get(OrdersService);
    const inventory = moduleRef.get(InventoryClient) as unknown as {
      reserve: MockFunction;
    };
    inventory.reserve.mockResolvedValue(true);

    const receipt = await orders.placeOrder("sku-1", 2);
    expect(receipt.ok).toBe(true);
    expect(inventory.reserve.callCount).toBe(1);
    expect(inventory.reserve.calls[0]).toEqual(["sku-1", 2]);

    await moduleRef.close();
  });
});
```

You can also drive `ModuleMocker` and `createMockFn()` directly inside a custom `useMocker((token) => ...)` factory (mirroring NestJS's `useMocker` pattern without installing `jest-mock`):

@@filename(custom-mocker.spec.ts)

```ts
import { ModuleMocker, Test } from "@bunest/testing";

const moduleMocker = new ModuleMocker();

const moduleRef = await Test.createTestingModule({
  providers: [OrdersService],
})
  .useMocker((token) => {
    if (token === "CACHE_TTL") {
      return 60;
    }
    if (typeof token === "function") {
      const metadata = moduleMocker.getMetadata(token);
      if (metadata) {
        const Mock = moduleMocker.generateFromMetadata(
          metadata,
        ) as new () => object;
        return new Mock();
      }
    }
    // Returning undefined/null rethrows UnknownDependencyException
    return undefined;
  })
  .compile();
```

| `useMocker` Behavior                     | Detail                                                                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shared cache**                         | Each auto-mocked token is generated once and shared across all consumers (`SINGLETON`, `TRANSIENT`, and `REQUEST`), and is retrievable via `moduleRef.get(Token)` / `moduleRef.resolve(Token)`.                                    |
| **Strict failure on `null`/`undefined`** | If the factory returns `undefined` or `null`, Bunest throws the original `UnknownDependencyException`.                                                                                                                             |
| **Respects `@Optional()` & built-ins**   | `@Optional()` dependencies remain `undefined`; built-in `REQUEST` and `REQUEST_CONTEXT` tokens are never auto-mocked.                                                                                                              |
| **Non-class tokens**                     | Pass `createAutoMocker({ mockUnregisteredTokens: true })` to return a lazy spy `Proxy` for unregistered string/symbol tokens.                                                                                                      |
| **Spy API (`MockFunction`)**             | Every auto-mocked method exposes `.calls`, `.results`, `.callCount`, `.called`, `.mockReturnValue(Once)`, `.mockResolvedValue(Once)`, `.mockRejectedValue(Once)`, `.mockImplementation(Once)`, `.mockClear()`, and `.mockReset()`. |

---

## Strict Lookups (`select`), `{ each: true }` & `Scope.REQUEST` Testing

### Navigating Modules with `select()`

Use `moduleRef.select(TargetModule)` to enforce strict module encapsulation ([ADR-007](/architecture/adrs)). `select()` is chainable and accepts both static module classes and `DynamicModule` instances:

@@filename(select.spec.ts)

```ts
// Strict lookup inside SecretModule (sees private providers of SecretModule only)
const secretService = moduleRef.select(SecretModule).get(PrivateSecretService);

// Chainable navigation across modules
const repo = moduleRef
  .select(BillingModule)
  .select(LedgerModule)
  .get(LedgerRepo);

// Retrieve every registration of a token across modules using `{ each: true }`
const allPlugins = moduleRef.get(PLUGIN_TOKEN, { strict: false, each: true });
```

### Unit-Testing `Scope.REQUEST` Providers Without HTTP (`ContextIdFactory`)

In NestJS-style tests, generate a synthetic `ContextId` with `ContextIdFactory.create()`, bind a mock `Request` via `registerRequestByContextId()`, and resolve `Scope.REQUEST` providers directly—no HTTP server required:

@@filename(tenant.service.spec.ts)

```ts
import { describe, expect, it } from "bun:test";
import { ContextIdFactory, Test, createMockRequest } from "@bunest/testing";
import { TenantContext, TenantService } from "./tenant.service";

describe("TenantService (Scope.REQUEST)", () => {
  it("isolates request-scoped instances per ContextId", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [TenantContext, TenantService],
    }).compile();

    const ctxA = ContextIdFactory.create();
    const ctxB = ContextIdFactory.create();

    moduleRef.registerRequestByContextId(
      createMockRequest("/orders", { headers: { "x-tenant-id": "acme" } }),
      ctxA,
    );
    moduleRef.registerRequestByContextId(
      createMockRequest("/orders", { headers: { "x-tenant-id": "globex" } }),
      ctxB,
    );

    const [svcA1, svcA2, svcB] = await Promise.all([
      moduleRef.resolve(TenantService, ctxA),
      moduleRef.resolve(TenantService, ctxA),
      moduleRef.resolve(TenantService, ctxB),
    ]);

    // Shared within the same ContextId, isolated across ContextIds
    expect(svcA1).toBe(svcA2);
    expect(svcA1).not.toBe(svcB);
    expect(svcA1.getTenantId()).toBe("acme");
    expect(svcB.getTenantId()).toBe("globex");

    // Calling close() automatically destroys all registered ContextId containers
    await moduleRef.close();
  });
});
```

You can also construct a standalone `RequestContainer` with `moduleRef.createRequestContainer(req)` and pass it to `moduleRef.resolve(Token, reqContainer)` when testing `OnRequestDestroy` cleanup directly.

---

## Testing Loggers (`TestingLogger` & `CapturingLogger`)

By default, `TestingModuleBuilder.compile()` attaches a **`TestingLogger`**, which suppresses noisy `log`, `warn`, `debug`, and `verbose` output during test runs while still printing `error` and `fatal` diagnostics.

To assert on emitted logs cleanly without polluting stdout/stderr, pass **`CapturingLogger`** via `.setLogger(logger)` / `moduleRef.useLogger(logger)` (for framework & `DefaultExceptionFilter` logs) and/or inject it into your services via `overrideProvider`:

@@filename(logging.spec.ts)

```ts
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  type LoggerService,
} from "@bunest/core";
import { CapturingLogger, Test, request } from "@bunest/testing";

const APP_LOGGER = Symbol("APP_LOGGER");

@Injectable()
class BillingService {
  constructor(@Inject(APP_LOGGER) private readonly logger: LoggerService) {}

  charge(cents: number) {
    this.logger.log(`Charged ${cents}`, "BillingService");
  }
}

@Controller("/billing")
class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get("charge")
  run() {
    this.billing.charge(4900);
    return { ok: true };
  }

  @Get("crash")
  crash(): never {
    throw new Error("gateway timeout");
  }
}

describe("CapturingLogger assertions", () => {
  it("captures DI service logs and unhandled DefaultExceptionFilter errors", async () => {
    const logger = new CapturingLogger({ print: false });

    const moduleRef = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [BillingService, { provide: APP_LOGGER, useValue: logger }],
    })
      // Routes TestingModule, BunestApplication, BunHttpAdapter & DefaultExceptionFilter logs here
      .setLogger(logger)
      .compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    await request(app).get("/billing/charge").expect(200);
    await request(app).get("/billing/crash").expect(500);

    logger.assertLogged(/Charged 4900/, "log");
    logger.assertLogged("gateway timeout", "error");
    logger.assertNotLogged("payment failed", "warn");
    expect(
      logger.filter({ level: "log", context: "BillingService" }),
    ).toHaveLength(1);

    logger.clear();
    await app.close();
  });
});
```

> info **Framework Logger vs Standalone `new Logger()`** `.setLogger(logger)` and `moduleRef.useLogger(logger)` configure the framework logger used by `TestingModule`, `BunestApplication`, `BunHttpAdapter`, and `DefaultExceptionFilter` (accessible via `app.getLogger()`). Standalone `new Logger("MyService")` instances write directly through their own `writer` (`console` by default)—to capture service logs in tests, inject a `LoggerService` token (as above) or use static `Logger.log()` with `Logger.overrideLogger(logger)`.

`TestingModule` also supports `bufferLogs: true` + `moduleRef.useLogger(customLogger)` + `moduleRef.flushLogs()`, propagating logger updates to both `BunHttpAdapter` and `DefaultExceptionFilter`.

---

## End-to-End (E2E) HTTP Testing

`@bunest/testing` gives you **three complementary E2E modes** sharing the exact same compiled 11-stage HTTP pipeline ([ADR-008](/architecture/execution-pipeline)):

1. **Zero-socket in-memory dispatch (recommended default):** `request(app)`, `request.agent(app)`, `TestClient`, or `app.inject()` — dispatches straight into `BunestApplication.fetch()` with **no TCP port binding**, microsecond latency, and full middleware/guards/pipes/interceptors/filters/CORS/serialization fidelity.
2. **Live ephemeral port (`app.listen(0)`):** `TestClient.fromUrl(info.url)` or `request(info.url)` / `request(app.getHttpServer())` — exercises real `Bun.serve({ routes })` sockets on an OS-assigned port (`port: 0`, [ADR-011](/architecture/hybrid-router)) for WebSockets, live SSE disconnects, and real network behavior.
3. **Optional Node HTTP bridge (`createNodeHttpServer(app)`):** wraps any Bunest app in a Node `http.Server` (exclusively inside `@bunest/testing`) for teams migrating existing npm `supertest` suites incrementally.

### 1. Zero-Socket Supertest-Style `request(app)` & `request.agent(app)`

`request(app)` provides a chainable, Supertest-compatible fluent API implementing `PromiseLike<SupertestResponse>`—zero sockets, zero npm `supertest` dependency:

@@filename(test/accounts.e2e.spec.ts)

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe, type BunestApplication } from "@bunest/core";
import { Test, request } from "@bunest/testing";
import { AccountsModule } from "../src/accounts/accounts.module";

describe("Accounts E2E (in-memory Supertest-style)", () => {
  let app: BunestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AccountsModule],
    }).compile();

    // `createNestApplication()` is a first-class alias for `createBunestApplication()`
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /accounts validates DTOs and strips @Exclude() fields", async () => {
    const res = await request(app)
      .post("/accounts")
      .set("X-Trace-Id", "trace-1")
      .send({
        email: "alice@example.com",
        password: "super-secret-password",
        name: "Alice",
      })
      .expect(201)
      .expect("content-type", /application\/json/);

    expect(res.body).toEqual({
      id: "acc_1",
      email: "alice@example.com",
      name: "Alice",
    });
    expect("password" in res.body).toBe(false);
  });

  it("rejects invalid DTO payloads with normalized ADR-009 400 JSON", async () => {
    await request(app)
      .post("/accounts")
      .send({ email: "invalid", name: "A", extraField: true })
      .expect(400)
      .expect((res) => {
        expect(res.body.message).toBe("Validation failed");
        expect(
          res.body.details.map((d: { field: string }) => d.field),
        ).toContain("extraField");
      });
  });

  it("persists session cookies across requests via request.agent(app)", async () => {
    const agent = request.agent(app);

    // Server sets `Set-Cookie: sid=sess_42; HttpOnly; Path=/`
    await agent
      .post("/auth/login")
      .send({ email: "alice@example.com" })
      .expect(200);

    // Cookie jar automatically sends `Cookie: sid=sess_42` on subsequent requests
    await agent.get("/auth/me").expect(200, { email: "alice@example.com" });
    expect(agent.getCookies().sid).toBe("sess_42");
  });
});
```

Supported `request(app)` (`SupertestAgent` & `SupertestRequest`) methods:

- **`SupertestAgent` entrypoints & defaults:** `.get()`, `.post()`, `.put()`, `.patch()`, `.delete()`, `.head()`, `.options()`, `.request(method, path)`, plus agent-wide `.set()`, `.unset()`, `.auth()`, `.withCookies()`, `.getCookies()`, `.setCookie()`, `.clearCookies()`
- **`SupertestRequest` headers & auth:** `.set(name, value)`, `.set(record)`, `.unset(name)`, `.auth(user, pass)`, `.auth(token, { type: "bearer" })`, `.type("json" | "form" | mime)`, `.accept(mime)`
- **`SupertestRequest` payloads & params:** `.query(params)`, `.cookies(record)`, `.send(body)`, `.field(name, value)`, `.attach(field, data, filename?, contentType?)`
- **`SupertestRequest` controls:** `.redirects(n)` _(defaults to `0` / manual so `301`/`302` `Location` headers can be asserted directly)_, `.timeout(ms)`
- **`SupertestRequest` chainable assertions:** `.expect(status)`, `.expect(status, body)`, `.expect(headerName, string | RegExp)`, `.expect(bodyOrRegExp)`, `.expect((res) => ...)`

### 2. Web-Standard `TestClient`, `TestAgent` & Fastify-Style `app.inject()`

Prefer explicit Web-Standard `TestResponse` objects or Fastify-style `app.inject()`? Both are built right in:

@@filename(test-client-and-inject.e2e.spec.ts)
@@tab(TestClient & TestAgent)

```ts
const moduleRef = await Test.createTestingModule({
  imports: [AccountsModule],
}).compile();

const app = moduleRef.createBunestApplication();
app.useGlobalPipes(new ValidationPipe());

const client = moduleRef.createTestClient(app);

const res = await client
  .withBearerToken("jwt-token")
  .withCookies({ theme: "dark" })
  .get("/accounts/search", { query: { tag: ["bun", "ts"] } });

res
  .expectStatus(200)
  .expectHeader("content-type", /application\/json/)
  .expectNoHeader("x-powered-by");

await res.expectJson({ tag: ["bun", "ts"] });

// Stateful cookie-jar agent
const agent = client.agent();
await agent.post("/auth/login", { json: { email: "alice@example.com" } });
(await agent.get("/auth/me")).expectStatus(200);

await moduleRef.close();
```

@@switch
@@tab(app.inject())

```ts
const moduleRef = await Test.createTestingModule({
  imports: [AccountsModule],
}).compile();

const app = moduleRef.createNestApplication();
app.useGlobalPipes(new ValidationPipe());
await app.init();

const res = await app.inject({
  method: "POST",
  url: "/accounts",
  headers: { "x-trace-id": "trace-1" },
  query: { notify: "false" },
  payload: {
    email: "alice@example.com",
    password: "super-secret-password",
    name: "Alice",
  },
});

expect(res.statusCode).toBe(201);
expect(res.json<{ email: string }>().email).toBe("alice@example.com");

await app.close();
```

> info **Shared `LifecycleManager` & Clean Teardown** `TestingModule` and every `BunestApplication` created from it share a single `LifecycleManager`. Calling `await app.init()` followed by `await moduleRef.init()`, or `await app.close()` followed by `await moduleRef.close()`, is strictly idempotent—lifecycle hooks (`onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`, `beforeApplicationShutdown`, `onApplicationShutdown`) never double-fire and `enableShutdownHooks()` never leaks `SIGINT`/`SIGTERM` listeners.

### 3. Live Ephemeral-Port Testing (`app.listen(0)`)

When testing real TCP sockets, WebSocket upgrades, or live `Bun.serve({ routes })` routing, bind an OS-assigned ephemeral port with `await app.listen(0)` (conflict-free across parallel `bun test` files) and point `TestClient.fromUrl(info.url)` or `request(app.getHttpServer())` at it:

@@filename(live-server.e2e.spec.ts)

```ts
import { describe, expect, it } from "bun:test";
import { Test, TestClient, request } from "@bunest/testing";
import { AppModule } from "../src/app.module";

describe("Live Bun.serve({ port: 0 }) E2E", () => {
  it("handles real HTTP requests and preserves manual redirect parity", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    const info = await app.listen(0);

    try {
      // Both TestClient.fromUrl() and request(info.url) default to redirect: "manual"
      const liveClient = TestClient.fromUrl(info.url);
      const redir = await liveClient.get("/legacy-docs");
      redir.expectStatus(302).expectHeader("location", "/docs");

      // request() also accepts app.getHttpServer() directly!
      await request(app.getHttpServer()!)
        .get("/health")
        .expect(200)
        .expect({ status: "ok" });
    } finally {
      await moduleRef.close();
    }
  });
});
```

### 4. Multipart Uploads & Server-Sent Events (SSE)

Test multipart file uploads with `.field()` + `.attach()` (or `FormData`), and consume `@Sse()` streams with `readSseEvents()` + `parseSseJson()`—automatically canceling the stream reader and triggering upstream generator cleanup once `maxEvents`, `signal`, or `timeoutMs` fires:

@@filename(multipart-and-sse.e2e.spec.ts)
@@tab(Multipart Upload)

```ts
import { request } from "@bunest/testing";

const res = await request(app)
  .post("/files/upload")
  .field("album", "avatars")
  .attach(
    "avatar",
    new Uint8Array([1, 2, 3, 4]),
    "avatar.bin",
    "application/octet-stream",
  )
  .expect(201);

expect(res.body).toEqual({
  album: "avatars",
  fieldname: "avatar",
  originalname: "avatar.bin",
  size: 4,
});
```

@@switch
@@tab(SSE Streaming)

```ts
import { TestClient, parseSseJson, readSseEvents } from "@bunest/testing";

const client = TestClient.fromApp(app);
const res = await client.get("/events/stream");

res.expectStatus(200).expectHeader("content-type", /text\/event-stream/);

// Reads 2 events and cancels the reader (triggering generator `finally` cleanup)
const events = await readSseEvents(res, {
  maxEvents: 2,
  timeoutMs: 2000,
});

expect(events).toHaveLength(2);
expect(events[0]?.event).toBe("tick");
expect(parseSseJson<{ count: number }>(events[0]!)).toEqual({ count: 1 });
```

### 5. Optional Legacy `supertest` Bridge (`createNodeHttpServer`)

If you are migrating an existing NestJS repository that imports npm `supertest` directly, `@bunest/testing` provides `createNodeHttpServer(app)` to adapt any `BunestApplication` (`FetchCapable`) to a standard Node `http.Server`—preserving binary streams, abort cancellation, and multiple `Set-Cookie` headers:

@@filename(legacy-supertest.e2e.spec.ts)

```ts
import supertest from "supertest";
import { Test, createNodeHttpServer } from "@bunest/testing";
import { AppModule } from "../src/app.module";

const moduleRef = await Test.createTestingModule({
  imports: [AppModule],
}).compile();

const app = moduleRef.createNestApplication();
await app.init();

const nodeServer = createNodeHttpServer(app);
try {
  await supertest(nodeServer).get("/health").expect(200, { status: "ok" });
} finally {
  nodeServer.close();
  await app.close();
}
```

> warning **Architectural Boundary (ADR-001 / ADR-017)** `createNodeHttpServer()` in `@bunest/testing` runs natively on `Bun.serve({ port: 0 })` (zero `node:http`!). For new tests, prefer Bunest's built-in `request(app)` or `TestClient`, which run zero-socket in memory without opening a TCP port.

---

## Isolated Unit-Test Fixtures

For testing guards, interceptors, middleware, exception filters, and ambient `RequestContext` helpers in pure isolation without compiling a module:

| Fixture                                           | Purpose                                                                                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMockRequest(pathOrUrl?, options?)`         | Builds a native Web `Request` with `method`, `baseUrl`, `query`, `headers`, `cookies`, `json`, `body`, `formData`, and `signal`.                                                         |
| `createMockResponseContext()`                     | Returns a fresh `HttpResponseContext` for inspecting status, headers, and `Set-Cookie` mutations.                                                                                        |
| `createMockExecutionContext(options?)`            | Constructs an `ExecutionContext` (`HttpExecutionContext` for HTTP; cleanly isolated `ws: { client, data, pattern }` and `rpc: { data, context }` payloads without leaking HTTP objects). |
| `createMockCallHandler(valueOrFactory)`           | Builds a `CallHandler` spy exposing `.called` and `.callCount` to verify passthrough vs short-circuit interceptors.                                                                      |
| `createMockProvider(token, partialValue)`         | Typed shorthand for `{ provide: token, useValue: partialValue as T }`.                                                                                                                   |
| `createMockLogger(options?)`                      | Returns a `CapturingLogger` ready for log assertions.                                                                                                                                    |
| `createMockReflector(overrides?)`                 | Returns a real `Reflector` with optional method overrides.                                                                                                                               |
| `runWithMockRequestContext(reqOrPath, fn, opts?)` | Executes `fn(ctx)` inside an active `AsyncLocalStorage` `RequestContext` so code calling `getCurrentRequestContext()` works in isolation.                                                |

@@filename(roles.guard.spec.ts)

```ts
import { describe, expect, it } from "bun:test";
import {
  createMockCallHandler,
  createMockExecutionContext,
  createMockReflector,
  createMockRequest,
  runWithMockRequestContext,
} from "@bunest/testing";
import { getCurrentRequestContext } from "@bunest/core/http";
import { RolesGuard } from "./roles.guard";
import { TimingInterceptor } from "./timing.interceptor";
import { AdminController } from "./admin.controller";

describe("Isolated enhancer fixtures", () => {
  it("unit-tests a guard with createMockExecutionContext & createMockReflector", () => {
    const guard = new RolesGuard(createMockReflector());

    const ctx = createMockExecutionContext({
      controllerClass: AdminController,
      handlerKey: "deleteUser",
      request: createMockRequest("/admin/users/1", {
        method: "DELETE",
        headers: { "x-role": "admin" },
      }),
    });

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("tracks CallHandler invocations and supports WS/RPC contexts cleanly", async () => {
    const wsCtx = createMockExecutionContext({
      contextType: "ws",
      ws: {
        client: { id: "sock_1" },
        data: { room: "general" },
        pattern: "join",
      },
    });
    expect(wsCtx.getType()).toBe("ws");
    expect(wsCtx.switchToWs().getPattern()).toBe("join");

    const next = createMockCallHandler(async () => ({ ok: true }));
    const interceptor = new TimingInterceptor();
    await interceptor.intercept(createMockExecutionContext(), next);
    expect(next.called).toBe(true);
    expect(next.callCount).toBe(1);
  });

  it("tests ambient AsyncLocalStorage RequestContext with runWithMockRequestContext", async () => {
    const trace = await runWithMockRequestContext(
      "/orders/42",
      () => getCurrentRequestContext()?.request.headers.get("x-trace-id"),
      { headers: { "x-trace-id": "req-99" } },
    );
    expect(trace).toBe("req-99");
  });
});
```

---

## NestJS `@nestjs/testing` Parity & Differences

Official `@nestjs/testing` cannot be imported directly into a Bunest project because it couples directly to `@nestjs/core`'s internal `NestContainer`/`TestingInjector`, Express/Fastify HTTP adapters, Node `http.Server`, and RxJS `Observable` pipelines. Instead, `@bunest/testing` implements a **1-to-1 Bun-native equivalent** covering the full `@nestjs/testing` surface:

| Capability             | NestJS (`@nestjs/testing` + Jest + Supertest)                                   | Bunest (`@bunest/testing` + `bun:test`)                                                              |
| ---------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Test runner**        | Jest / Vitest (`jest.fn()`, `jest-mock`)                                        | Native **`bun:test`** (`*.spec.ts` / `*.e2e.spec.ts`) + zero-dep `createMockFn()` / `ModuleMocker`   |
| **Module builder**     | `Test.createTestingModule(meta, opts?)`                                         | `Test.createTestingModule(meta, opts?)`                                                              |
| **DI overrides**       | `overrideProvider` (`useValue`, `useClass`, `useFactory`)                       | `overrideProvider` (`useValue`, `useClass`, `useFactory`, **`useExisting`**)                         |
| **Enhancer overrides** | `overrideGuard` / `Pipe` / `Interceptor` / `Filter`                             | `overrideGuard` / `Pipe` / `Interceptor` / `Filter` (full `APP_*` & `@Use*` + `@Catch` preservation) |
| **Module overrides**   | `overrideModule(Mod).useModule(Mock)`                                           | `overrideModule(Mod).useModule(Mock)` (static, `@Global()`, `DynamicModule`, `forwardRef`)           |
| **Auto-mocking**       | `.useMocker(token => ...)` + external `jest-mock` `ModuleMocker`                | `.useMocker(createAutoMocker())` + built-in zero-dep `ModuleMocker`                                  |
| **Loggers**            | `TestingLogger`, `CapturingLogger` (v12), `setLogger`, `useLogger`, `flushLogs` | `TestingLogger`, `CapturingLogger`, `setLogger`, `useLogger`, `flushLogs`                            |
| **App creation**       | `moduleRef.createNestApplication()`                                             | `moduleRef.createNestApplication()` **and** `moduleRef.createBunestApplication()`                    |
| **Scoped lookups**     | `select(Mod)`, `get(tok, { strict, each })`, `resolve(tok, ctxId, opts)`        | `select(Mod)` (chainable + `DynamicModule`), `get` / `resolve` with `{ strict, each }`               |
| **Request scope DI**   | `ContextIdFactory.create()` + `registerRequestByContextId()`                    | `ContextIdFactory.create()` + `registerRequestByContextId()` + `createRequestContainer()`            |
| **In-memory E2E**      | `supertest(app.getHttpServer())` (Node socket) or Fastify `app.inject()`        | **Zero-socket** `request(app)`, `request.agent(app)`, `TestClient`, **and** `app.inject()`           |
| **Live HTTP / WS**     | `await app.listen(0)` + `app.getUrl()`                                          | `await app.listen(0)` + `TestClient.fromUrl(info.url)` / `request(app.getHttpServer())`              |
| **Legacy Supertest**   | Native via Node `http.Server`                                                   | Optional `supertest(createNodeHttpServer(app))` bridge                                               |
| **SSE & Multipart**    | Manual stream parsing / Multer                                                  | Built-in `readSseEvents()`, `parseSseJson()`, and `.field()` + `.attach()`                           |
| **Interceptors**       | RxJS `Observable` (`of(...)`)                                                   | Native `Promise` (`createMockCallHandler(() => ...)`)                                                |

> tip **Coming from NestJS?** See the [Migration from NestJS](/architecture/migration-from-nestjs) guide for side-by-side Jest/Supertest-to-Bunest conversions and a full migration checklist.
