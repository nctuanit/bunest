# Kiểm thử (Testing)

`@bunest/testing` mang **độ tương thích API đầy đủ với `@nestjs/testing`** trực tiếp lên **Bun** (`bun:test`) — kết hợp `Test.createTestingModule()`, ghi đè provider/enhancer/module, auto-mocking không phụ thuộc thư viện ngoài (`useMocker` + `createAutoMocker`), kiểm thử `ContextId` cho request-scope, và assertion log có cấu trúc (`TestingLogger` / `CapturingLogger`) cùng với **kiểm thử E2E HTTP trong bộ nhớ không cần socket** (`request(app)`, `TestClient`, `app.inject()`), kiểm thử cổng tạm thời trực tiếp (`app.listen(0)`), các helper luồng SSE, và cầu nối `http.Server` của Node tùy chọn cho `supertest` cũ.

## Cài đặt & Thiết lập

Cài đặt `@bunest/testing` làm dev dependency cùng với `@bunest/core`:

```bash
bun add -d @bunest/testing
```

`@bunest/core` đã tích hợp sẵn Reflect Metadata shim không phụ thuộc gói ngoài ([ADR-017](/architecture/adrs)), nên bạn không cần thêm dòng boilerplate `import "reflect-metadata"` trong các file test:

```bash
# Run all unit & E2E tests with Bun's native runner
bun test
```

> tip **Quy ước đặt tên file E2E (`*.e2e.spec.ts`)** Khác với mẫu mặc định `*.e2e-spec.ts` của Jest, `bun test` tự động tìm các file kết thúc bằng `.spec.ts`, `.test.ts`, `_spec.ts`, hoặc `_test.ts`. Hãy đặt tên file E2E test theo dạng `*.e2e.spec.ts` (có dấu chấm trước `spec`) để `bun test` tự động nhận diện.

> info **Không phụ thuộc thư viện Mock bên ngoài** `@bunest/testing` không cần Jest, `jest-mock`, RxJS, Express hay các gói HTTP ngoài. Trình auto-mocker (`ModuleMocker` / `createAutoMocker`), client `request(app)` theo phong cách Supertest, cookie jar và trình phân tích SSE đều được xây dựng thuần trên Bun và Web Standards ([ADR-001](/architecture/adrs)).

---

## Kiểm thử đơn vị (Unit Testing) với `Test.createTestingModule`

`Test.createTestingModule(metadata, options?)` tạo một `TestingModuleBuilder` cô lập được vận hành bởi `ModuleScanner`, `DIContainer`, và `LifecycleManager` thật của Bunest:

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

### Ghi đè Provider (Overriding Providers)

Khi import một feature module có sẵn hoặc `AppModule`, bạn có thể thay thế bất kỳ provider token nào (class, `string`, hoặc `symbol`) trước khi gọi `compile()` bằng `overrideProvider(token)` với `useValue`, `useClass`, `useFactory`, hoặc `useExisting`:

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

> tip **Ngữ nghĩa các trường hợp biên** `overrideProvider(Token).useValue(undefined)` và `.useValue(null)` trả về giá trị ngay lập tức mà không khởi tạo class gốc. `overrideProvider(Token).useClass(MockClass)` kế thừa metadata `@Injectable({ scope })` của `MockClass` và thực thi các lifecycle hook của nó (`onModuleInit`, `onModuleDestroy`, v.v.), ngay cả khi thay thế một provider `useValue` hoặc `useExisting`.

### Ghi đè Guards, Pipes, Interceptors & Exception Filters

Hoán đổi các enhancer ở cấp độ route (`@UseGuards`, `@UsePipes`, `@UseInterceptors`, `@UseFilters`), toàn cục qua DI (`APP_GUARD`, `APP_PIPE`, `APP_INTERCEPTOR`, `APP_FILTER`), hoặc khai báo bắt buộc (`app.useGlobal*`) bằng `overrideGuard`, `overridePipe`, `overrideInterceptor`, và `overrideFilter`:

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

Các đảm bảo chính cho việc ghi đè enhancer trong Bunest:

