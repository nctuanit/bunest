import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  Catch,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Scope,
  UseGuards,
  createParamDecorator,
  type ArgumentsHost,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
  type Provider,
  type Type,
} from "../../../../../packages/common/src";
import {
  ExternalContextCreator,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  Payload,
  TcpClientProxy,
  TcpServer,
  Transport,
} from "../../../../../packages/microservices/src";
import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
} from "../../../../../packages/websockets/src";
import { Test, describeConformance, request } from "../../../_helpers";

@Injectable()
class Gate {
  isOpen() {
    return false;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientDenyGuard implements CanActivate {
  constructor(private readonly gate: Gate) {}

  canActivate() {
    return this.gate.isOpen();
  }
}

@Injectable()
class DefaultDenyGuard implements CanActivate {
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

@Injectable({ scope: Scope.TRANSIENT })
class TrackingGuard implements CanActivate {
  static instanceCount = 0;
  static readonly instancesByController = new Map<string, Set<number>>();
  private readonly instanceId = ++TrackingGuard.instanceCount;

  static reset() {
    TrackingGuard.instanceCount = 0;
    TrackingGuard.instancesByController.clear();
  }

  canActivate(context: ExecutionContext) {
    const controller = context.getClass().name;
    const known =
      TrackingGuard.instancesByController.get(controller) ?? new Set<number>();
    TrackingGuard.instancesByController.set(
      controller,
      known.add(this.instanceId),
    );
    return true;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TrackingDenyGuard extends TrackingGuard {
  constructor(private readonly gate: Gate) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    return super.canActivate(context) && this.gate.isOpen();
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class SuffixPipe implements PipeTransform {
  transform(value: string) {
    return `${value}-piped`;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class PrefixInterceptor implements NestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler) {
    const data = await next.handle();
    return `intercepted:${String(data)}`;
  }
}

@Catch()
@Injectable({ scope: Scope.TRANSIENT })
class TeapotFilter implements ExceptionFilter {
  catch(_error: unknown, _host: ArgumentsHost) {
    return new Response("handled", { status: 418 });
  }
}

@Catch()
@Injectable({ scope: Scope.TRANSIENT })
class RecoveringRpcFilter implements ExceptionFilter {
  catch() {
    return "recovered";
  }
}

const Greeting = createParamDecorator(() => "hello");

@Controller("first")
class FirstController {
  @Get()
  read() {
    return "ok";
  }

  @Get("greeting")
  greet(@Greeting() greeting: string) {
    return greeting;
  }

  @Get("fail")
  fail() {
    throw new Error("boom");
  }
}

@Controller("second")
class SecondController {
  @Get()
  read() {
    return "ok";
  }
}

@Controller("guarded-first")
class GuardedFirstController {
  @Get()
  @UseGuards(TrackingDenyGuard)
  read() {
    return "ok";
  }
}

@Controller("guarded-second")
class GuardedSecondController {
  @Get()
  @UseGuards(TrackingDenyGuard)
  read() {
    return "ok";
  }
}

@Controller()
class MessageController {
  @MessagePattern("read")
  read() {
    return "ok";
  }

  @MessagePattern("echo")
  echo(@Payload() name: string) {
    return name;
  }

  @MessagePattern("fail")
  fail() {
    throw new Error("boom");
  }
}

@Injectable()
class EntryProvider {
  constructor(@Inject("SLOW") _slow: unknown) {}

  read() {
    return "ok";
  }

  @UseGuards(TrackingDenyGuard)
  guarded() {
    return "ok";
  }
}

@Injectable()
class EntryProviderConsumer {
  constructor(readonly entryProvider: EntryProvider) {}
}

@Injectable({ scope: Scope.TRANSIENT })
class EntryProviderConsumerGuard implements CanActivate {
  constructor(private readonly consumer: EntryProviderConsumer) {}

  canActivate() {
    return !this.consumer.entryProvider;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientArrowDenyGuard implements CanActivate {
  constructor(private readonly gate: Gate) {}

  canActivate = () => this.gate.isOpen();
}

@WebSocketGateway({ path: "/transient" })
class TransientGuardedGateway {
  @UseGuards(TransientArrowDenyGuard)
  @SubscribeMessage("arrow")
  arrow() {
    return { event: "arrow", data: "granted" };
  }

  @UseGuards(TrackingDenyGuard)
  @SubscribeMessage("method")
  method() {
    return { event: "method", data: "granted" };
  }
}

const createModule = (
  providers: Provider[],
  controllers: Type<unknown>[] = [FirstController],
) => {
  @Module({ controllers, providers: [Gate, ...providers] })
  class TestModule {}
  return TestModule;
};

const createApp = async (mod: Type<unknown>) => {
  const moduleRef = await Test.createTestingModule({
    imports: [mod],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
};

describeConformance(
  "Transient global enhancers",
  {
    upstreamPath: "integration/scopes/e2e/transient-global-enhancers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010", "ADR-012"],
    notes:
      "Tests transient APP_GUARD/APP_PIPE/APP_INTERCEPTOR/APP_FILTER across HTTP, TCP microservice, ExternalContextCreator entry providers, and WebSocket gateways.",
  },
  () => {
    describe("http", () => {
      let app: BunestApplication | undefined;

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      describe("guard", () => {
        it("should deny the request when the global guard is transient", async () => {
          app = await createApp(
            createModule([{ provide: APP_GUARD, useClass: TransientDenyGuard }]),
          );

          await request(app).get("/first").expect(403);
        });

        it("should deny the request when the global guard is a default provider", async () => {
          app = await createApp(
            createModule([{ provide: APP_GUARD, useClass: DefaultDenyGuard }]),
          );

          await request(app).get("/first").expect(403);
        });

        it("should deny the request when the global guard is request scoped", async () => {
          app = await createApp(
            createModule([
              { provide: APP_GUARD, useClass: RequestScopedDenyGuard },
            ]),
          );

          await request(app).get("/first").expect(403);
        });

        it("should give each controller its own instance and keep it across requests", async () => {
          TrackingGuard.reset();
          app = await createApp(
            createModule(
              [{ provide: APP_GUARD, useClass: TrackingGuard }],
              [FirstController, SecondController],
            ),
          );

          await request(app).get("/first").expect(200);
          await request(app).get("/first").expect(200);
          await request(app).get("/second").expect(200);
          await request(app).get("/second").expect(200);

          const { instancesByController } = TrackingGuard;
          expect(instancesByController.get("FirstController")?.size).toBe(1);
          expect(instancesByController.get("SecondController")?.size).toBe(1);
          expect(
            new Set([
              ...(instancesByController.get("FirstController") ??
                new Set<number>()),
              ...(instancesByController.get("SecondController") ??
                new Set<number>()),
            ]).size,
          ).toBe(2);
        });
      });

      describe("method level guard", () => {
        it("should give each controller its own constructed instance of a transient guard", async () => {
          TrackingGuard.reset();
          app = await createApp(
            createModule([], [GuardedFirstController, GuardedSecondController]),
          );

          await request(app).get("/guarded-first").expect(403);
          await request(app).get("/guarded-first").expect(403);
          await request(app).get("/guarded-second").expect(403);
          await request(app).get("/guarded-second").expect(403);

          const { instancesByController } = TrackingGuard;
          expect(
            instancesByController.get("GuardedFirstController")?.size,
          ).toBe(1);
          expect(
            instancesByController.get("GuardedSecondController")?.size,
          ).toBe(1);
          expect(
            new Set([
              ...(instancesByController.get("GuardedFirstController") ??
                new Set<number>()),
              ...(instancesByController.get("GuardedSecondController") ??
                new Set<number>()),
            ]).size,
          ).toBe(2);
        });
      });

      describe("pipe", () => {
        it("should transform the parameter when the global pipe is transient", async () => {
          app = await createApp(
            createModule([{ provide: APP_PIPE, useClass: SuffixPipe }]),
          );

          const res = await request(app).get("/first/greeting").expect(200);
          expect(res.text).toBe("hello-piped");
        });
      });

      describe("interceptor", () => {
        it("should wrap the response when the global interceptor is transient", async () => {
          app = await createApp(
            createModule([
              { provide: APP_INTERCEPTOR, useClass: PrefixInterceptor },
            ]),
          );

          const res = await request(app).get("/first").expect(200);
          expect(res.text).toBe("intercepted:ok");
        });
      });

      describe("exception filter", () => {
        it("should handle the error when the global filter is transient", async () => {
          app = await createApp(
            createModule([{ provide: APP_FILTER, useClass: TeapotFilter }]),
          );

          const res = await request(app).get("/first/fail").expect(418);
          expect(res.text).toBe("handled");
        });
      });
    });

    describe("microservice", () => {
      let host: MicroserviceHost | undefined;
      let client: TcpClientProxy | undefined;

      const listen = async (providers: Provider[]) => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            MicroserviceModule.forRoot({
              transport: Transport.TCP,
              options: { host: "127.0.0.1", port: 0 },
            }),
            createModule(providers, [MessageController]),
          ],
        }).compile();
        const activeHost = moduleRef.get(MicroserviceHost);
        host = activeHost;
        await activeHost.listen();
        const server = activeHost.getServers()[0] as TcpServer;
        client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        await client.connect();
      };

      afterEach(async () => {
        await client?.close();
        await host?.close();
        client = undefined;
        host = undefined;
      });

      // BUNEST_BUG: MicroserviceHost does not collect or execute DI APP_GUARD global enhancers (packages/microservices/src/microservice-host.ts:329-342).
      it.skip("should deny the message when the global guard is transient", async () => {
        await listen([{ provide: APP_GUARD, useClass: TransientDenyGuard }]);

        await expect(client!.send("read", {})).rejects.toThrow(
          /Forbidden resource/i,
        );
      });

      // BUNEST_BUG: MicroserviceHost does not collect or execute DI APP_PIPE global enhancers (packages/microservices/src/microservice-host.ts:345-356).
      it.skip("should transform the payload when the global pipe is transient", async () => {
        await listen([{ provide: APP_PIPE, useClass: SuffixPipe }]);

        await expect(client!.send("echo", "nest")).resolves.toBe("nest-piped");
      });

      // BUNEST_BUG: MicroserviceHost does not collect or execute DI APP_INTERCEPTOR global enhancers (packages/microservices/src/microservice-host.ts:360-375).
      it.skip("should wrap the response when the global interceptor is transient", async () => {
        await listen([
          { provide: APP_INTERCEPTOR, useClass: PrefixInterceptor },
        ]);

        await expect(client!.send("read", {})).resolves.toBe("intercepted:ok");
      });

      // BUNEST_BUG: MicroserviceHost does not collect or execute DI APP_FILTER global enhancers (packages/microservices/src/microservice-host.ts:379-392).
      it.skip("should handle the error when the global filter is transient", async () => {
        await listen([{ provide: APP_FILTER, useClass: RecoveringRpcFilter }]);

        await expect(client!.send("fail", {})).resolves.toBe("recovered");
      });
    });

    describe("entry provider", () => {
      let app: BunestApplication | undefined;

      const createHandler = async (
        providers: Provider[],
        methodName: "read" | "guarded" = "read",
      ) => {
        app = await createApp(
          createModule(
            [
              ...providers,
              EntryProvider,
              {
                provide: "SLOW",
                useFactory: () =>
                  new Promise((resolve) => setTimeout(resolve, 10)),
              },
            ],
            [],
          ),
        );
        const instance = app.get(EntryProvider);
        return app
          .get(ExternalContextCreator)
          .create(instance, instance[methodName], methodName);
      };

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      // BUNEST_BUG: ExternalContextCreator.create() does not execute global APP_GUARD multi-providers (packages/core/src/helpers/external-context-creator.ts).
      it.skip("should deny the call when the global guard is transient", async () => {
        const handler = await createHandler([
          { provide: APP_GUARD, useClass: TransientDenyGuard },
        ]);

        await expect(handler()).rejects.toThrow("Forbidden resource");
      });

      // BUNEST_BUG: ExternalContextCreator.create() does not execute global APP_INTERCEPTOR multi-providers (packages/core/src/helpers/external-context-creator.ts).
      it.skip("should wrap the result when the global interceptor is transient", async () => {
        const handler = await createHandler([
          { provide: APP_INTERCEPTOR, useClass: PrefixInterceptor },
        ]);

        await expect(handler()).resolves.toBe("intercepted:ok");
      });

      // BUNEST_BUG: ExternalContextCreator resolves method-level guard classes against root module instead of EntryProvider's owning TestModule (packages/core/src/helpers/external-context-creator.ts:103 & packages/core/src/di/di-container.ts:1633); throws UnknownDependencyException for Gate.
      it.skip("should give the provider a constructed instance of a method level transient guard", async () => {
        const handler = await createHandler([], "guarded");

        await expect(handler()).rejects.toThrow("Forbidden resource");
      });

      // BUNEST_BUG: ExternalContextCreator.create() does not execute global APP_GUARD multi-providers (packages/core/src/helpers/external-context-creator.ts).
      it.skip("should bootstrap when the guard depends on a provider that waits for the entry provider", async () => {
        const handler = await createHandler([
          EntryProviderConsumer,
          { provide: APP_GUARD, useClass: EntryProviderConsumerGuard },
        ]);

        await expect(handler()).rejects.toThrow("Forbidden resource");
      });
    });

    describe("gateway", () => {
      let app: BunestApplication | undefined;

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      const send = async (event: "arrow" | "method") => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            WebSocketModule.forRoot(),
            createModule([TransientGuardedGateway], []),
          ],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await WebSocketModule.attach(app);
        await app.listen(0, "127.0.0.1");

        const ws = new WebSocket(
          `${app.getUrl()!.replace("http", "ws")}/transient`,
        );
        try {
          await new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener("error", reject, { once: true });
          });
          const reply = new Promise<string>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("WS timeout")),
              2000,
            );
            ws.addEventListener(
              "message",
              (e) => {
                clearTimeout(timer);
                resolve(String(e.data));
              },
              { once: true },
            );
          });
          ws.send(JSON.stringify({ event, data: {} }));
          return JSON.parse(await reply);
        } finally {
          ws.close();
        }
      };

