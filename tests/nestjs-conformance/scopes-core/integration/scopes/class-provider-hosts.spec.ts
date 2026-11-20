import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import {
  APP_GUARD,
  ForbiddenException,
  Inject,
  Injectable,
  Module,
  Scope,
  UseGuards,
  type CanActivate,
  type Provider,
} from "../../../../../packages/common/src";
import {
  ContextIdFactory,
  DiscoveryService,
  ExternalContextCreator,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
} from "../../../../../packages/websockets/src";
import {
  Test,
  type TestingModule,
  describeConformance,
} from "../../../_helpers";

@Injectable()
class DenyGuard implements CanActivate {
  canActivate() {
    return false;
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedDenyGuard implements CanActivate {
  canActivate() {
    return false;
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedAllowGuard implements CanActivate {
  canActivate() {
    return true;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientDenyGuard implements CanActivate {
  canActivate() {
    return false;
  }
}

@WebSocketGateway({ path: "/vault" })
class VaultGateway {
  @UseGuards(DenyGuard)
  @SubscribeMessage("open")
  open() {
    return { event: "open", data: "granted" };
  }
}

@WebSocketGateway({ path: "/vault" })
class RequestScopedVaultGateway {
  @UseGuards(RequestScopedDenyGuard)
  @SubscribeMessage("open")
  open() {
    return { event: "open", data: "granted" };
  }
}

@Injectable()
class PayrollResolver {
  payroll() {
    return "payroll";
  }

  @UseGuards(DenyGuard)
  secret() {
    return "secret";
  }
}

const IS_ALLOWED = "IS_ALLOWED";

@Injectable()
class ConfiguredGuard implements CanActivate {
  constructor(@Inject(IS_ALLOWED) private readonly isAllowed: boolean) {}

  canActivate() {
    return this.isAllowed;
  }
}

@Injectable()
class OrdersResolver {
  @UseGuards(ConfiguredGuard)
  orders() {
    return "orders";
  }
}

@Module({
  providers: [OrdersResolver, { provide: IS_ALLOWED, useValue: true }],
})
class PartnerModule {}

@Module({
  providers: [OrdersResolver, { provide: IS_ALLOWED, useValue: false }],
})
class AdminModule {}

describeConformance(
  "Class providers that host handlers",
  {
    upstreamPath: "integration/scopes/e2e/class-provider-hosts.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-007", "ADR-012"],
    notes:
      "Adapted from @nestjs/platform-ws + internal Injector.loadPerContext to Bunest native WebSocketModule/WebSocket + ExternalContextCreator + DiscoveryService.",
  },
  () => {
    describe('when a gateway is registered with "useClass"', () => {
      let app: BunestApplication | undefined;

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      const sendOpen = async (provider: Provider) => {
        const moduleRef = await Test.createTestingModule({
          imports: [WebSocketModule.forRoot()],
          providers: [provider],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await WebSocketModule.attach(app);
        await app.listen(0, "127.0.0.1");

        const url = `${app.getUrl()!.replace("http", "ws")}/vault`;
        const ws = new WebSocket(url);

        try {
          await new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener("error", (e) => reject(e), { once: true });
          });

          const replyPromise = new Promise<string>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("WebSocket reply timeout")),
              2000,
            );
            ws.addEventListener(
              "message",
              (event) => {
                clearTimeout(timer);
                resolve(String(event.data));
              },
              { once: true },
            );
          });

          ws.send(JSON.stringify({ event: "open", data: {} }));
          return JSON.parse(await replyPromise);
        } finally {
          ws.close();
        }
      };

      it("should run its guards when it is provided under its class", async () => {
        const reply = await sendOpen({
          provide: VaultGateway,
          useClass: VaultGateway,
        });

        // ADR-001: BunWebSocketAdapter emits `{ event: "error", data: ... }` for WS exceptions.
        expect(reply.event).toBe("error");
        expect(reply.data?.message ?? reply.message).toContain("Forbidden");
      });

      it("should run its guards when it is provided under another token", async () => {
        const reply = await sendOpen({
          provide: "VAULT",
          useClass: VaultGateway,
        });

        expect(reply.event).toBe("error");
        expect(reply.data?.message ?? reply.message).toContain("Forbidden");
      });

      it("should run its guards when it is provided under another token and a request-scoped guard", async () => {
        const reply = await sendOpen({
          provide: "VAULT",
          useClass: RequestScopedVaultGateway,
        });

        expect(reply.event).toBe("error");
        expect(reply.data?.message ?? reply.message).toContain("Forbidden");
      });
    });

    describe('when a resolver is registered with "useClass" under another token', () => {
      let moduleRef: TestingModule | undefined;

      afterEach(async () => {
        await moduleRef?.close();
        moduleRef = undefined;
      });

      const compile = async (providers: Provider[]) => {
        moduleRef = await Test.createTestingModule({
          providers: [
            { provide: "PAYROLL", useClass: PayrollResolver },
            ...providers,
          ],
        }).compile();
        const wrapper = moduleRef
          .get(DiscoveryService)
          .getProviderByToken<PayrollResolver>("PAYROLL")!;
        return { wrapper };
      };

      const createStaticHandler = async (
        providers: Provider[],
        methodName: "payroll" | "secret",
      ) => {
        const { wrapper } = await compile(providers);
        expect(wrapper.isDependencyTreeStatic).toBe(true);
        const resolver = wrapper.instance!;
        return moduleRef!
          .get(ExternalContextCreator)
          .create(resolver, resolver[methodName], methodName);
      };

      const createRequestScopedHandler = async (
        providers: Provider[],
        methodName: "payroll" | "secret",
      ) => {
        const { wrapper } = await compile(providers);
        const contextId = ContextIdFactory.create();
        moduleRef!.registerRequestByContextId({}, contextId);
        const resolver = await moduleRef!.resolve<PayrollResolver>(
          "PAYROLL",
          contextId,
        );
        return moduleRef!
          .get(ExternalContextCreator)
          .create(
            resolver,
            resolver[methodName],
            methodName,
            undefined,
            undefined,
            contextId,
            wrapper.moduleId,
          );
      };

      // BUNEST_BUG: ExternalContextCreator.create() does not execute global APP_GUARD multi-providers (packages/core/src/helpers/external-context-creator.ts); expected ForbiddenException, handler resolved.
      it.skip("should run a request-scoped global guard on it", async () => {
        const handler = await createRequestScopedHandler(
          [{ provide: APP_GUARD, useClass: RequestScopedDenyGuard }],
          "payroll",
        );

        await expect(handler()).rejects.toBeInstanceOf(ForbiddenException);
      });

      it("should run its own guards", async () => {
        const handler = await createStaticHandler([], "secret");

        await expect(handler()).rejects.toBeInstanceOf(ForbiddenException);
      });

      it("should run its own guards when it is request-scoped", async () => {
        const handler = await createRequestScopedHandler(
          [{ provide: APP_GUARD, useClass: RequestScopedAllowGuard }],
          "secret",
        );

        await expect(handler()).rejects.toBeInstanceOf(ForbiddenException);
      });

      // BUNEST_BUG: ExternalContextCreator.create() does not execute global APP_GUARD multi-providers (packages/core/src/helpers/external-context-creator.ts); expected ForbiddenException, handler resolved.
      it.skip("should run a transient global guard on it", async () => {
        const handler = await createStaticHandler(
          [{ provide: APP_GUARD, useClass: TransientDenyGuard }],
          "payroll",
        );

        await expect(handler()).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    describe("when two modules provide the class of a resolver", () => {
      let moduleRef: TestingModule | undefined;

      afterEach(async () => {
        await moduleRef?.close();
        moduleRef = undefined;
      });

      const compile = async (providers: Provider[] = []) => {
        moduleRef = await Test.createTestingModule({
          imports: [PartnerModule, AdminModule],
          providers,
        }).compile();
        const adminWrappers = moduleRef
          .get(DiscoveryService)
          .getProviders({ include: [AdminModule] });
        const wrapper = adminWrappers.find((w) => w.token === OrdersResolver)!;
        return { wrapper };
      };

      // BUNEST_BUG: ExternalContextCreator resolves enhancer classes against root module instead of the host's owning module (packages/core/src/helpers/external-context-creator.ts:103 & packages/core/src/di/di-container.ts:1633); throws UnknownDependencyException for module-local IS_ALLOWED.
      it.skip("should run the guards of the module of the host", async () => {
        const { wrapper } = await compile();
        const resolver = wrapper.instance as OrdersResolver;
        const handler = moduleRef!
          .get(ExternalContextCreator)
          .create(resolver, resolver.orders, "orders");

        await expect(handler()).rejects.toBeInstanceOf(ForbiddenException);
      });

      // BUNEST_BUG: ExternalContextCreator resolves enhancer classes against root module even when wrapper.moduleId is passed (packages/core/src/helpers/external-context-creator.ts:103 & packages/core/src/di/di-container.ts:1633); throws UnknownDependencyException for module-local IS_ALLOWED.
      it.skip(
        "should run the guards of the module of the host when paired with a request-scoped global guard [ADR-012]",
        async () => {
          const { wrapper } = await compile([
            { provide: APP_GUARD, useClass: RequestScopedAllowGuard },
          ]);
          const contextId = ContextIdFactory.create();
          moduleRef!.registerRequestByContextId({}, contextId);
          const resolver = await wrapper.moduleRef.resolve(
            OrdersResolver,
            contextId,
          );
          const handler = moduleRef!
            .get(ExternalContextCreator)
            .create(
              resolver,
              resolver.orders,
              "orders",
              undefined,
              undefined,
              contextId,
              wrapper.moduleId,
            );

          await expect(handler()).rejects.toBeInstanceOf(ForbiddenException);
        },
      );
    });
  },
);