- **Hỗ trợ đầy đủ `useValue` / `useClass` / `useFactory` / `useExisting`** trên cả decorator `@Use*`, multi-provider `APP_*`, và hàm `app.useGlobal*()`.
- **Phạm vi hiển thị DI riêng tư của module:** các ghi đè `useFactory` / `useExisting` trên enhancer thuộc về module sẽ resolve các token `inject` bên trong chính module khai báo enhancer đó (và fallback về root module của test nếu cần).
- **Bảo toàn `@Catch(...)`:** `overrideFilter(TypedFilter).useValue(...)` và `.useFactory(...)` tự động giữ nguyên các loại ngoại lệ trong `@Catch(...)` của `TypedFilter` để một filter định kiểu không bao giờ âm thầm biến thành catch-all. Khi dùng `.useClass(ReplacementFilter)`, hệ thống sẽ tuân theo metadata `@Catch(...)` của chính `ReplacementFilter`.
- **Cô lập theo loại & provider:** Ghi đè một class thông qua `overrideProvider(X)` và `overrideGuard(X)` (hoặc `overridePipe(X)`) sẽ theo dõi chúng trong các bản đồ ghi đè tách biệt để không ghi đè lẫn nhau, và `overrideGuard(GuardClass).useValue(...)` bỏ qua bước kiểm tra dependency/rò rỉ scope trên class gốc đã bị thay thế.

### Ghi đè toàn bộ Module (`overrideModule`)

Thay thế một static module được import, module lồng nhau, `@Global()` module, module vòng lặp `forwardRef()`, hoặc `DynamicModule` trước khi quét module bằng `overrideModule(target).useModule(replacement)`:

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

`overrideModule()` cũng khớp chính xác các tham chiếu `DynamicModule` trước rồi mới fallback sang khớp `dynamicModule.module`, giúp việc thay thế `ConfigModule.forRoot(...)` hay `DatabaseModule.forRootAsync(...)` trở nên dễ dàng.

---

## Auto-Mocking với `useMocker` & `createAutoMocker`

Thay vì mock thủ công từng dependency bắc cầu trong một unit test, hãy đăng ký một `MockFactory` dự phòng qua `.useMocker(factory)` hoặc dùng `createAutoMocker()` / `ModuleMocker` không phụ thuộc gói ngoài của Bunest:

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

Bạn cũng có thể tự điều khiển `ModuleMocker` và `createMockFn()` trực tiếp bên trong một factory `useMocker((token) => ...)` tùy chỉnh (tương tự mô hình `useMocker` của NestJS mà không cần cài `jest-mock`):

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

| Hành vi của `useMocker`                 | Chi tiết                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bộ nhớ đệm dùng chung (Shared cache)** | Mỗi token được auto-mock chỉ tạo một lần và chia sẻ trên mọi consumer (`SINGLETON`, `TRANSIENT`, và `REQUEST`), đồng thời có thể lấy qua `moduleRef.get(Token)` / `moduleRef.resolve(Token)`.                                     |
| **Thất bại nghiêm ngặt với `null`/`undefined`** | Nếu factory trả về `undefined` hoặc `null`, Bunest sẽ ném lại `UnknownDependencyException` ban đầu.                                                                                                                         |
| **Tôn trọng `@Optional()` & built-ins** | Các dependency gắn `@Optional()` giữ nguyên giá trị `undefined`; các token dựng sẵn `REQUEST` và `REQUEST_CONTEXT` không bao giờ bị auto-mock.                                                                                    |
| **Các token không phải class**          | Truyền `createAutoMocker({ mockUnregisteredTokens: true })` để trả về một spy `Proxy` khởi tạo lười cho các token dạng chuỗi/symbol chưa đăng ký.                                                                               |
| **Spy API (`MockFunction`)**            | Mọi phương thức được auto-mock đều cung cấp `.calls`, `.results`, `.callCount`, `.called`, `.mockReturnValue(Once)`, `.mockResolvedValue(Once)`, `.mockRejectedValue(Once)`, `.mockImplementation(Once)`, `.mockClear()`, và `.mockReset()`. |

---

## Tra cứu Strict (`select`), `{ each: true }` & Kiểm thử `Scope.REQUEST`

### Điều hướng Module với `select()`

Dùng `moduleRef.select(TargetModule)` để áp dụng chặt chẽ tính đóng gói của module ([ADR-007](/architecture/adrs)). `select()` có thể gọi nối chuỗi (chainable) và chấp nhận cả static module class lẫn `DynamicModule` instance:

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

### Unit-Test các Provider `Scope.REQUEST` không cần HTTP (`ContextIdFactory`)

Theo phong cách test của NestJS, tạo một `ContextId` giả lập bằng `ContextIdFactory.create()`, gắn một `Request` giả qua `registerRequestByContextId()`, và resolve trực tiếp các provider `Scope.REQUEST` — không cần khởi động HTTP server:

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

Bạn cũng có thể tạo một `RequestContainer` độc lập bằng `moduleRef.createRequestContainer(req)` rồi truyền vào `moduleRef.resolve(Token, reqContainer)` khi cần kiểm thử trực tiếp quá trình dọn dẹp `OnRequestDestroy`.