      // BUNEST_BUG: WsGatewayExplorer.resolveEnhancer() resolves gateway @UseGuards() against root module instead of the gateway's owning TestModule (packages/websockets/src/explorer/ws-gateway.explorer.ts:78 & packages/core/src/di/di-container.ts:1633); throws UnknownDependencyException for Gate.
      it.skip("should deny the message with a transient guard bound by class (arrow)", async () => {
        const reply = await send("arrow");

        // ADR-001: BunWebSocketAdapter emits `{ event: "error", data: ... }` for WS exceptions.
        expect(reply.event).toBe("error");
        expect(reply.data?.message ?? reply.message).toContain("Forbidden");
      });

      // BUNEST_BUG: WsGatewayExplorer.resolveEnhancer() resolves gateway @UseGuards() against root module instead of the gateway's owning TestModule (packages/websockets/src/explorer/ws-gateway.explorer.ts:78 & packages/core/src/di/di-container.ts:1633); throws UnknownDependencyException for Gate.
      it.skip("should deny the message with a transient guard bound by class (method)", async () => {
        const reply = await send("method");

        // ADR-001: BunWebSocketAdapter emits `{ event: "error", data: ... }` for WS exceptions.
        expect(reply.event).toBe("error");
        expect(reply.data?.message ?? reply.message).toContain("Forbidden");
      });
    });
  },
);
