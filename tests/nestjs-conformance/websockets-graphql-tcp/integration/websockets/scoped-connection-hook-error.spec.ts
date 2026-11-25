import { afterEach, expect, it } from "bun:test";
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Inject,
  Injectable,
  type Provider,
  REQUEST,
  Scope,
  UseFilters,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  type BunWsClient,
  type OnGatewayConnection,
  WebSocketGateway,
  WebSocketModule,
  WsException,
  type WsMessageFrame,
} from "../../../../../packages/core/src/ws";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
} from "../../../_helpers";

@Injectable({ scope: Scope.REQUEST })
class ConnectionState {
  constructor(@Inject(REQUEST) readonly client: BunWsClient) {}
}

@WebSocketGateway({ path: "/ws" })
class ImplicitLeakyRejectingGateway implements OnGatewayConnection {
  constructor(@Inject(ConnectionState) readonly state: ConnectionState) {}

  handleConnection(): void {
    throw new WsException("Unauthorized");
  }
}

@WebSocketGateway({ path: "/ws", scope: Scope.REQUEST })
class RejectingGateway implements OnGatewayConnection {
  constructor(@Inject(ConnectionState) readonly state: ConnectionState) {}

  handleConnection(): void {
    throw new WsException("Unauthorized");
  }
}

@Injectable({ scope: Scope.REQUEST })
class Session {
  constructor(@Inject(REQUEST) private readonly client: BunWsClient) {}

  end(reason: string): void {
    this.client.close(4401, reason);
  }
}

@Catch(WsException)
@Injectable({ scope: Scope.REQUEST })
class EndSessionFilter implements ExceptionFilter<WsException> {
  constructor(@Inject(Session) private readonly session: Session) {}

  catch(exception: WsException): void {
    this.session.end(exception.message);
  }
}

@UseFilters(EndSessionFilter)
@WebSocketGateway({ path: "/ws", scope: Scope.REQUEST })
class SessionGateway implements OnGatewayConnection {
  handleConnection(): void {
    throw new WsException("Unauthorized");
  }
}

@Injectable({ scope: Scope.REQUEST })
class CurrentUser {
  constructor() {
    throw new WsException("Unauthorized");
  }
}

@UseFilters(EndSessionFilter)
@WebSocketGateway({ path: "/ws", scope: Scope.REQUEST })
class UserGateway implements OnGatewayConnection {
  constructor(@Inject(CurrentUser) readonly user: CurrentUser) {}

  handleConnection(): void {}
}

@Injectable()
class AuditLog {
  readonly entries: string[] = [];

  record(entry: string): void {
    this.entries.push(entry);
  }
}

@Catch(WsException)
@Injectable({ scope: Scope.TRANSIENT })
class AuditFilter implements ExceptionFilter<WsException> {
  constructor(@Inject(AuditLog) private readonly auditLog: AuditLog) {}

  catch(exception: WsException, host: ArgumentsHost): void {
    this.auditLog.record(exception.message);
    host.switchToWs().getClient<BunWsClient>().close(4401, exception.message);
  }
}

@UseFilters(AuditFilter)
@WebSocketGateway({ path: "/ws" })
class AuditedGateway implements OnGatewayConnection {
  handleConnection(): void {
    throw new WsException("Unauthorized");
  }
}

@WebSocketGateway({ path: "/ws" })
class UnserializableErrorGateway implements OnGatewayConnection {
  handleConnection(): void {
    // BigInt cannot be JSON-serialized by the default WS filter
    throw new WsException({ id: 10n });
  }
}

function waitForClose(
  client: WebSocket,
  timeoutMs = 2000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WS close")),
      timeoutMs,
    );
    client.addEventListener(
      "close",
      (evt) => {
        clearTimeout(timer);
        resolve({ code: evt.code, reason: evt.reason });
      },
      { once: true },
    );
  });
}

