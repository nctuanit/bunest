import { afterEach, describe, expect, it } from "bun:test";
import {
  AMBIENT_TRACEPARENT_PROVIDER_SYMBOL,
  BunestFactory,
  ClsContextPropagator,
  ClsModule,
  ClsService,
  Module,
  captureClsContext,
  clsToHeaders,
  diagnosticsChannel,
  getAmbientTraceparent,
  headersToCls,
  registerAmbientTraceparentProvider,
  restoreClsContext,
} from "../src/index";
import {
  HTTP_CLIENT_REQUEST_CHANNEL,
  HttpClient,
  type HttpClientRequestDiagnosticEvent,
} from "../src/client/index";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  type BunWsClient,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from "../src/ws/index";

describe("CLS Cross-Transport Propagator, Ambient Traceparent & Diagnostics", () => {
  let unregisterTraceparent: (() => void) | undefined;

  afterEach(() => {
    unregisterTraceparent?.();
    unregisterTraceparent = undefined;
  });

  it("captures, restores, and maps default & custom CLS keys to/from headers safely", () => {
    const cls = new ClsService();
    const traceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    unregisterTraceparent = registerAmbientTraceparentProvider(
      () => traceparent,
    );

    expect(getAmbientTraceparent()).toBe(traceparent);
    expect(
      (globalThis as Record<PropertyKey, unknown>)[
        AMBIENT_TRACEPARENT_PROVIDER_SYMBOL
      ],
    ).toBeDefined();

    const carrier = cls.run(
      () => {
        cls.set("requestId", "req-123");
        cls.set("tenantId", "tenant-acme");
        cls.set("userId", "user-42");
        cls.set("correlationId", "corr-999");
        cls.set("ignoredKey", "secret");
        return captureClsContext(cls);
      },
      { requestId: "req-123" },
    );

    // JSON-serializable carrier
    const roundTripped = JSON.parse(JSON.stringify(carrier));
    expect(roundTripped.values).toEqual({
      requestId: "req-123",
      tenantId: "tenant-acme",
      userId: "user-42",
      correlationId: "corr-999",
    });
    expect(roundTripped.traceparent).toBe(traceparent);

    // Carrier -> Headers -> Carrier
    const headers = clsToHeaders(roundTripped);
    expect(headers).toEqual({
      "x-request-id": "req-123",
      "x-tenant-id": "tenant-acme",
      "x-user-id": "user-42",
      "x-correlation-id": "corr-999",
      traceparent,
    });

    // Rejects CRLF injection values
    const injectedHeaders = clsToHeaders({
      tenantId: "good-tenant",
      requestId: "bad\r\nX-Injected: yes",
    });
    expect(injectedHeaders["x-tenant-id"]).toBe("good-tenant");
    expect(injectedHeaders["x-request-id"]).toBeUndefined();

    // Headers -> CLS -> restored execution
    const parsed = headersToCls(new Headers(headers));
    const observed = restoreClsContext(cls, parsed, () => ({
      active: cls.isActive(),
      id: cls.getId(),
      tenantId: cls.get("tenantId"),
      userId: cls.get("userId"),
      correlationId: cls.get("correlationId"),
      traceparent: cls.get("traceparent"),
    }));
    expect(observed).toEqual({
      active: true,
      id: "req-123",
      tenantId: "tenant-acme",
      userId: "user-42",
      correlationId: "corr-999",
      traceparent,
    });

    // ClsContextPropagator with custom keys
    const propagator = new ClsContextPropagator({
      keys: ["tenantId", "orgId"],
      headerMap: { tenantId: "x-tenant-id", orgId: "x-org-id" },
    });
    const customHeaders = cls.run(() => {
      cls.set("tenantId", "t1");
      cls.set("orgId", "org-77");
      return propagator.captureToHeaders(cls);
    });
    expect(customHeaders["x-tenant-id"]).toBe("t1");
    expect(customHeaders["x-org-id"]).toBe("org-77");

    const restoredCustom = propagator.runFromHeaders(cls, customHeaders, () => ({
      tenantId: cls.get("tenantId"),
      orgId: cls.get("orgId"),
    }));
    expect(restoredCustom).toEqual({ tenantId: "t1", orgId: "org-77" });
  });

  it("HttpClient emits diagnosticsChannel, auto-injects traceparent, and supports propagateClsHeaders", async () => {
    const traceparent =
      "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    unregisterTraceparent = registerAmbientTraceparentProvider(
      () => traceparent,
    );

    const events: HttpClientRequestDiagnosticEvent[] = [];
    const ch = diagnosticsChannel(HTTP_CLIENT_REQUEST_CHANNEL);
    const listener = (msg: unknown) => {
      events.push(msg as HttpClientRequestDiagnosticEvent);
    };
    ch.subscribe(listener);

    try {
      const capturedHeaders: Record<string, string>[] = [];
      const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const req =
          input instanceof Request
            ? input
            : new Request(input instanceof URL ? input.href : input, init);
        const rec: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          rec[k] = v;
        });
        capturedHeaders.push(rec);
        if (req.url.includes("/fail")) {
          throw new Error("ECONNREFUSED");
        }
        return Response.json({ ok: true }, { status: 200 });
      }) as typeof globalThis.fetch;

      const client = new HttpClient({
        baseUrl: "http://internal.test",
        fetch: mockFetch,
        propagateClsHeaders: true,
        retry: false,
      });

      const cls = new ClsService();
      await cls.run(async () => {
        cls.set("requestId", "req-http-1");
        cls.set("tenantId", "tenant-99");
        cls.set("correlationId", "corr-abc");
        await client.get("/items");
      });

      expect(capturedHeaders[0]).toMatchObject({
        traceparent,
        "x-request-id": "req-http-1",
        "x-tenant-id": "tenant-99",
        "x-correlation-id": "corr-abc",
      });

      // Explicit headers override ambient traceparent & CLS headers
      await cls.run(async () => {
        cls.set("tenantId", "tenant-from-cls");
        await client.get("/override", {
          headers: {
            traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
            "x-tenant-id": "explicit-tenant",
          },
        });
      });
      expect(capturedHeaders[1]?.traceparent).toBe(
        "00-11111111111111111111111111111111-2222222222222222-01",
      );
      expect(capturedHeaders[1]?.["x-tenant-id"]).toBe("explicit-tenant");

      // Custom propagateClsHeaders key array
      await cls.run(async () => {
        cls.set("orgId", "org-42");
        cls.set("tenantId", "tenant-hidden");
        await client.get("/custom-keys", {
          propagateClsHeaders: ["orgId"],
        });
      });
      expect(capturedHeaders[2]?.["x-org-id"]).toBe("org-42");
      expect(capturedHeaders[2]?.["x-tenant-id"]).toBeUndefined();

      // Error phase diagnostic event
      await expect(client.get("/fail")).rejects.toThrow();

      expect(events.map((e) => `${e.phase}:${new URL(e.url).pathname}`)).toEqual([
        "start:/items",
        "end:/items",
        "start:/override",
        "end:/override",
        "start:/custom-keys",
        "end:/custom-keys",
        "start:/fail",
        "error:/fail",
      ]);
      expect(events[1]?.status).toBe(200);
      expect(events[1]?.ok).toBe(true);
      expect(typeof events[1]?.durationMs).toBe("number");
      expect(events[7]?.error).toBeDefined();
    } finally {
      ch.unsubscribe(listener);
    }
  });

  it("propagates CLS context from WebSocket upgrade headers into handleConnection, @SubscribeMessage, and handleDisconnect with per-connection isolation", async () => {
    const lifecycleLog: Array<Record<string, unknown>> = [];
    let resolveBothDisconnects!: () => void;
    let disconnectCount = 0;
    const allDisconnected = new Promise<void>((r) => {
      resolveBothDisconnects = r;
    });

    @WebSocketGateway({
      path: "/ws-cls",
      authenticate: (req) => {
        const token = req.headers.get("x-auth-user");
        return { authenticatedUser: token ?? "anon" };
      },
    })
    class ClsWsGateway implements OnGatewayConnection, OnGatewayDisconnect {
      constructor(private readonly cls: ClsService) {}

      handleConnection(client: BunWsClient) {
        lifecycleLog.push({
          hook: "open",
          clientId: client.id,
          active: this.cls.isActive(),
          clsId: this.cls.getId(),
          tenantId: this.cls.get("tenantId"),
          requestId: this.cls.get("requestId"),
          correlationId: this.cls.get("correlationId"),
          traceparent: this.cls.get("traceparent"),
        });
      }

      @SubscribeMessage("echo")
      async onEcho(
        @ConnectedSocket() _client: BunWsClient,
        @MessageBody() payload: { seq: number },
      ) {
        // Mutate CLS inside message #1 to verify no leakage to message #2
        const prevMutated = this.cls.get("ephemeral");
        this.cls.set("ephemeral", `msg-${payload.seq}`);
        await Bun.sleep(5);
        return {
          seq: payload.seq,
          clsId: this.cls.getId(),
          tenantId: this.cls.get("tenantId"),
          requestId: this.cls.get("requestId"),
          correlationId: this.cls.get("correlationId"),
          traceparent: this.cls.get("traceparent"),
          prevMutated: prevMutated ?? null,
        };
      }

      handleDisconnect(client: BunWsClient) {
        lifecycleLog.push({
          hook: "close",
          clientId: client.id,
          active: this.cls.isActive(),
          clsId: this.cls.getId(),
          tenantId: this.cls.get("tenantId"),
          requestId: this.cls.get("requestId"),
        });
        disconnectCount++;
        if (disconnectCount >= 2) {
          resolveBothDisconnects();
        }
      }
    }

    @Module({
      imports: [ClsModule.forRoot(), WebSocketModule.forRoot()],
      providers: [ClsWsGateway],
    })
    class WsAppModule {}

    const app = await BunestFactory.create(WsAppModule, { logger: false });
    await WebSocketModule.attach(app);
    const info = await app.listen(0);

    try {
      const wsUrl = info.url.replace(/^http/, "ws").replace(/\/$/, "") + "/ws-cls";

      const connectClient = (headers: Record<string, string>) =>
        new Promise<{
          ws: WebSocket;
          sendAndReceive: (event: string, data: unknown) => Promise<any>;
        }>((resolveConn, rejectConn) => {
          const ws = new WebSocket(wsUrl, { headers } as unknown as string[]);
          const waiters: Array<(msg: any) => void> = [];
          ws.addEventListener("open", () => {
            resolveConn({
              ws,
              sendAndReceive: (event, data) =>
                new Promise((res) => {
                  waiters.push(res);
                  ws.send(JSON.stringify({ event, data }));
                }),
            });
          });
          ws.addEventListener("message", (ev) => {
            const parsed = JSON.parse(String(ev.data));
            const next = waiters.shift();
            next?.(parsed.data);
          });
          ws.addEventListener("error", (err) => rejectConn(err));
        });

      const [c1, c2] = await Promise.all([
        connectClient({
          "x-request-id": "ws-req-1",
          "x-tenant-id": "tenant-alpha",
          "x-correlation-id": "corr-1",
          traceparent: "00-11111111111111111111111111111111-1111111111111111-01",
        }),
        connectClient({
          "x-request-id": "ws-req-2",
          "x-tenant-id": "tenant-beta",
          "x-correlation-id": "corr-2",
          traceparent: "00-22222222222222222222222222222222-2222222222222222-01",
        }),
      ]);

      const [r1a, r2a] = await Promise.all([
        c1.sendAndReceive("echo", { seq: 1 }),
        c2.sendAndReceive("echo", { seq: 1 }),
      ]);

      expect(r1a).toEqual({
        seq: 1,
        clsId: "ws-req-1",
        tenantId: "tenant-alpha",
        requestId: "ws-req-1",
        correlationId: "corr-1",
        traceparent: "00-11111111111111111111111111111111-1111111111111111-01",
        prevMutated: null,
      });
      expect(r2a).toEqual({
        seq: 1,
        clsId: "ws-req-2",
        tenantId: "tenant-beta",
        requestId: "ws-req-2",
        correlationId: "corr-2",
        traceparent: "00-22222222222222222222222222222222-2222222222222222-01",
        prevMutated: null,
      });

      // Second message on c1 gets a fresh isolated CLS context (no ephemeral leak)
      const r1b = await c1.sendAndReceive("echo", { seq: 2 });
      expect(r1b.tenantId).toBe("tenant-alpha");
      expect(r1b.prevMutated).toBeNull();

      c1.ws.close();
      c2.ws.close();
      await allDisconnected;

      const openHooks = lifecycleLog.filter((e) => e.hook === "open");
      const closeHooks = lifecycleLog.filter((e) => e.hook === "close");
      expect(openHooks.map((e) => e.tenantId).sort()).toEqual([
        "tenant-alpha",
        "tenant-beta",
      ]);
      expect(closeHooks.map((e) => e.tenantId).sort()).toEqual([
        "tenant-alpha",
        "tenant-beta",
      ]);
      expect(openHooks.every((e) => e.active === true)).toBe(true);
      expect(closeHooks.every((e) => e.active === true)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
