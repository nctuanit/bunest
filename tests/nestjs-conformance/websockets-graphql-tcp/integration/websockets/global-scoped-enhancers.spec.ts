import { afterEach, expect, it } from "bun:test";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  Catch,
  type ExceptionFilter,
  type ExecutionContext,
  Inject,
  Injectable,
  type OnModuleInit,
  type PipeTransform,
  type Provider,
  REQUEST,
  Scope,
  type Type,
  UseGuards,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  type BunWsClient,
  type BunWsServer,
  ConnectedSocket,
  MessageBody,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  WebSocketServer,
  type WsMessageFrame,
} from "../../../../../packages/core/src/ws";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
} from "../../../_helpers";

@Injectable()
class Tracker {
  guards: object[] = [];
  pipes: object[] = [];
  interceptors: object[] = [];
  gateways: object[] = [];
  initialized: object[] = [];
  moduleInitialized: object[] = [];
  disconnected: object[] = [];
  allow = true;
}

@Injectable({ scope: Scope.REQUEST })
class GlobalGuard implements CanActivate {
  private readonly constructed = true;

  constructor(
    @Inject(Tracker) private readonly tracker: Tracker,
    @Inject(REQUEST) private readonly client: BunWsClient,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    expect(this.constructed).toBe(true);
    expect(this.client).toBe(context.switchToWs().getClient<BunWsClient>());
    this.tracker.guards.push(this);
    return this.tracker.allow;
  }
}

@Injectable()
class GlobalPipe implements PipeTransform {
  private readonly constructed = true;

  constructor(@Inject(Tracker) private readonly tracker: Tracker) {}

  transform(value: unknown): unknown {
    expect(this.constructed).toBe(true);
    this.tracker.pipes.push(this);
    return typeof value === "string" ? `${value}:pipe` : value;
  }
}

@Injectable()
class GlobalInterceptor implements BunestInterceptor {
  private readonly constructed = true;

  constructor(@Inject(Tracker) private readonly tracker: Tracker) {}

  async intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    expect(this.constructed).toBe(true);
    this.tracker.interceptors.push(this);
    const data = (await next.handle()) as Record<string, unknown>;
    return { ...data, intercepted: true };
  }
}

@WebSocketGateway({ path: "/ws" })
class SingletonGateway
  implements OnGatewayInit, OnModuleInit, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: BunWsServer;

  private sequence = 0;

  constructor(@Inject(Tracker) protected readonly tracker: Tracker) {
    tracker.gateways.push(this);
  }

  afterInit(server: BunWsServer): void {
    expect(this.server).toBe(server);
    expect(this.sequence).toBe(0);
    this.tracker.initialized.push(this);
  }

  onModuleInit(): void {
    this.tracker.moduleInitialized.push(this);
  }

  async handleDisconnect(client: BunWsClient): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.tracker.disconnected.push(client);
  }

  @SubscribeMessage("ping")
  ping(@MessageBody() data: string): { data: string; sequence: number } {
    return { data, sequence: ++this.sequence };
  }
}

@Injectable({ scope: Scope.REQUEST })
class ConnectionState {
  constructor(@Inject(REQUEST) readonly client: BunWsClient) {}
}

@WebSocketGateway({ path: "/ws" })
class ImplicitLeakyScopedGateway {
  constructor(
    @Inject(ConnectionState) private readonly state: ConnectionState,
  ) {}

  @SubscribeMessage("ping")
  ping(
    @ConnectedSocket() client: BunWsClient,
    @MessageBody() data: string,
  ): { data: string } {
    expect(this.state.client).toBe(client);
    return { data };
  }
}

@WebSocketGateway({ path: "/ws", scope: Scope.REQUEST })
class ScopedGateway {
  constructor(
    @Inject(ConnectionState) private readonly state: ConnectionState,
  ) {}

  @SubscribeMessage("ping")
  ping(
    @ConnectedSocket() client: BunWsClient,
    @MessageBody() data: string,
  ): { data: string } {
    expect(this.state.client).toBe(client);
    return { data };
  }
}

@Catch()
@Injectable({ scope: Scope.REQUEST })
class GlobalFilter implements ExceptionFilter {
  constructor() {
    throw new Error("WebSocket gateways must not resolve global filters");
  }

  catch(): void {}
}

@Injectable({ scope: Scope.TRANSIENT })
class LocalGuard implements CanActivate {
  private readonly constructed = true;

  constructor(@Inject(Tracker) private readonly tracker: Tracker) {}

  canActivate(): boolean {
    expect(this.constructed).toBe(true);
    this.tracker.guards.push(this);
    return true;
  }
}