describeConformance(
  "WebSocketGateway request scope - connection hook errors",
  {
    upstreamPath:
      "integration/websockets/e2e/scoped-connection-hook-error.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Adapted to Bunest native WebSocket (ADR-001) and explicit Scope.REQUEST / ScopeLeakException (ADR-012).",
  },
  () => {
    let app: BunestApplication | undefined;
    const clients: WebSocket[] = [];

    async function start(
      providers: Provider[] = [ConnectionState, RejectingGateway],
    ): Promise<number> {
      const testingModule = await Test.createTestingModule({
        imports: [WebSocketModule.forRoot()],
        providers,
      }).compile({ logger: false });
      app = testingModule.createNestApplication({ logger: false });
      await WebSocketModule.attach(app);
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
      return info.port;
    }

    afterEach(async () => {
      for (const client of clients.splice(0)) {
        if (
          client.readyState === WebSocket.OPEN ||
          client.readyState === WebSocket.CONNECTING
        ) {
          client.close();
        }
      }
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    itAdapted(
      "ADR-012",
      "should fail fast with ScopeLeakException when a singleton gateway injects a Scope.REQUEST dependency",
      async () => {
        await expectScopeLeak(
          () =>
            Test.createTestingModule({
              imports: [WebSocketModule.forRoot()],
              providers: [ConnectionState, ImplicitLeakyRejectingGateway],
            }).compile({ logger: false }),
          /ImplicitLeakyRejectingGateway/,
        );
      },
      "fail-fast scope leak",
    );

    it("should send the exception to a ws client [ADR-001, ADR-012]", async () => {
      const port = await start([ConnectionState, RejectingGateway]);
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      clients.push(client);

      const message = await new Promise<WsMessageFrame>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for error frame")),
          1500,
        );
        client.addEventListener("message", (evt) => {
          clearTimeout(timer);
          resolve(JSON.parse(String(evt.data)) as WsMessageFrame);
        });
        client.addEventListener("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      expect(message).toEqual({
        event: "error",
        data: {
          status: "error",
          message: "Unauthorized",
        },
      });
    });

    it("should run a request-scoped filter with the instance of the connection [ADR-001, ADR-012]", async () => {
      const port = await start([Session, SessionGateway]);
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      clients.push(client);

      const { code, reason } = await waitForClose(client);
      expect(code).toBe(4401);
      expect(reason).toBe("Unauthorized");
    });

    it("should run a request-scoped filter when the gateway fails to resolve [ADR-001, ADR-012]", async () => {
      const port = await start([Session, CurrentUser, UserGateway]);
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      clients.push(client);

      const { code, reason } = await waitForClose(client);
      expect(code).toBe(4401);
      expect(reason).toBe("Unauthorized");
    });

    it("should run a transient filter of a default-scoped gateway with its dependencies [ADR-001]", async () => {
      const port = await start([AuditLog, AuditedGateway]);
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      clients.push(client);

      const { code, reason } = await waitForClose(client);
      expect(code).toBe(4401);
      expect(reason).toBe("Unauthorized");
      expect(app!.get(AuditLog).entries).toEqual(["Unauthorized"]);
    });

    itAdapted(
      "ADR-001",
      "should keep serving when a connection hook throws an unserializable WsException",
      async () => {
        const port = await start([UnserializableErrorGateway]);
        const wsUrl = `ws://127.0.0.1:${port}/ws`;

        const connectAndOpen = async (): Promise<void> => {
          const client = new WebSocket(wsUrl);
          clients.push(client);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Timed out opening WebSocket")),
              2000,
            );
            client.addEventListener("open", () => {
              clearTimeout(timer);
              resolve();
            });
            client.addEventListener("error", (err) => {
              clearTimeout(timer);
              reject(err);
            });
          });
          expect(client.readyState).toBe(WebSocket.OPEN);
        };

        await connectAndOpen();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await connectAndOpen();
      },
      "native Bun WS server resilience",
    );
  },
);
