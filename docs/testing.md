# Testing Guide

`@bunest/testing` integrates natively with `bun:test` for fast unit, integration, and E2E testing—supporting DI/enhancer/module overrides, zero-dependency auto-mocking, zero-socket HTTP dispatch, supertest-style fluent assertions, SSE stream testing, and structured log capture.

---

## 1. Unit Testing Services with `Test.createTestingModule`

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { UsersService } from "../src/users/users.service";
import { UsersRepository } from "../src/users/users.repository";

describe("UsersService", () => {
  it("resolves providers with mocked repository", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, UsersRepository],
    })
      .overrideProvider(UsersRepository)
      .useValue({
        findById: async (id: string) => ({ id, name: "Ada" }),
      })
      .compile();

    const service = moduleRef.get(UsersService);
    expect(await service.findOne("u_1")).toEqual({ id: "u_1", name: "Ada" });

    await moduleRef.close();
  });
});
```

### Supported Overrides on `TestingModuleBuilder`

| Method                       | Override Modes                                                  | Use Case                                           |
| ---------------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| `.overrideProvider(token)`   | `.useValue()`, `.useClass()`, `.useFactory()`, `.useExisting()` | Swap services, DB clients, config tokens           |
| `.overrideGuard(GuardClass)` | `.useValue()`, `.useClass()`, `.useFactory()`, `.useExisting()` | Bypass auth/role guards in controller tests        |
| `.overridePipe(PipeClass)`   | `.useValue()`, `.useClass()`, `.useFactory()`, `.useExisting()` | Stub custom transformation pipes                   |
| `.overrideInterceptor(Cls)`  | `.useValue()`, `.useClass()`, `.useFactory()`, `.useExisting()` | Disable caching/tracing interceptors in unit tests |
| `.overrideFilter(FilterCls)` | `.useValue()`, `.useClass()`, `.useFactory()`, `.useExisting()` | Inspect raw exceptions or swap custom filters      |
| `.overrideModule(Mod)`       | `.useModule(ReplacementMod)`                                    | Swap an entire feature or dynamic module           |

Use `moduleRef.select(TargetModule).get(Token)` to test strict module visibility ([ADR-007](./adr/ADR-007.md)).

---

## 2. Auto-Mocking with `ModuleMocker` & `createAutoMocker()`

Avoid manually listing mock providers for every transitive dependency by plugging `createAutoMocker()` into `.useMocker()`:

```ts
import { describe, expect, it } from "bun:test";
import {
  Test,
  createAutoMocker,
  createMockFn,
  type MockFunction,
} from "@bunest/testing";
import { OrdersService } from "../src/orders/orders.service";
import { PaymentGateway } from "../src/payments/payment.gateway";

describe("OrdersService (auto-mocked)", () => {
  it("auto-mocks unregistered class dependencies", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrdersService],
    })
      .useMocker(createAutoMocker())
      .compile();

    const orders = moduleRef.get(OrdersService);
    const payments = moduleRef.get(PaymentGateway) as unknown as {
      charge: MockFunction;
    };
    payments.charge.mockResolvedValue({ ok: true, txId: "tx_42" });

    const receipt = await orders.checkout("u_1", 1999);
    expect(receipt.txId).toBe("tx_42");
    expect(payments.charge.callCount).toBe(1);

    await moduleRef.close();
  });
});
```

- Pass `{ overrides: [[TOKEN, customMock]], mockUnregisteredTokens: true }` to `createAutoMocker()` when you also want unregistered string/symbol tokens auto-proxied.
- Use standalone `createMockFn()` for lightweight spies with `.mockReturnValue()`, `.mockResolvedValue()`, `.mockRejectedValue()`, `.mockImplementationOnce()`, `.calls`, and `.callCount`.

---

## 3. HTTP Integration & E2E Testing

Bunest provides **three** ergonomic ways to exercise the full 11-stage HTTP pipeline (`Middleware -> Guards -> Interceptors -> Param Extraction -> Pipes -> Handler -> Serialization -> Exception Filters`):

### Option A: Supertest-Compatible `request(app)` (In-Memory — Zero Sockets)

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe, type BunestApplication } from "@bunest/core";
import { Test, request } from "@bunest/testing";
import { AppModule } from "../src/app.module";

describe("API E2E", () => {
  let app: BunestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createBunestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /users returns 201 and sets JSON body", async () => {
    const res = await request(app)
      .post("/users")
      .set("X-Request-Id", "req-1")
      .send({ email: "ada@bunest.dev", name: "Ada" })
      .expect(201)
      .expect("content-type", /application\/json/);

    expect(res.body.email).toBe("ada@bunest.dev");
  });
});
```