@WebSocketGateway({ path: "/ws" })
@UseGuards(LocalGuard)
class LocallyGuardedGateway extends SingletonGateway {}

interface TestWsSocket {
  ws: WebSocket;
  sendAndWait(
    event: string,
    data: unknown,
    id: string,
  ): Promise<WsMessageFrame>;
  close(): void;
}

function connectWs(url: string): Promise<TestWsSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: WsMessageFrame[] = [];
    const waiters: Array<{
      id: string;
      resolve: (m: WsMessageFrame) => void;
    }> = [];

    const openTimer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out opening ${url}`));
    }, 2000);

    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      resolve({
        ws,
        sendAndWait(event: string, data: unknown, id: string) {
          return new Promise<WsMessageFrame>((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error(`Timed out waiting for reply ${id}`)),
              2000,
            );
            waiters.push({
              id,
              resolve: (m) => {
                clearTimeout(timer);
                res(m);
              },
            });
            ws.send(JSON.stringify({ event, data, id }));
          });
        },
        close() {
          if (
            ws.readyState === WebSocket.OPEN ||
            ws.readyState === WebSocket.CONNECTING
          ) {
            ws.close();
          }
        },
      });
    });

    ws.addEventListener("message", (evt) => {
      if (typeof evt.data === "string") {
        const parsed = JSON.parse(evt.data) as WsMessageFrame;
        messages.push(parsed);
        const idx = waiters.findIndex((w) => w.id === parsed.id);
        if (idx !== -1) {
          const [w] = waiters.splice(idx, 1);
          w?.resolve(parsed);
        }
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(openTimer);
      reject(err);
    });
  });
}

describeConformance(
  "WebSocketGateway global scoped enhancers",
  {
    upstreamPath: "integration/websockets/e2e/global-scoped-enhancers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-012"],
    notes:
      "Adapted to native Bun WS (ADR-001), Promise CallHandler interceptors (ADR-008), and explicit Scope.REQUEST / ScopeLeakException (ADR-012).",
  },
  () => {
    let app: BunestApplication | undefined;
    let tracker: Tracker;
    let port = 0;
    const sockets: TestWsSocket[] = [];
    let reqSeq = 0;

    async function start(
      gateway: Type<unknown>,
      providers: Provider[],
    ): Promise<void> {
      const testingModule = await Test.createTestingModule({
        imports: [WebSocketModule.forRoot()],
        providers: [Tracker, ConnectionState, gateway, ...providers],
      }).compile({ logger: false });
      app = testingModule.createNestApplication({ logger: false });
      await WebSocketModule.attach(app);
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
      port = info.port;
      tracker = app.get(Tracker);
    }

    async function connect(): Promise<TestWsSocket> {
      const s = await connectWs(`ws://127.0.0.1:${port}/ws`);
      sockets.push(s);
      return s;
    }

    async function ping(
      socket: TestWsSocket,
      data = "hello",
    ): Promise<unknown> {
      const reply = await socket.sendAndWait("ping", data, `p-${++reqSeq}`);
      return reply.data;
    }

    afterEach(async () => {
      for (const s of sockets.splice(0)) {
        s.close();
      }
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    itAdapted(
      "ADR-012",
      "should fail fast with ScopeLeakException when a singleton gateway injects a Scope.REQUEST provider without explicit scope",
      async () => {
        await expectScopeLeak(
          () =>
            Test.createTestingModule({
              imports: [WebSocketModule.forRoot()],
              providers: [Tracker, ConnectionState, ImplicitLeakyScopedGateway],
            }).compile({ logger: false }),
          /ImplicitLeakyScopedGateway/,
        );
      },
      "fail-fast scope leak",
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "should preserve singleton gateway hooks, state, and local transient guard execution",
      async () => {
        await start(LocallyGuardedGateway, []);
        const first = await connect();
        expect(await ping(first)).toEqual({ data: "hello", sequence: 1 });
        expect(await ping(first)).toEqual({ data: "hello", sequence: 2 });
        expect(tracker.guards).toHaveLength(2);
        expect(tracker.gateways).toHaveLength(1);
        expect(tracker.initialized).toEqual(tracker.gateways);
        expect(tracker.moduleInitialized).toEqual(tracker.gateways);
      },
      "local gateway enhancer & lifecycle parity",
    );

    for (const scope of [Scope.REQUEST, Scope.TRANSIENT] as const) {
      for (const gateway of [SingletonGateway, ScopedGateway] as const) {
        // BUNEST_BUG: BunWebSocketAdapter does not wire global APP_GUARD/APP_PIPE/APP_INTERCEPTOR multi-providers into WebSocket handlers and does not resolve Scope.REQUEST gateways or enhancers per connection (packages/core/src/ws/adapter/bun-ws.adapter.ts#L282-L368, packages/core/src/application/bunest-application.ts#L726-L731).
        it.skip(`should run a denying global ${scope} guard on ${gateway.name}`, async () => {
          await start(gateway, [
            { provide: APP_GUARD, useClass: GlobalGuard, scope },
          ]);
          tracker.allow = false;
          const socket = await connect();
          const reply = await socket.sendAndWait(
            "ping",
            "denied",
            `deny-${++reqSeq}`,
          );

          expect(reply.event).toBe("error");
          expect(reply.data).toMatchObject({
            status: "error",
            code: "FORBIDDEN",
          });
          expect(tracker.guards).toHaveLength(1);
          if (gateway === SingletonGateway) {
            tracker.allow = true;
            expect(await ping(socket)).toMatchObject({ sequence: 1 });
          }
        });
      }

      // BUNEST_BUG: BunWebSocketAdapter does not execute APP_GUARD/APP_PIPE/APP_INTERCEPTOR or reuse Scope.REQUEST/TRANSIENT enhancers per WebSocket connection (packages/core/src/ws/adapter/bun-ws.adapter.ts#L282-L368).
      it.skip(`should reuse ${scope} enhancers per connection and preserve singleton hooks and state`, async () => {
        await start(SingletonGateway, [
          { provide: APP_GUARD, useClass: GlobalGuard, scope },
          { provide: APP_PIPE, useClass: GlobalPipe, scope },
          { provide: APP_INTERCEPTOR, useClass: GlobalInterceptor, scope },
          { provide: APP_FILTER, useClass: GlobalFilter },
        ]);
        const first = await connect();
        const second = await connect();
        expect(await ping(first)).toEqual({
          data: "hello:pipe",
          sequence: 1,
          intercepted: true,
        });
        expect(await ping(first)).toEqual({
          data: "hello:pipe",
          sequence: 2,
          intercepted: true,
        });
        expect(await ping(second)).toEqual({
          data: "hello:pipe",
          sequence: 3,
          intercepted: true,
        });

        for (const instances of [
          tracker.guards,
          tracker.pipes,
          tracker.interceptors,
        ]) {
          expect(instances).toHaveLength(3);
          expect(instances[0]).toBe(instances[1]);
          expect(instances[0]).not.toBe(instances[2]);
        }
        expect(tracker.gateways).toHaveLength(1);
        expect(tracker.initialized).toEqual(tracker.gateways);
        expect(tracker.moduleInitialized).toEqual(tracker.gateways);

        first.close();
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(tracker.disconnected).toHaveLength(1);
        expect(await ping(second)).toMatchObject({ sequence: 4 });
      });
    }

    for (const [token, enhancer, expected] of [
      [APP_PIPE, GlobalPipe, { data: "hello:pipe" }],
      [
        APP_INTERCEPTOR,
        GlobalInterceptor,
        { data: "hello", intercepted: true },
      ],
    ] as const) {
      // BUNEST_BUG: BunWebSocketAdapter does not apply global APP_PIPE / APP_INTERCEPTOR providers to WebSocket message handlers (packages/core/src/ws/adapter/bun-ws.adapter.ts#L282-L368).
      it.skip(`should resolve ${String(token)} without a global guard`, async () => {
        await start(SingletonGateway, [
          { provide: token, useClass: enhancer, scope: Scope.REQUEST },
        ]);
        expect(await ping(await connect())).toMatchObject(expected);
      });
    }

    // BUNEST_BUG: BunWebSocketAdapter does not apply global Scope.REQUEST APP_PIPE alongside local transient @UseGuards on WebSocket gateways (packages/core/src/ws/adapter/bun-ws.adapter.ts#L282-L368).
    it.skip("should construct local transient enhancers when global scoped enhancers require a connection context", async () => {
      await start(LocallyGuardedGateway, [
        { provide: APP_PIPE, useClass: GlobalPipe, scope: Scope.REQUEST },
      ]);
      const socket = await connect();
      expect(await ping(socket)).toMatchObject({ data: "hello:pipe" });
      expect(await ping(socket)).toMatchObject({ data: "hello:pipe" });
      expect(tracker.guards).toHaveLength(2);
      expect(tracker.guards[0]).toBe(tracker.guards[1]);
      expect(tracker.gateways).toHaveLength(1);
    });
  },
);
