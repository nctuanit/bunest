import { afterEach, beforeEach, describe, expect } from "bun:test";
import {
  Inject,
  Injectable,
  Module,
  type MicroserviceInstance,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from "../../../../../packages/core/src/common";
import {
  BunestApplicationContext,
  BunestFactory,
} from "../../../../../packages/core/src";
import {
  BunWebSocketAdapter,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  type WsMessageFrame,
} from "../../../../../packages/core/src/ws";
import { Test, describeConformance, itAdapted } from "../../../_helpers";

let hooksCanComplete: Promise<void>;

async function reserveEphemeralPort(): Promise<number> {
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response("ok");
    },
  });
  const port = probe.port ?? 0;
  await probe.stop(true);
  if (port <= 0) {
    throw new Error("Failed to reserve an ephemeral port");
  }
  return port;
}

@Injectable()
class StartupService implements OnModuleInit, OnApplicationBootstrap {
  state = "constructed";
  calls: string[] = [];

  async onModuleInit(): Promise<void> {
    await hooksCanComplete;
    this.state = "initialized";
  }

  async onApplicationBootstrap(): Promise<void> {
    // Long enough for a reconnecting client to attempt connections while running
    await new Promise((resolve) => setTimeout(resolve, 100));
    this.state = "bootstrapped";
  }
}

@WebSocketGateway({ path: "/ws" })
class StartupGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    @Inject(StartupService) private readonly startup: StartupService,
  ) {}

  handleConnection(): void {
    this.startup.calls.push(`connection: ${this.startup.state}`);
  }

  handleDisconnect(): void {
    this.startup.calls.push(`disconnection: ${this.startup.state}`);
  }

  @SubscribeMessage("state")
  getState(): { event: string; data: string } {
    this.startup.calls.push(`message: ${this.startup.state}`);
    return { event: "state", data: this.startup.state };
  }
}

class StandaloneWsMicroserviceTransport implements MicroserviceInstance {
  constructor(
    private readonly adapter: BunWebSocketAdapter,
    private readonly port: number,
  ) {}

  async listen(): Promise<void> {
    await this.adapter.listen({ port: this.port, hostname: "127.0.0.1" });
  }

  async close(): Promise<void> {
    await this.adapter.closeAll();
  }
}

function trySingleConnectAndAskState(
  url: string,
): Promise<{ opened: boolean; reply?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (result: { opened: boolean; reply?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ opened: false }), 500);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ event: "state" }));
    });
    ws.addEventListener("message", (evt) => {
      if (typeof evt.data === "string") {
        const parsed = JSON.parse(evt.data) as WsMessageFrame<string>;
        finish({ opened: true, reply: parsed.data });
      }
    });
    ws.addEventListener("close", () => {
      finish({ opened: false });
    });
    ws.addEventListener("error", () => {
      finish({ opened: false });
    });
  });
}

describeConformance(
  "WebSocketGateway - clients connecting during startup",
  {
    upstreamPath:
      "integration/websockets/e2e/connection-during-startup.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapted from NestJS WsAdapter/Socket.IO own-port startup test to Bunest native Bun.serve WebSocket (ADR-001). Both BunestApplication.listen() and BunestMicroserviceApplication.listen() await onModuleInit and onApplicationBootstrap before accepting WebSocket connections.",
  },
  () => {
    let app: BunestApplicationContext | undefined;
    let started: Promise<unknown> | undefined;
    let completeHooks: () => void = () => {};
    let port = 0;
    const activeSockets: WebSocket[] = [];

    beforeEach(async () => {
      port = await reserveEphemeralPort();
      hooksCanComplete = new Promise<void>((resolve) => {
        completeHooks = resolve;
      });
    });

    afterEach(async () => {
      for (const s of activeSockets.splice(0)) {
        if (
          s.readyState === WebSocket.OPEN ||
          s.readyState === WebSocket.CONNECTING
        ) {
          s.close();
        }
      }
      completeHooks();
      if (started) {
        await started.catch(() => {});
        started = undefined;
      }
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    const targets = {
      application: async () => {
        const testingModule = await Test.createTestingModule({
          imports: [WebSocketModule.forRoot()],
          providers: [StartupService, StartupGateway],
        }).compile({ logger: false });
        const nestApp = testingModule.createNestApplication({ logger: false });
        await WebSocketModule.attach(nestApp);
        app = nestApp;
        started = nestApp.listen({ port, hostname: "127.0.0.1" });
      },
      microservice: async () => {
        @Module({
          imports: [WebSocketModule.forRoot()],
          providers: [StartupService, StartupGateway],
        })
        class StartupMicroserviceModule {}

        const microservice = await BunestFactory.createMicroservice(
          StartupMicroserviceModule,
          (ctx) =>
            new StandaloneWsMicroserviceTransport(
              ctx.get(BunWebSocketAdapter),
              port,
            ),
          { logger: false },
        );
        app = microservice;
        started = microservice.listen();
      },
    } as const;

    async function askForStateOnceReady(): Promise<string> {
      const url = `ws://127.0.0.1:${port}/ws`;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const attempt = await trySingleConnectAndAskState(url);
        if (attempt.opened && attempt.reply !== undefined) {
          return attempt.reply;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for WS state response on ${url}`);
    }

    describe.each(["application", "microservice"] as const)("%s", (target) => {
      itAdapted(
        "ADR-001",
        "should refuse clients until lifecycle hooks have completed",
        async () => {
          await targets[target]();

          // While onModuleInit() is pending, the port is not yet accepting traffic
          const premature = await trySingleConnectAndAskState(
            `ws://127.0.0.1:${port}/ws`,
          );
          expect(premature.opened).toBe(false);
          expect(premature.reply).toBeUndefined();
          expect(app!.get(StartupService).calls).toEqual([]);

          completeHooks();
          await started;

          expect(await askForStateOnceReady()).toBe("bootstrapped");
          expect(app!.get(StartupService).calls.slice(0, 2)).toEqual([
            "connection: bootstrapped",
            "message: bootstrapped",
          ]);
        },
        "native Bun WS",
      );

      itAdapted(
        "ADR-001",
        "should serve a reconnecting client once lifecycle hooks have completed",
        async () => {
          await targets[target]();

          const url = `ws://127.0.0.1:${port}/ws`;
          let failedAttemptsBeforeReady = 0;

          // Attempt connecting before hooks complete
          const earlyAttempt = await trySingleConnectAndAskState(url);
          if (!earlyAttempt.opened) {
            failedAttemptsBeforeReady += 1;
          }
          expect(failedAttemptsBeforeReady).toBe(1);
          expect(app!.get(StartupService).calls).toEqual([]);

          // Start a reconnecting loop, then release onModuleInit (onApplicationBootstrap still waits 100ms)
          const statePromise = askForStateOnceReady();
          completeHooks();

          // Immediately after releasing onModuleInit, onApplicationBootstrap is still running
          expect(app!.get(StartupService).state).not.toBe("bootstrapped");

          expect(await statePromise).toBe("bootstrapped");
          await started;
          expect(app!.get(StartupService).calls.slice(0, 2)).toEqual([
            "connection: bootstrapped",
            "message: bootstrapped",
          ]);
        },
        "native Bun WS reconnection loop",
      );
    });
  },
);