- Use `request.agent(app)` (`SupertestAgent`) to persist `Set-Cookie` headers across login -> authenticated requests automatically.

### Option B: Native `TestClient` & `TestAgent`

```ts
const client = moduleRef.createTestClient(app);
const authed = client.withBearerToken(accessToken);

const res = await authed.get("/users/u_1");
res.expectStatus(200).expectHeader("content-type", /json/);
await res.expectJson((body: { name: string }) => body.name === "Ada");
```

### Option C: Zero-Dependency `app.inject()` / `app.fetch()`

```ts
const res = await app.inject({
  method: "POST",
  url: "/users",
  payload: { email: "ada@bunest.dev", name: "Ada" },
});
expect(res.statusCode).toBe(201);
expect(res.json()).toMatchObject({ email: "ada@bunest.dev" });
```

### Live Ephemeral Port Testing (`port: 0`)

Use live `app.listen(0)` when testing real network sockets, `WebSocket` clients, or raw `fetch()` against `Bun.serve({ routes })`:

```ts
await app.listen(0);
const baseUrl = app.getUrl(); // e.g., "http://127.0.0.1:54321"
const res = await fetch(`${baseUrl}/users`);
expect(res.status).toBe(200);
// Live `request(baseUrl)` also works against the listening server!
```

> Always call `await app.close()` (or `await moduleRef.close()`) in `afterAll`/`afterEach` so servers, timers, SQLite handles, and WebSockets tear down cleanly.

---

## 4. Testing Request-Scoped Providers (`ContextIdFactory` & `RequestContainer`)

```ts
import { ContextIdFactory } from "@bunest/testing";

const contextId = ContextIdFactory.create();
moduleRef.registerRequestByContextId(
  new Request("http://localhost/tenants"),
  contextId,
);

const a = await moduleRef.resolve(TenantContext, contextId);
const b = await moduleRef.resolve(TenantContext, contextId);
expect(a).toBe(b); // Same instance within one request context
```

Or use `moduleRef.createRequestContainer(new Request("http://localhost/"))` for standalone unit tests.

---

## 5. Testing Server-Sent Events (`readSseEvents`)

`@bunest/testing` includes a W3C EventSource parser that cleanly cancels upstream async generators on `maxEvents`, `timeoutMs`, or `AbortSignal`:

```ts
import { parseSseJson, readSseEvents } from "@bunest/testing";

const res = await client.get("/events/stream");
res.expectStatus(200).expectHeader("content-type", /text\/event-stream/);

const events = await readSseEvents(res, { maxEvents: 3, timeoutMs: 2000 });
expect(events).toHaveLength(3);
expect(parseSseJson<{ seq: number }>(events[0]!)).toEqual({ seq: 1 });
```

---

## 6. Asserting Logs with `CapturingLogger`

Capture and assert structured log output without polluting test stdout:

```ts
import { CapturingLogger, Test } from "@bunest/testing";

const logger = new CapturingLogger();
const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .setLogger(logger)
  .compile();

// Exercise code...
logger.assertLogged(/User created/, "log");
logger.assertNotLogged(/password/i);
```

Use `TestingLogger` when you simply want silent test output (or `errorsOnly` mode).
