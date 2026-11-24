import { afterEach, expect, it } from "bun:test";
import {
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type Type,
  UseInterceptors,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  BunWebSocketAdapter,
  type BunWsClient,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  type WsMessageFrame,
} from "../../../../../packages/core/src/ws";
import { Test, describeConformance, itAdapted } from "../../../_helpers";

type PatternClient = BunWsClient & { pattern?: string };

@Injectable()
class RequestInterceptor implements BunestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const client = context.switchToWs().getClient<PatternClient>();
    const pattern = context.switchToWs().getPattern();
    client.pattern = pattern;
    return next.handle();
  }
}

@WebSocketGateway({ path: "/ws" })
class ApplicationGateway {
  @SubscribeMessage("push")
  onPush(@MessageBody() data: Record<string, unknown>): {
    event: string;
    data: Record<string, unknown>;
  } {
    return { event: "pop", data };
  }

  @UseInterceptors(RequestInterceptor)
  @SubscribeMessage("getClient")
  getPathCalled(
    client: PatternClient,
    data: Record<string, unknown>,
  ): { event: string; data: Record<string, unknown> } {
    return {
      event: "popClient",
      data: { ...data, path: client.pattern },
    };
  }
}

@WebSocketGateway({ path: "/ws" })
class CoreGateway {
  @SubscribeMessage("push")
  onPush(
    @ConnectedSocket() _client: BunWsClient,
    @MessageBody() data: Record<string, unknown>,
  ): { event: string; data: Record<string, unknown> } {
    return { event: "pop", data };
  }
}

@WebSocketGateway({ path: "/ws" })
class ServerGateway {
  @SubscribeMessage("push")
  onPush(
    _client: BunWsClient,
    data: Record<string, unknown>,
  ): { event: string; data: Record<string, unknown> } {
    return { event: "pop", data };
  }

  @UseInterceptors(RequestInterceptor)
  @SubscribeMessage("getClient")
  getPathCalled(
    client: PatternClient,
    data: Record<string, unknown>,
  ): { event: string; data: Record<string, unknown> } {
    return {
      event: "popClient",
      data: { ...data, path: client.pattern },
    };
  }
}

@WebSocketGateway({ path: "/ws-path" })
class WsPathGateway {
  @SubscribeMessage("push")
  onPush(
    _client: BunWsClient,
    data: Record<string, unknown>,
  ): { event: string; data: Record<string, unknown> } {
    return { event: "pop", data };
  }
}

@WebSocketGateway({ path: "/example" })
class ExamplePathGateway {
  @SubscribeMessage("push")
  onPush(
    _client: BunWsClient,
    data: Record<string, unknown>,
  ): { event: string; data: Record<string, unknown> } {
    return { event: "pop", data };
  }
}

@WebSocketGateway({ path: "/ws-path" })
class WsPathGateway2 {
  @SubscribeMessage("push")
  onPush(
    _client: BunWsClient,
    data: Record<string, unknown>,
  ): { event: string; data: Record<string, unknown> } {
    return { event: "pop", data };
  }
}