---

## Kiểm thử Loggers (`TestingLogger` & `CapturingLogger`)

Mặc định, `TestingModuleBuilder.compile()` gắn sẵn một **`TestingLogger`**, giúp ẩn bớt các log `log`, `warn`, `debug`, và `verbose` gây nhiễu khi chạy test trong khi vẫn in ra các chẩn đoán `error` và `fatal`.

Để kiểm tra (assert) các log được phát ra một cách sạch sẽ mà không làm bẩn stdout/stderr, hãy truyền **`CapturingLogger`** qua `.setLogger(logger)` / `moduleRef.useLogger(logger)` (cho log của framework & `DefaultExceptionFilter`) và/hoặc inject nó vào các service thông qua `overrideProvider`:

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

> info **Logger của Framework so với `new Logger()` độc lập** `.setLogger(logger)` và `moduleRef.useLogger(logger)` cấu hình logger của framework được dùng bởi `TestingModule`, `BunestApplication`, `BunHttpAdapter`, và `DefaultExceptionFilter` (có thể truy cập qua `app.getLogger()`). Các instance `new Logger("MyService")` độc lập ghi trực tiếp qua `writer` riêng của chúng (mặc định là `console`) — để thu giữ log của service trong test, hãy inject một token `LoggerService` (như ví dụ trên) hoặc dùng `Logger.log()` tĩnh kết hợp với `Logger.overrideLogger(logger)`.

`TestingModule` cũng hỗ trợ `bufferLogs: true` + `moduleRef.useLogger(customLogger)` + `moduleRef.flushLogs()`, truyền tiếp các cập nhật logger xuống cả `BunHttpAdapter` và `DefaultExceptionFilter`.

---

## Kiểm thử HTTP End-to-End (E2E)

`@bunest/testing` cung cấp **ba chế độ E2E bổ trợ lẫn nhau** dùng chung chính xác một pipeline HTTP 11 giai đoạn đã biên dịch ([ADR-008](/architecture/execution-pipeline)):

1. **Điều phối trong bộ nhớ không socket (khuyên dùng mặc định):** `request(app)`, `request.agent(app)`, `TestClient`, hoặc `app.inject()` — gửi thẳng vào `BunestApplication.fetch()` **không cần mở cổng TCP**, độ trễ tính bằng micro giây, và giữ nguyên vẹn hành vi của middleware/guards/pipes/interceptors/filters/CORS/serialization.
2. **Cổng tạm thời trực tiếp (`app.listen(0)`):** `TestClient.fromUrl(info.url)` hoặc `request(info.url)` / `request(app.getHttpServer())` — kiểm tra socket `Bun.serve({ routes })` thật trên một cổng do OS cấp (`port: 0`, [ADR-011](/architecture/hybrid-router)) cho WebSockets, ngắt kết nối SSE trực tiếp và hành vi mạng thực tế.
3. **Cầu nối HTTP Node tùy chọn (`createNodeHttpServer(app)`):** bọc bất kỳ ứng dụng Bunest nào vào một `http.Server` của Node (chỉ nằm trong `@bunest/testing`) dành cho các nhóm đang chuyển đổi dần các bộ test npm `supertest` hiện có.

### 1. `request(app)` & `request.agent(app)` phong cách Supertest không socket

`request(app)` cung cấp API fluent có thể nối chuỗi tương thích với Supertest và triển khai `PromiseLike<SupertestResponse>` — không socket, không phụ thuộc gói npm `supertest`:

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

Các phương thức được hỗ trợ của `request(app)` (`SupertestAgent` & `SupertestRequest`):

- **Điểm vào & mặc định của `SupertestAgent`:** `.get()`, `.post()`, `.put()`, `.patch()`, `.delete()`, `.head()`, `.options()`, `.request(method, path)`, cùng các phương thức phạm vi agent `.set()`, `.unset()`, `.auth()`, `.withCookies()`, `.getCookies()`, `.setCookie()`, `.clearCookies()`
- **Headers & xác thực của `SupertestRequest`:** `.set(name, value)`, `.set(record)`, `.unset(name)`, `.auth(user, pass)`, `.auth(token, { type: "bearer" })`, `.type("json" | "form" | mime)`, `.accept(mime)`
- **Payload & tham số của `SupertestRequest`:** `.query(params)`, `.cookies(record)`, `.send(body)`, `.field(name, value)`, `.attach(field, data, filename?, contentType?)`
- **Điều khiển của `SupertestRequest`:** `.redirects(n)` _(mặc định là `0` / manual để có thể kiểm tra trực tiếp header `Location` của `301`/`302`)_, `.timeout(ms)`
- **Assertion nối chuỗi của `SupertestRequest`:** `.expect(status)`, `.expect(status, body)`, `.expect(headerName, string | RegExp)`, `.expect(bodyOrRegExp)`, `.expect((res) => ...)`

