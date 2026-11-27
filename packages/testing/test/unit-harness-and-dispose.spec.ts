import { describe, expect, it, mock } from "bun:test";
import {
  CLS_ID,
  ClsService,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Scope,
  createClsProxyProvider,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@bunest/core";
import {
  Test,
  TestClient,
  createAutoMocker,
  runWithMockClsContext,
  type DeepMocked,
  type MockFn,
  type Mocked,
} from "../src";

describe("Solitary Unit Testing (Test.createUnit), Mocked types, spyFactory, asyncDispose & runWithMockClsContext", () => {
  it("auto-mocks constructor, property, and token dependencies in a one-liner via Test.createUnit()", async () => {
    const AUDIT_TOKEN = Symbol("AUDIT_LOGGER");

    interface AuditLogger {
      log(event: string): void;
    }

    @Injectable()
    class UsersRepository {
      async findById(_id: string): Promise<{ id: string; name: string } | null> {
        throw new Error("real database should never be called");
      }
      save(_user: { id: string; name: string }): boolean {
        return false;
      }
    }

    @Injectable()
    class MailerService {
      sendWelcome(_email: string): Promise<string> {
        throw new Error("real SMTP should never be called");
      }
    }

    @Injectable()
    class UsersService {
      @Inject(MailerService)
      readonly mailer!: MailerService;

      constructor(
        private readonly repo: UsersRepository,
        @Inject(AUDIT_TOKEN) private readonly audit: AuditLogger,
      ) {}

      async greet(id: string): Promise<string> {
        const user = await this.repo.findById(id);
        if (!user) {
          return "missing";
        }
        this.audit.log(`greet:${user.id}`);
        const sent = await this.mailer.sendWelcome(`${user.name}@example.com`);
        return `${user.name}:${sent}`;
      }
    }

    const { unit, unitRef, close } = await Test.createUnit(UsersService);
    try {
      const repo: Mocked<UsersRepository> = unitRef.get(UsersRepository);
      const mailer: Mocked<MailerService> = unitRef.get(MailerService);
      const audit: Mocked<AuditLogger> = unitRef.get<AuditLogger>(AUDIT_TOKEN);

      // Type sanity for MockFn and DeepMocked
      const findByIdSpy: MockFn<[string], Promise<{ id: string; name: string } | null>> =
        repo.findById;
      const deepRepo: DeepMocked<UsersRepository> =
        unitRef.getDeep(UsersRepository);
      expect(deepRepo).toBe(repo);

      findByIdSpy.mockResolvedValue({ id: "u1", name: "Ada" });
      mailer.sendWelcome.mockResolvedValue("queued");

      const result = await unit.greet("u1");
      expect(result).toBe("Ada:queued");
      expect(repo.findById.calls).toEqual([["u1"]]);
      expect(audit.log.calls).toEqual([["greet:u1"]]);
      expect(mailer.sendWelcome.calls).toEqual([["Ada@example.com"]]);
    } finally {
      await close();
    }
  });

  it("supports fluent .mock(Dep).useValue(...) and .overrideProvider(...) overrides with direct await or .compile()", async () => {
    const CONFIG_TOKEN = "APP_CONFIG";

    @Injectable()
    class PricingEngine {
      taxRate(): number {
        return 0.25;
      }
    }

    @Injectable()
    class DiscountProvider {
      percent(): number {
        return 0;
      }
    }

    @Injectable()
    class FixedDiscountProvider {
      percent(): number {
        return 10;
      }
    }

    @Injectable()
    class CheckoutService {
      constructor(
        private readonly pricing: PricingEngine,
        private readonly discount: DiscountProvider,
        @Inject(CONFIG_TOKEN) private readonly cfg: { currency: string },
      ) {}

      quote(subtotal: number): string {
        const discounted = subtotal * (1 - this.discount.percent() / 100);
        const total = discounted * (1 + this.pricing.taxRate());
        return `${this.cfg.currency}:${total.toFixed(2)}`;
      }
    }

    // Style 1: Fluent overrides awaited directly (PromiseLike)
    await using h1 = await Test.createUnit(CheckoutService)
      .mock(PricingEngine)
      .useValue({ taxRate: () => 0.1 })
      .overrideProvider(DiscountProvider)
      .useClass(FixedDiscountProvider)
      .overrideProvider(CONFIG_TOKEN)
      .useFactory({ factory: () => ({ currency: "USD" }) });

    expect(h1.unit.quote(100)).toBe("USD:99.00");

    // Style 2: Options overrides map + explicit .compile()
    await using h2 = await Test.createUnit(CheckoutService, {
      overrides: [
        [CONFIG_TOKEN, { currency: "EUR" }],
        [PricingEngine, { taxRate: () => 0.2 }],
      ],
    })
      .mock(DiscountProvider)
      .useValue({ percent: () => 50 })
      .compile();

    expect(h2.unit.quote(100)).toBe("EUR:60.00");
  });

  it("integrates bun:test mock() via AutoMockerOptions.spyFactory in createAutoMocker and Test.createUnit", async () => {
    @Injectable()
    class PaymentGateway {
      charge(_amount: number, _currency: string): Promise<string> {
        return Promise.resolve("real");
      }
    }

    @Injectable()
    class BillingFacade {
      constructor(private readonly gateway: PaymentGateway) {}

      pay(amount: number) {
        return this.gateway.charge(amount, "USD");
      }
    }

    await using harness = await Test.createUnit(BillingFacade, {
      spyFactory: () => mock(),
    });

    const gateway = harness.unitRef.get(PaymentGateway);
    gateway.charge.mockResolvedValue("tx_999");

    expect(await harness.unit.pay(250)).toBe("tx_999");
    // Native bun:test mock matchers work directly!
    expect(gateway.charge).toHaveBeenCalledTimes(1);
    expect(gateway.charge).toHaveBeenCalledWith(250, "USD");

    // Also verify createAutoMocker directly with spyFactory on unregistered token proxy
    const EXT_TOKEN = Symbol("EXT_GATEWAY");
    @Injectable()
    class ProxyConsumer {
      constructor(
        @Inject(EXT_TOKEN)
        readonly ext: { notify(topic: string): void },
      ) {}
    }

    await using mod = await Test.createTestingModule({
      providers: [ProxyConsumer],
    })
      .useMocker(
        createAutoMocker({
          mockUnregisteredTokens: true,
          spyFactory: () => mock(),
        }),
      )
      .compile();

    const consumer = mod.get(ProxyConsumer);
    consumer.ext.notify("order.paid");
    expect(consumer.ext.notify).toHaveBeenCalledWith("order.paid");
  });

  it("supports Test.createUnit for @Controller(), TRANSIENT, and REQUEST-scoped targets", async () => {
    @Injectable()
    class CatalogRepo {
      list(): string[] {
        return [];
      }
    }

    @Controller("catalog")
    class CatalogController {
      constructor(private readonly repo: CatalogRepo) {}
      @Get()
      index() {
        return this.repo.list();
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestScopedHandler {
      constructor(private readonly repo: CatalogRepo) {}
      run() {
        return this.repo.list();
      }
    }

    await using ctrlHarness = await Test.createUnit(CatalogController);
    ctrlHarness.unitRef.get(CatalogRepo).list.mockReturnValue(["a", "b"]);
    expect(ctrlHarness.unit.index()).toEqual(["a", "b"]);

    await using reqHarness = await Test.createUnit(RequestScopedHandler);
    reqHarness.unitRef.get(CatalogRepo).list.mockReturnValue(["req-ok"]);
    expect(reqHarness.unit.run()).toEqual(["req-ok"]);
  });

  it("automatically cleans up resources with await using on TestingModule, TestClient, and UnitTestResult", async () => {
    const lifecycleEvents: string[] = [];

    @Injectable()
    class TrackedService implements OnModuleInit, OnModuleDestroy {
      onModuleInit() {
        lifecycleEvents.push("init");
      }
      onModuleDestroy() {
        lifecycleEvents.push("destroy");
      }
    }

    @Controller("dispose")
    class DisposeController {
      @Get()
      ping() {
        return { pong: true };
      }
    }

    // 1. TestingModule asyncDispose
    {
      await using mod = await Test.createTestingModule({
        providers: [TrackedService],
      }).compile();
      await mod.init();
      expect(lifecycleEvents).toEqual(["init"]);
    }
    expect(lifecycleEvents).toEqual(["init", "destroy"]);

    // 2. UnitTestResult asyncDispose (with init: true)
    lifecycleEvents.length = 0;
    {
      await using harness = await Test.createUnit(TrackedService, {
        init: true,
      });
      expect(harness.unit).toBeInstanceOf(TrackedService);
      expect(lifecycleEvents).toEqual(["init"]);
    }
    expect(lifecycleEvents).toEqual(["init", "destroy"]);

    // 3. TestClient asyncDispose (closes app created for client)
    lifecycleEvents.length = 0;
    {
      const mod = await Test.createTestingModule({
        controllers: [DisposeController],
        providers: [TrackedService],
      }).compile();
      await using client = mod.createTestClient();
      const res = await client.get("/dispose");
      res.expectStatus(200);
      expect(await res.json()).toEqual({ pong: true });
    }
    expect(lifecycleEvents).toEqual(["init", "destroy"]);

    // 4. TestClient.fromUrl asyncDispose is a safe no-op
    {
      await using urlClient = TestClient.fromUrl("http://127.0.0.1:1");
      expect(urlClient.getBaseUrl()).toBe("http://127.0.0.1:1");
    }
  });

  it("runs services and CLS proxy providers in isolation via runWithMockClsContext()", async () => {
    const TENANT_PROXY = Symbol("TENANT_PROXY");

    interface TenantProxy {
      readonly tenantId: string;
    }

    @Injectable()
    class TenantAwareService {
      constructor(
        private readonly cls: ClsService,
        @Inject(TENANT_PROXY) private readonly tenant: TenantProxy,
      ) {}

      async readInfo() {
        await Bun.sleep(2);
        return {
          id: this.cls.getId(),
          tenantFromCls: this.cls.get<string>("tenantId"),
          tenantFromProxy: this.tenant.tenantId,
          role: this.cls.get<string>("role"),
        };
      }
    }

    @Module({
      providers: [
        ClsService,
        createClsProxyProvider<TenantProxy>(TENANT_PROXY, (cls) => ({
          tenantId: cls.get<string>("tenantId") ?? "missing",
        })),
        TenantAwareService,
      ],
    })
    class IsolatedClsModule {}

    await using mod = await Test.createTestingModule({
      imports: [IsolatedClsModule],
    }).compile();

    const svc = mod.get(TenantAwareService);
    const cls = mod.get(ClsService);

    expect(cls.isActive()).toBe(false);

    const [a, b] = await Promise.all([
      runWithMockClsContext(
        { [CLS_ID]: "ctx-a", tenantId: "alpha", role: "admin" },
        () => svc.readInfo(),
      ),
      runWithMockClsContext(
        new Map<string | symbol, unknown>([
          ["tenantId", "beta"],
          ["role", "viewer"],
        ]),
        async (mockCls) => {
          expect(mockCls.isActive()).toBe(true);
          return svc.readInfo();
        },
      ),
    ]);

    expect(a).toEqual({
      id: "ctx-a",
      tenantFromCls: "alpha",
      tenantFromProxy: "alpha",
      role: "admin",
    });
    expect(b.tenantFromCls).toBe("beta");
    expect(b.tenantFromProxy).toBe("beta");
    expect(b.role).toBe("viewer");
    expect(typeof b.id).toBe("string");

    // Context cleanly torn down after runWithMockClsContext completes
    expect(cls.isActive()).toBe(false);
  });
});