async function openWs(url: string, tracked: WebSocket[]): Promise<WebSocket> {
  const ws = new WebSocket(url);
  tracked.push(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out opening WebSocket ${url}`)),
      2000,
    );
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
      { once: true },
    );
  });
  return ws;
}

function sendAndReceive(
  ws: WebSocket,
  payload: string,
): Promise<WsMessageFrame<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket message")),
      2000,
    );
    ws.addEventListener(
      "message",
      (evt) => {
        clearTimeout(timer);
        resolve(
          JSON.parse(String(evt.data)) as WsMessageFrame<
            Record<string, unknown>
          >,
        );
      },
      { once: true },
    );
    ws.send(payload);
  });
}

describeConformance(
  "WebSocketGateway (BunWebSocketAdapter)",
  {
    upstreamPath: "integration/websockets/e2e/ws-gateway.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Ported from WsAdapter to Bunest native BunWebSocketAdapter (ADR-001) and Promise CallHandler interceptors (ADR-008), using ephemeral ports (port: 0).",
  },
  () => {
    let app: BunestApplication | undefined;
    const standaloneAdapters: BunWebSocketAdapter[] = [];
    const sockets: WebSocket[] = [];

    async function startApp(...gateways: Type<unknown>[]): Promise<number> {
      const testingModule = await Test.createTestingModule({
        imports: [WebSocketModule.forRoot()],
        providers: gateways,
      }).compile({ logger: false });
      app = testingModule.createNestApplication({ logger: false });
      await WebSocketModule.attach(app);
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
      return info.port;
    }

    afterEach(async () => {
      for (const s of sockets.splice(0)) {
        if (
          s.readyState === WebSocket.OPEN ||
          s.readyState === WebSocket.CONNECTING
        ) {
          s.close();
        }
      }
      for (const adapter of standaloneAdapters.splice(0)) {
        await adapter.closeAll();
      }
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    itAdapted(
      "ADR-001",
      "should handle message (2nd port)",
      async () => {
        // HTTP app listens on port A; standalone BunWebSocketAdapter serves gateway on port B
        const testingModule = await Test.createTestingModule({
          providers: [ApplicationGateway],
        }).compile({ logger: false });
        app = testingModule.createNestApplication({ logger: false });
        const httpInfo = await app.listen({ port: 0, hostname: "127.0.0.1" });

        const wsAdapter = new BunWebSocketAdapter();
        standaloneAdapters.push(wsAdapter);
        await wsAdapter.registerGateway(app.get(ApplicationGateway));
        const wsInfo = await wsAdapter.listen({
          port: 0,
          hostname: "127.0.0.1",
        });

        expect(wsInfo.port).not.toBe(httpInfo.port);

        const ws = await openWs(`ws://127.0.0.1:${wsInfo.port}/ws`, sockets);
        const reply = await sendAndReceive(
          ws,
          JSON.stringify({ event: "push", data: { test: "test" } }),
        );
        expect(reply.event).toBe("pop");
        expect(reply.data?.test).toEqual("test");
      },
      "standalone BunWebSocketAdapter on 2nd ephemeral port",
    );

    itAdapted(
      "ADR-001",
      "should handle message (http)",
      async () => {
        const port = await startApp(ServerGateway);
        const ws = await openWs(`ws://127.0.0.1:${port}/ws`, sockets);

        const reply = await sendAndReceive(
          ws,
          JSON.stringify({ event: "push", data: { test: "test" } }),
        );
        expect(reply.event).toBe("pop");
        expect(reply.data?.test).toEqual("test");
      },
      "shared HTTP/WS Bun.serve server",
    );

    itAdapted(
      "ADR-001",
      "should handle message on a different path",
      async () => {
        const port = await startApp(WsPathGateway);
        const ws = await openWs(`ws://127.0.0.1:${port}/ws-path`, sockets);

        const reply = await sendAndReceive(
          ws,
          JSON.stringify({ event: "push", data: { test: "test" } }),
        );
        expect(reply.event).toBe("pop");
        expect(reply.data?.test).toEqual("test");
      },
      "custom gateway path",
    );

    itAdapted(
      "ADR-001",
      "should support 2 different gateways running on different paths",
      async () => {
        const port = await startApp(ExamplePathGateway, WsPathGateway2);

        const [ws1, ws2] = await Promise.all([
          openWs(`ws://127.0.0.1:${port}/example`, sockets),
          openWs(`ws://127.0.0.1:${port}/ws-path`, sockets),
        ]);

        const reply1 = await sendAndReceive(
          ws1,
          JSON.stringify({ event: "push", data: { test: "test" } }),
        );
        expect(reply1.event).toBe("pop");
        expect(reply1.data?.test).toEqual("test");

        const reply2 = await sendAndReceive(
          ws2,
          JSON.stringify({ event: "push", data: { test: "test" } }),
        );
        expect(reply2.event).toBe("pop");
        expect(reply2.data?.test).toEqual("test");
      },
      "multi-path gateway multiplexing",
    );

    itAdapted(
      "ADR-001",
      "should support 2 different gateways running on the same path (but different ports)",
      async () => {
        const testingModule = await Test.createTestingModule({
          providers: [ApplicationGateway, CoreGateway],
        }).compile({ logger: false });
        app = testingModule.createNestApplication({ logger: false });
        await app.listen({ port: 0, hostname: "127.0.0.1" });

        const adapter1 = new BunWebSocketAdapter();
        const adapter2 = new BunWebSocketAdapter();
        standaloneAdapters.push(adapter1, adapter2);

        await adapter1.registerGateway(app.get(ApplicationGateway));
        await adapter2.registerGateway(app.get(CoreGateway));

        const [info1, info2] = await Promise.all([
          adapter1.listen({ port: 0, hostname: "127.0.0.1" }),
          adapter2.listen({ port: 0, hostname: "127.0.0.1" }),
        ]);

        expect(info1.port).not.toBe(info2.port);

        const [ws1, ws2] = await Promise.all([
          openWs(`ws://127.0.0.1:${info1.port}/ws`, sockets),
          openWs(`ws://127.0.0.1:${info2.port}/ws`, sockets),
        ]);

        const reply1 = await sendAndReceive(
          ws1,
          JSON.stringify({ event: "push", data: { test: "test" } }),
        );
        expect(reply1.data?.test).toEqual("test");

        const reply2 = await sendAndReceive(
          ws2,
          JSON.stringify({ event: "push", data: { test: "test" } }),
        );
        expect(reply2.data?.test).toEqual("test");
      },
      "two standalone BunWebSocketAdapters on distinct ephemeral ports",
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "should let the execution context have a getPattern() method on getClient()",
      async () => {
        const port = await startApp(ApplicationGateway);
        const ws = await openWs(`ws://127.0.0.1:${port}/ws`, sockets);

        const reply = await sendAndReceive(
          ws,
          JSON.stringify({ event: "getClient", data: { test: "test" } }),
        );
        expect(reply.event).toBe("popClient");
        expect(reply.data?.path).toEqual("getClient");
      },
      "WsExecutionContext.switchToWs().getPattern()",
    );

    // BUNEST_BUG: BunWebSocketAdapter does not implement setMessageParser() and hardcodes parseWsFrame() for `{ event, data?, id? }` JSON frames (packages/core/src/ws/adapter/bun-ws.adapter.ts#L755).
    it.skip("should set messageParser by using setMessageParser method", async () => {
      const testingModule = await Test.createTestingModule({
        providers: [ApplicationGateway],
      }).compile({ logger: false });
      app = testingModule.createNestApplication({ logger: false });

      const wsAdapter = new BunWebSocketAdapter() as BunWebSocketAdapter & {
        setMessageParser?: (
          parser: (raw: string | Uint8Array) => {
            event: string;
            data: unknown;
          },
        ) => void;
      };
      standaloneAdapters.push(wsAdapter);
      expect(typeof wsAdapter.setMessageParser).toBe("function");
      wsAdapter.setMessageParser!((data) => {
        const [event, payload] = JSON.parse(String(data)) as [string, unknown];
        return { event, data: payload };
      });
      await wsAdapter.registerGateway(app.get(ApplicationGateway));
      const info = await wsAdapter.listen({ port: 0, hostname: "127.0.0.1" });

      const ws = await openWs(`ws://127.0.0.1:${info.port}/ws`, sockets);
      const reply = await sendAndReceive(
        ws,
        JSON.stringify(["push", { test: "test" }]),
      );
      expect(reply.data?.test).toEqual("test");
    });

    // BUNEST_BUG: WebSocketModuleOptions / BunWebSocketAdapter constructor does not accept a custom `messageParser` option and hardcodes parseWsFrame() (packages/core/src/ws/interfaces/ws.interface.ts#L174, packages/core/src/ws/adapter/bun-ws.adapter.ts#L755).
    it.skip("should set messageParser by using constructor options", async () => {
      const testingModule = await Test.createTestingModule({
        providers: [ApplicationGateway],
      }).compile({ logger: false });
      app = testingModule.createNestApplication({ logger: false });

      const wsAdapter = new BunWebSocketAdapter({
        messageParser: (data: string | Uint8Array) => {
          const [event, payload] = JSON.parse(String(data)) as [
            string,
            unknown,
          ];
          return { event, data: payload };
        },
      } as Record<string, unknown>);
      standaloneAdapters.push(wsAdapter);
      await wsAdapter.registerGateway(app.get(ApplicationGateway));
      const info = await wsAdapter.listen({ port: 0, hostname: "127.0.0.1" });

      const ws = await openWs(`ws://127.0.0.1:${info.port}/ws`, sockets);
      const reply = await sendAndReceive(
        ws,
        JSON.stringify(["push", { test: "test" }]),
      );
      expect(reply.data?.test).toEqual("test");
    });
  },
);