### 2. `TestClient`, `TestAgent` chuẩn Web & `app.inject()` phong cách Fastify

Bạn thích các đối tượng `TestResponse` chuẩn Web tường minh hay `app.inject()` phong cách Fastify? Cả hai đều được tích hợp sẵn:

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

> info **`LifecycleManager` dùng chung & Dọn dẹp sạch sẽ** `TestingModule` và mọi `BunestApplication` tạo ra từ nó đều chia sẻ một `LifecycleManager` duy nhất. Việc gọi `await app.init()` rồi `await moduleRef.init()`, hoặc `await app.close()` rồi `await moduleRef.close()`, là hoàn toàn lũy đẳng (idempotent) — các lifecycle hook (`onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`, `beforeApplicationShutdown`, `onApplicationShutdown`) không bao giờ chạy lặp hai lần và `enableShutdownHooks()` không bao giờ làm rò rỉ các listener `SIGINT`/`SIGTERM`.

### 3. Kiểm thử cổng tạm thời trực tiếp (`app.listen(0)`)

Khi kiểm thử socket TCP thật, nâng cấp WebSocket, hoặc định tuyến `Bun.serve({ routes })` trực tiếp, hãy bind một cổng tạm thời do OS cấp bằng `await app.listen(0)` (không xung đột khi chạy song song các file `bun test`) và trỏ `TestClient.fromUrl(info.url)` hoặc `request(app.getHttpServer())` vào đó:

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

Kiểm thử upload file multipart bằng `.field()` + `.attach()` (hoặc `FormData`), và đọc luồng `@Sse()` bằng `readSseEvents()` + `parseSseJson()` — tự động hủy stream reader và kích hoạt bước dọn dẹp generator ở nguồn ngay khi đạt `maxEvents`, `signal`, hoặc `timeoutMs`:

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

### 5. Cầu nối `supertest` cũ tùy chọn (`createNodeHttpServer`)

Nếu bạn đang chuyển đổi một kho mã NestJS hiện có vốn import trực tiếp gói npm `supertest`, `@bunest/testing` cung cấp `createNodeHttpServer(app)` để chuyển đổi bất kỳ `BunestApplication` (`FetchCapable`) nào sang `http.Server` chuẩn Node — bảo toàn stream nhị phân, hủy khi abort, và nhiều header `Set-Cookie`:

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

> warning **Ranh giới kiến trúc (ADR-001 / ADR-017)** `createNodeHttpServer()` trong `@bunest/testing` chạy thuần trên `Bun.serve({ port: 0 })` (không dùng `node:http`!). Đối với các test mới, hãy ưu tiên `request(app)` hoặc `TestClient` tích hợp sẵn của Bunest, vốn chạy không socket trong bộ nhớ mà không cần mở cổng TCP.

---

## Các Fixture cho Unit-Test cô lập

Để kiểm thử guards, interceptors, middleware, exception filters và các helper `RequestContext` hoàn toàn cô lập mà không cần biên dịch module:

