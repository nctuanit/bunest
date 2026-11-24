import { afterEach, describe, expect, test } from "bun:test";
import { type ArgumentsHost, MetadataRegistry, Module } from "../../src/common/index";
import { BunestFactory } from "../../src/index";
import {
  AbstractWsAdapter,
  type BaseWsInstance,
  BaseWsExceptionFilter,
  type BunWsClient,
  type ErrorPayload,
  type GatewayMetadata,
  MessageBody,
  type MessageMappingProperties,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WS_METADATA_KEYS,
  WebSocketGateway,
  type WebSocketGatewayOptions,
  WebSocketModule,
  WebSocketServer,
  type WebSocketServerOptions,
  WsAdapter,
  type WsAdapterOptions,
  WsException,
  WsExecutionContext,
} from "../../src/ws/index";

describe("@bunest/websockets NestJS v12 API Parity", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!().catch(() => {});
    }
  });

  test("@WebSocketGateway supports (port), (port, options), (options: GatewayMetadata), and (path, options) overloads", () => {
    @WebSocketGateway(8081)
    class PortOnlyGateway {}

    @WebSocketGateway(8082, {
      namespace: "/notifications",
      cors: { origin: "*" },
      transports: ["websocket"],
      pingTimeout: 15_000,
      pingInterval: 10_000,
      maxHttpBufferSize: 2_000_000,
    })
    class PortAndOptionsGateway {}

    const metaOpts: GatewayMetadata = {
      path: "/ws/meta",
      namespace: /^\/tenant-/,
      serveClient: false,
      connectTimeout: 30_000,
      upgradeTimeout: 5_000,
      allowUpgrades: true,
      perMessageDeflate: true,
      httpCompression: false,
      allowEIO3: false,
      destroyUpgrade: true,
      destroyUpgradeTimeout: 1_500,
    };

    @WebSocketGateway(metaOpts)
    class MetadataGateway {}

    @WebSocketGateway("/ws/shorthand", { maxPayload: 512_000 })
    class PathAndOptionsGateway {
      @WebSocketServer({
        port: 8083,
        namespace: "/shorthand",
      } as WebSocketServerOptions)
      server: unknown;
    }

    expect(
      MetadataRegistry.get<WebSocketGatewayOptions>(
        WS_METADATA_KEYS.GATEWAY,
        PortOnlyGateway,
      ),
    ).toEqual({ port: 8081 });

    expect(
      MetadataRegistry.get<WebSocketGatewayOptions>(
        WS_METADATA_KEYS.GATEWAY,
        PortAndOptionsGateway,
      ),
    ).toMatchObject({
      port: 8082,
      namespace: "/notifications",
      pingTimeout: 15_000,
      pingInterval: 10_000,
      maxHttpBufferSize: 2_000_000,
    });

    expect(
      MetadataRegistry.get<WebSocketGatewayOptions>(
        WS_METADATA_KEYS.GATEWAY,
        MetadataGateway,
      ),
    ).toMatchObject({
      path: "/ws/meta",
      serveClient: false,
      connectTimeout: 30_000,
    });

    expect(
      MetadataRegistry.get<WebSocketGatewayOptions>(
        WS_METADATA_KEYS.GATEWAY,
        PathAndOptionsGateway,
      ),
    ).toMatchObject({
      path: "/ws/shorthand",
      maxPayload: 512_000,
    });
  });

  test("WsException.initMessage() resolves string, object.message, and class-name fallback", () => {
    class CustomRateLimitWsException extends WsException {}

    const e1 = new WsException("token expired");
    expect(e1.message).toBe("token expired");
    expect(e1.getError()).toBe("token expired");

    const e2 = new WsException({ code: 4001, message: "quota exceeded" });
    expect(e2.message).toBe("quota exceeded");

    const e3 = new CustomRateLimitWsException({ code: "RATE_LIMITED" });
    expect(e3.message).toBe("Custom Rate Limit Ws Exception");
    e3.message = "mutated";
    e3.initMessage();
    expect(e3.message).toBe("Custom Rate Limit Ws Exception");
  });

  test("BaseWsExceptionFilter supports handleError, handleUnknownError, isExceptionObject, includeCause, causeFactory, binary stripping, circular fallback, and native send", () => {
    class DummyGateway {
      handle() {}
    }

    const emitted: Array<{
      event: string;
      payload: unknown;
      frameId?: string;
    }> = [];
    const mockClient = {
      emit(event: string, payload: unknown, frameId?: string) {
        emitted.push({ event, payload, frameId });
      },
    } as unknown as BunWsClient;

    const ctx = new WsExecutionContext(
      mockClient,
      { text: "hello" },
      "chat.send",
      DummyGateway,
      DummyGateway.prototype.handle,
      "handle",
    );

    // Default options include cause { pattern, data }
    const defaultFilter = new BaseWsExceptionFilter();
    expect(defaultFilter.isExceptionObject(new Error("boom"))).toBe(true);
    expect(defaultFilter.isExceptionObject({ message: "like error" })).toBe(
      true,
    );
    expect(defaultFilter.isExceptionObject("not-an-error")).toBe(false);
    expect(defaultFilter.isExceptionObject(null)).toBe(false);

    defaultFilter.catch(new WsException("Invalid room"), ctx, "f-1");
    expect(emitted[0]).toEqual({
      event: "error",
      payload: {
        status: "error",
        message: "Invalid room",
        cause: { pattern: "chat.send", data: { text: "hello" } },
      } satisfies ErrorPayload,
      frameId: "f-1",
    });

    // includeCause: false omits cause
    emitted.length = 0;
    const noCauseFilter = new BaseWsExceptionFilter({ includeCause: false });
    noCauseFilter.catch(new WsException("Quiet error"), ctx);
    expect(emitted[0]?.payload).toEqual({
      status: "error",
      message: "Quiet error",
    });

    // Custom causeFactory
    emitted.length = 0;
    const customCauseFilter = new BaseWsExceptionFilter({
      includeCause: true,
      causeFactory: (pattern) => ({ pattern, redacted: true }),
    });
    customCauseFilter.catch(new WsException("Custom"), ctx);
    expect(emitted[0]?.payload).toEqual({
      status: "error",
      message: "Custom",
      cause: { pattern: "chat.send", redacted: true },
    });

    // Binary payload stripped from cause
    emitted.length = 0;
    const binaryCtx = new WsExecutionContext(
      mockClient,
      { bin: new Uint8Array([1, 2, 3]) },
      "upload",
      DummyGateway,
      DummyGateway.prototype.handle,
      "handle",
    );
    defaultFilter.catch(new WsException("Too large"), binaryCtx);
    expect(emitted[0]?.payload).toEqual({
      status: "error",
      message: "Too large",
      cause: { pattern: "upload" },
    });

    // WsException wrapping an Error instance is sanitized via handleUnknownError
    emitted.length = 0;
    const leakedErr = Object.assign(new Error("DB down"), {
      secretHeader: "Bearer top-secret",
    });
    defaultFilter.handleError(mockClient, new WsException(leakedErr), {
      pattern: "secret",
      data: {},
    });
    expect(emitted[0]?.payload).toEqual({
      status: "error",
      message: "Internal server error",
      cause: { pattern: "secret", data: {} },
    });

    // Native WebSocket client (numeric readyState) routes through .send(JSON) and retries without cause on circular data
    const rawSent: string[] = [];
    const nativeClient = {
      readyState: 1,
      send(frame: string) {
        rawSent.push(frame);
      },
      emit() {
        throw new Error(
          "Should not call EventEmitter.emit on native WebSocket",
        );
      },
    };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    defaultFilter.handleError(
      nativeClient,
      new WsException("Circular payload"),
      { pattern: "loop", data: circular },
      "c-1",
    );
    expect(rawSent).toHaveLength(1);
    expect(JSON.parse(rawSent[0]!)).toEqual({
      event: "error",
      data: { status: "error", message: "Circular payload" },
      id: "c-1",
    });
  });

  test("AbstractWsAdapter & WsAdapter implement full adapter lifecycle, messageParser, bindMessageHandlers, and backpressure", async () => {
    const events: string[] = [];
    const options: WsAdapterOptions = {
      maxConcurrentMessages: 10,
      maxSendBufferSize: 1024,
      maxPayload: 65_536,
      unclaimedUpgradeTimeout: 500,
    };

    const adapter = new WsAdapter(undefined, options);
    expect(adapter).toBeInstanceOf(AbstractWsAdapter);
    expect(adapter.forceCloseConnections).toBe(false);
    adapter.forceCloseConnections = true;
    expect(adapter.forceCloseConnections).toBe(true);

    // createWithoutListener creates non-listening BunWsServerImpl
    const silentServer = adapter.createWithoutListener({
      path: "/ws/silent",
      namespace: "/silent",
    }) as { path?: string; namespace?: string };
    expect(silentServer.path).toBe("/ws/silent");
    expect(silentServer.namespace).toBe("/silent");

    // Mock BaseWsInstance server + client wiring
    const serverListeners = new Map<string, Function>();
    let serverClosed = false;
    const mockServer: BaseWsInstance = {
      on(ev, cb) {
        serverListeners.set(ev, cb);
      },
      close() {
        serverClosed = true;
      },
    };

    adapter.bindClientConnect(mockServer, () => events.push("connect"));
    adapter.bindErrorHandler(mockServer);
    serverListeners.get("connection")?.();
    expect(events).toEqual(["connect"]);

    const clientListeners = new Map<string, Function>();
    const sentFrames: string[] = [];
    let clientClosed = false;
    const mockClient = {
      bufferedAmount: 0,
      on(ev: string, cb: Function) {
        clientListeners.set(ev, cb);
      },
      send(data: string) {
        sentFrames.push(data);
      },
      close() {
        clientClosed = true;
      },
    };

    adapter.bindClientDisconnect(mockClient, () => events.push("disconnect"));
    clientListeners.get("close")?.();
    expect(events).toEqual(["connect", "disconnect"]);

    // Custom messageParser + bindMessageHandlers / bindMessageHandler
    adapter.setMessageParser((raw) => {
      const str =
        typeof raw === "string"
          ? raw
          : Buffer.from(raw as Uint8Array).toString("utf8");
      const [event, payload] = str.split(":");
      if (!event) return undefined;
      return { event, data: payload };
    });

    const handlers: MessageMappingProperties[] = [
      {
        message: "echo",
        methodName: "handleEcho",
        callback: async (data: string) => ({ echoed: data.toUpperCase() }),
        isAckHandledManually: false,
      },
    ];

    adapter.bindMessageHandlers(mockClient, handlers, (res) => res);
    clientListeners.get("message")?.("echo:bunest");
    await Bun.sleep(15);
    expect(sentFrames).toHaveLength(1);
    expect(JSON.parse(sentFrames[0]!)).toEqual({ echoed: "BUNEST" });

    // Direct bindMessageHandler invocation
    const handlersMap = new Map(handlers.map((h) => [String(h.message), h]));
    const directRes = await adapter.bindMessageHandler(
      Buffer.from("echo:direct"),
      handlersMap,
    );
    expect(directRes).toEqual({ echoed: "DIRECT" });

    // Backpressure: bufferedAmount > maxSendBufferSize closes client
    mockClient.bufferedAmount = 2048;
    clientListeners.get("message")?.("echo:overflow");
    await Bun.sleep(15);
    expect(clientClosed).toBe(true);

    await adapter.close(mockServer);
    expect(serverClosed).toBe(true);
    await adapter.dispose();
  });

  test("OnGatewayConnection / OnGatewayDisconnect 1-arg NestJS signatures work end-to-end with WsAdapter(app)", async () => {
    const hooks: string[] = [];

    @WebSocketGateway({ path: "/ws/parity" })
    class ParityGateway implements OnGatewayConnection, OnGatewayDisconnect {
      handleConnection(client: BunWsClient) {
        hooks.push(`in:${client.id.length > 0}`);
      }

      handleDisconnect(client: BunWsClient) {
        hooks.push(`out:${client.id.length > 0}`);
      }

      @SubscribeMessage("greet")
      greet(@MessageBody() name: string) {
        return { hello: name };
      }
    }

    @Module({
      imports: [WebSocketModule.forRoot()],
      providers: [ParityGateway],
    })
    class ParityModule {}

    const app = await BunestFactory.create(ParityModule, { logger: false });
    const wsAdapter = new WsAdapter(app, { maxPayload: 128_000 });
    await wsAdapter.registerGateway(app.get(ParityGateway));
    const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
    cleanups.push(async () => {
      await wsAdapter.dispose();
      await app.close();
    });

    const reply = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws/parity`);
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ event: "greet", data: "NestJS", id: "g1" }));
        });
        ws.addEventListener("message", (ev) => {
          const parsed = JSON.parse(String(ev.data)) as Record<string, unknown>;
          ws.close();
          resolve(parsed);
        });
        ws.addEventListener("error", reject);
      },
    );

    expect(reply).toEqual({
      event: "greet",
      data: { hello: "NestJS" },
      id: "g1",
    });
    await Bun.sleep(25);
    expect(hooks).toEqual(["in:true", "out:true"]);
  });
});