| Fixture                                           | Mục đích                                                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMockRequest(pathOrUrl?, options?)`         | Tạo một Web `Request` gốc với `method`, `baseUrl`, `query`, `headers`, `cookies`, `json`, `body`, `formData`, và `signal`.                                                                |
| `createMockResponseContext()`                     | Trả về một `HttpResponseContext` mới để kiểm tra status, headers, và các thay đổi `Set-Cookie`.                                                                                           |
| `createMockExecutionContext(options?)`            | Tạo một `ExecutionContext` (`HttpExecutionContext` cho HTTP; tách biệt rõ payload `ws: { client, data, pattern }` và `rpc: { data, context }` mà không làm rò rỉ các đối tượng HTTP).   |
| `createMockCallHandler(valueOrFactory)`           | Tạo một spy `CallHandler` với `.called` và `.callCount` để kiểm tra interceptor cho đi qua (passthrough) hay ngắt sớm (short-circuit).                                                     |
| `createMockProvider(token, partialValue)`         | Cách viết tắt có định kiểu cho `{ provide: token, useValue: partialValue as T }`.                                                                                                         |
| `createMockLogger(options?)`                      | Trả về một `CapturingLogger` sẵn sàng cho việc assert log.                                                                                                                                |
| `createMockReflector(overrides?)`                 | Trả về một `Reflector` thật với các ghi đè phương thức tùy chọn.                                                                                                                          |
| `runWithMockRequestContext(reqOrPath, fn, opts?)` | Thực thi `fn(ctx)` bên trong một `AsyncLocalStorage` `RequestContext` đang hoạt động để mã nguồn gọi `getCurrentRequestContext()` chạy được độc lập.                                      |

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

## Độ tương thích & Khác biệt với `@nestjs/testing` của NestJS

Không thể import trực tiếp `@nestjs/testing` chính thức vào một dự án Bunest vì nó gắn chặt với `NestContainer`/`TestingInjector` nội bộ của `@nestjs/core`, các HTTP adapter Express/Fastify, `http.Server` của Node, và các pipeline `Observable` của RxJS. Thay vào đó, `@bunest/testing` triển khai **một phiên bản tương đương 1-1 thuần Bun** bao phủ toàn bộ bề mặt API của `@nestjs/testing`:

| Khả năng                 | NestJS (`@nestjs/testing` + Jest + Supertest)                                   | Bunest (`@bunest/testing` + `bun:test`)                                                               |
| ------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Test runner**          | Jest / Vitest (`jest.fn()`, `jest-mock`)                                        | **`bun:test` gốc** (`*.spec.ts` / `*.e2e.spec.ts`) + `createMockFn()` / `ModuleMocker` không gói ngoài |
| **Module builder**       | `Test.createTestingModule(meta, opts?)`                                         | `Test.createTestingModule(meta, opts?)`                                                               |
| **Ghi đè DI**            | `overrideProvider` (`useValue`, `useClass`, `useFactory`)                       | `overrideProvider` (`useValue`, `useClass`, `useFactory`, **`useExisting`**)                          |
| **Ghi đè Enhancer**      | `overrideGuard` / `Pipe` / `Interceptor` / `Filter`                             | `overrideGuard` / `Pipe` / `Interceptor` / `Filter` (đầy đủ `APP_*` & `@Use*` + bảo toàn `@Catch`)   |
| **Ghi đè Module**        | `overrideModule(Mod).useModule(Mock)`                                           | `overrideModule(Mod).useModule(Mock)` (static, `@Global()`, `DynamicModule`, `forwardRef`)            |
| **Auto-mocking**         | `.useMocker(token => ...)` + `ModuleMocker` ngoài từ `jest-mock`                | `.useMocker(createAutoMocker())` + `ModuleMocker` tích hợp sẵn không gói ngoài                        |
| **Loggers**              | `TestingLogger`, `CapturingLogger` (v12), `setLogger`, `useLogger`, `flushLogs` | `TestingLogger`, `CapturingLogger`, `setLogger`, `useLogger`, `flushLogs`                             |
| **Khởi tạo App**         | `moduleRef.createNestApplication()`                                             | `moduleRef.createNestApplication()` **và** `moduleRef.createBunestApplication()`                      |
| **Tra cứu theo phạm vi** | `select(Mod)`, `get(tok, { strict, each })`, `resolve(tok, ctxId, opts)`        | `select(Mod)` (nối chuỗi + `DynamicModule`), `get` / `resolve` với `{ strict, each }`                 |
| **Request scope DI**     | `ContextIdFactory.create()` + `registerRequestByContextId()`                    | `ContextIdFactory.create()` + `registerRequestByContextId()` + `createRequestContainer()`             |
| **In-memory E2E**        | `supertest(app.getHttpServer())` (Node socket) hoặc Fastify `app.inject()`      | **Không socket** `request(app)`, `request.agent(app)`, `TestClient`, **và** `app.inject()`            |
| **Live HTTP / WS**       | `await app.listen(0)` + `app.getUrl()`                                          | `await app.listen(0)` + `TestClient.fromUrl(info.url)` / `request(app.getHttpServer())`               |
| **Legacy Supertest**     | Hỗ trợ gốc qua `http.Server` của Node                                           | Cầu nối tùy chọn `supertest(createNodeHttpServer(app))`                                               |
| **SSE & Multipart**      | Tự phân tích stream thủ công / Multer                                           | Tích hợp sẵn `readSseEvents()`, `parseSseJson()`, và `.field()` + `.attach()`                         |
| **Interceptors**         | RxJS `Observable` (`of(...)`)                                                   | `Promise` gốc (`createMockCallHandler(() => ...)`)                                                    |

> tip **Chuyển từ NestJS sang?** Xem hướng dẫn [Chuyển đổi từ NestJS](/architecture/migration-from-nestjs) để đối chiếu từng bước chuyển đổi từ Jest/Supertest sang Bunest cùng danh sách kiểm tra đầy đủ.
