import { describe, expect, it } from "bun:test";
import {
  BunestFactory,
  Controller,
  ExecutionContextHost,
  Get,
  Injectable,
  Module,
} from "@bunest/core";
import { WsExecutionContext } from "@bunest/core/ws";
import {
  InMemorySpanExporter,
  MetricsRegistry,
  OBSERVABILITY_MODULE_OPTIONS,
  ObservabilityLogger,
  ObservabilityModule,
  Span,
  Tracer,
  TracingInterceptor,
  createTracedFetch,
  formatTraceParent,
  generateSpanId,
  generateTraceId,
  parseTraceParent,
  parseTraceState,
  traceContextStorage,
  type ObservabilityModuleOptions,
  type ObservabilityOptionsFactory,
} from "../src";

describe("Full-Pipeline Tracing (WS & RPC), createTracedFetch, ObservabilityModule.forRootAsync & Structured Logger", () => {
  describe("TracingInterceptor across WS and RPC execution contexts", () => {
    it("creates spans and propagates W3C trace context for WebSocket handlers (payload & handshake headers)", async () => {
      const exporter = new InMemorySpanExporter();
      const tracer = new Tracer({ serviceName: "ws-gateway", exporter });
      const interceptor = new TracingInterceptor(tracer);

      class ChatGateway {
        handleMessage() {}
      }

      const incomingTraceId = generateTraceId();
      const incomingSpanId = generateSpanId();
      const incomingTraceparent = formatTraceParent({
        traceId: incomingTraceId,
        spanId: incomingSpanId,
        sampled: true,
      });

      // 1. Trace context carried in WS payload metadata
      const clientWithHandshake = {
        id: "ws-client-42",
        request: new Request("http://localhost/ws", {
          headers: {
            traceparent: formatTraceParent({
              traceId: generateTraceId(),
              spanId: generateSpanId(),
              sampled: true,
            }),
            "x-request-id": "req-ws-handshake",
          },
        }),
      } as any;

      const wsCtxPayload = new WsExecutionContext(
        clientWithHandshake,
        {
          text: "hello",
          headers: {
            traceparent: incomingTraceparent,
            tracestate: "vendor=ws1",
            "x-request-id": "req-ws-msg",
          },
        },
        "chat.send",
        ChatGateway,
        ChatGateway.prototype.handleMessage,
        "handleMessage",
      );

      let insideTraceId: string | undefined;
      let insideSpanId: string | undefined;
      let insideRequestId: string | undefined;

      const result = await interceptor.intercept(wsCtxPayload, {
        handle: async () => {
          const active = traceContextStorage.getCurrentSpanContext();
          insideTraceId = active?.traceId;
          insideSpanId = active?.spanId;
          insideRequestId = active?.requestId;
          return { delivered: true };
        },
      });

      expect(result).toEqual({ delivered: true });
      expect(insideTraceId).toBe(incomingTraceId);
      expect(insideRequestId).toBe("req-ws-msg");
      expect(traceContextStorage.getCurrentSpanContext()).toBeUndefined();

      const wsSpans = exporter.findByName("WS chat.send");
      expect(wsSpans).toHaveLength(1);
      const wsSpan = wsSpans[0]!;
      expect(wsSpan.kind).toBe("SERVER");
      expect(wsSpan.traceId).toBe(incomingTraceId);
      expect(wsSpan.parentSpanId).toBe(incomingSpanId);
      expect(insideSpanId).toBe(wsSpan.spanId);
      expect(wsSpan.status.code).toBe("OK");
      expect(wsSpan.attributes).toMatchObject({
        "messaging.system": "websocket",
        "messaging.operation": "process",
        "ws.event": "chat.send",
        "ws.client.id": "ws-client-42",
        "code.namespace": "ChatGateway",
        "code.function": "handleMessage",
      });

      // 2. Falls back to HTTP upgrade handshake headers when payload has no traceparent
      const handshakeTraceId = generateTraceId();
      const handshakeSpanId = generateSpanId();
      const handshakeClient = {
        id: "ws-client-99",
        request: new Request("http://localhost/ws", {
          headers: {
            traceparent: formatTraceParent({
              traceId: handshakeTraceId,
              spanId: handshakeSpanId,
              sampled: true,
            }),
            "x-request-id": "req-handshake-99",
          },
        }),
      } as any;
      const wsCtxHandshake = new WsExecutionContext(
        handshakeClient,
        { room: "general" },
        "chat.join",
        ChatGateway,
        ChatGateway.prototype.handleMessage,
        "handleMessage",
      );

      await expect(
        interceptor.intercept(wsCtxHandshake, {
          handle: async () => {
            throw new Error("room full");
          },
        }),
      ).rejects.toThrow("room full");

      const errSpan = exporter.findByName("WS chat.join")[0]!;
      expect(errSpan.traceId).toBe(handshakeTraceId);
      expect(errSpan.parentSpanId).toBe(handshakeSpanId);
      expect(errSpan.status.code).toBe("ERROR");
      expect(errSpan.events.some((e) => e.name === "exception")).toBe(true);
    });

    it("creates spans and propagates W3C trace context for RPC handlers across metadata/header shapes", async () => {
      const exporter = new InMemorySpanExporter();
      const tracer = new Tracer({ serviceName: "orders-rpc", exporter });
      const interceptor = new TracingInterceptor(tracer);

      class OrdersRpcController {
        createOrder() {}
        onOrderEvent() {}
      }

      const incomingTraceId = generateTraceId();
      const incomingSpanId = generateSpanId();
      const traceparent = formatTraceParent({
        traceId: incomingTraceId,
        spanId: incomingSpanId,
        sampled: true,
      });

      // 1. Microservice context with getPattern() + getMetadata() (TcpContext/RedisContext style)
      const rpcCtx = {
        transport: "TCP",
        pattern: "orders.create",
        getPattern: () => "orders.create",
        getMetadata: () => ({
          traceparent,
          tracestate: "vendor=tcp",
          baggage: "tenant=acme",
          "x-request-id": "req-rpc-1",
        }),
      };

      const execCtx = new ExecutionContextHost(
        [{ sku: "coffee" }, rpcCtx],
        OrdersRpcController,
        OrdersRpcController.prototype.createOrder,
      );
      execCtx.setType("rpc");

      let childSpanId: string | undefined;
      let baggageTenant: string | undefined;
      const response = await interceptor.intercept(execCtx, {
        handle: async () => {
          const active = traceContextStorage.getCurrentSpanContext();
          childSpanId = active?.spanId;
          baggageTenant = active?.baggage?.tenant;
          // Child span inside RPC handler automatically inherits traceId + parentSpanId
          await tracer.startActiveSpan("rpc.db.write", async () => {});
          return { orderId: "ord-55" };
        },
      });

      expect(response).toEqual({ orderId: "ord-55" });
      expect(baggageTenant).toBe("acme");

      const rpcSpan = exporter.findByName("RPC orders.create")[0]!;
      const dbSpan = exporter.findByName("rpc.db.write")[0]!;
      expect(rpcSpan.kind).toBe("SERVER");
      expect(rpcSpan.traceId).toBe(incomingTraceId);
      expect(rpcSpan.parentSpanId).toBe(incomingSpanId);
      expect(childSpanId).toBe(rpcSpan.spanId);
      expect(rpcSpan.status.code).toBe("OK");
      expect(rpcSpan.attributes).toMatchObject({
        "rpc.system": "TCP",
        "rpc.method": "orders.create",
        "messaging.destination.name": "orders.create",
        "code.namespace": "OrdersRpcController",
        "code.function": "createOrder",
      });
      expect(dbSpan.traceId).toBe(incomingTraceId);
      expect(dbSpan.parentSpanId).toBe(rpcSpan.spanId);

      // 2. RMQ-style context (getMessage().properties.headers) + error recording
      const rmqTraceId = generateTraceId();
      const rmqSpanId = generateSpanId();
      const rmqCtx = {
        transport: "RABBITMQ",
        getPattern: () => ({ cmd: "order.cancelled" }),
        getMessage: () => ({
          properties: {
            headers: {
              traceparent: formatTraceParent({
                traceId: rmqTraceId,
                spanId: rmqSpanId,
                sampled: true,
              }),
            },
          },
        }),
      };
      const rmqExecCtx = new ExecutionContextHost(
        [{ id: "ord-55" }, rmqCtx],
        OrdersRpcController,
        OrdersRpcController.prototype.onOrderEvent,
      );
      rmqExecCtx.setType("rpc");

      await expect(
        interceptor.intercept(rmqExecCtx, {
          handle: async () => {
            throw new Error("downstream broker timeout");
          },
        }),
      ).rejects.toThrow("downstream broker timeout");

      const rmqSpan = exporter.findByTraceId(rmqTraceId)[0]!;
      expect(rmqSpan.name).toBe('RPC {"cmd":"order.cancelled"}');
      expect(rmqSpan.parentSpanId).toBe(rmqSpanId);
      expect(rmqSpan.status.code).toBe("ERROR");
      expect(rmqSpan.events.some((e) => e.name === "exception")).toBe(true);
    });
  });

  describe("createTracedFetch", () => {
    it("starts CLIENT spans, injects W3C traceparent/tracestate/baggage/requestId, records status & errors", async () => {
      const exporter = new InMemorySpanExporter();
      const tracer = new Tracer({ serviceName: "checkout-api", exporter });

      const captured: Array<{ url: string; method: string; headers: Headers }> =
        [];
      const mockFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.toString()
              : input;
        const headers = new Headers(init?.headers);
        captured.push({
          url,
          method: init?.method ?? (input instanceof Request ? input.method : "GET"),
          headers,
        });
        if (url.includes("/fail-500")) {
          return new Response("internal error", { status: 500 });
        }
        if (url.includes("/network-boom")) {
          throw new Error("ECONNREFUSED");
        }
        return Response.json({ ok: true }, { status: 200 });
      };

      const tracedFetch = createTracedFetch({
        tracer,
        fetchImpl: mockFetch,
        attributes: { "peer.service": "inventory" },
        ignoreUrl: (u) => u.includes("/health-skip"),
      });

      const parentTraceId = generateTraceId();
      const parentSpanId = generateSpanId();

      await traceContextStorage.run(
        {
          traceId: parentTraceId,
          spanId: parentSpanId,
          traceFlags: 1,
          sampled: true,
          traceState: { vendor: "bunest" },
          baggage: { tenant: "acme" },
          requestId: "req-fetch-7",
        },
        async () => {
          // 1. Normal 200 GET with Request + merged custom header
          const req = new Request("https://inventory.internal:8443/v1/items", {
            method: "POST",
            headers: { "x-custom": "keep-me" },
          });
          const res1 = await tracedFetch(req, {
            headers: { "x-extra": "added" },
          });
          expect(res1.status).toBe(200);

          // 2. 500 response marks CLIENT span ERROR
          const res2 = await tracedFetch("https://inventory.internal/fail-500");
          expect(res2.status).toBe(500);

          // 3. Network error records exception + marks ERROR + rethrows
          await expect(
            tracedFetch("https://inventory.internal/network-boom"),
          ).rejects.toThrow("ECONNREFUSED");

          // 4. Ignored URL bypasses tracing completely
          const res4 = await tracedFetch("https://inventory.internal/health-skip");
          expect(res4.status).toBe(200);
        },
      );

      expect(captured).toHaveLength(4);
      const firstReq = captured[0]!;
      expect(firstReq.headers.get("x-custom")).toBe("keep-me");
      expect(firstReq.headers.get("x-extra")).toBe("added");
      expect(firstReq.headers.get("x-request-id")).toBe("req-fetch-7");
      expect(parseTraceState(firstReq.headers.get("tracestate"))).toEqual({
        vendor: "bunest",
      });
      expect(firstReq.headers.get("baggage")).toBe("tenant=acme");

      const spans = exporter.findByTraceId(parentTraceId);
      expect(spans).toHaveLength(3);

      const okSpan = spans.find((s) => s.name === "HTTP POST /v1/items")!;
      expect(okSpan.kind).toBe("CLIENT");
      expect(okSpan.parentSpanId).toBe(parentSpanId);
      expect(okSpan.status.code).toBe("OK");
      expect(okSpan.attributes).toMatchObject({
        "http.method": "POST",
        "http.status_code": 200,
        "server.address": "inventory.internal",
        "server.port": 8443,
        "peer.service": "inventory",
      });

      // Outbound traceparent carries the CLIENT span's own spanId (not parent's)
      const sentTraceParent = parseTraceParent(
        firstReq.headers.get("traceparent"),
      );
      expect(sentTraceParent?.traceId).toBe(parentTraceId);
      expect(sentTraceParent?.spanId).toBe(okSpan.spanId);

      const err500Span = spans.find((s) => s.name === "HTTP GET /fail-500")!;
      expect(err500Span.status.code).toBe("ERROR");
      expect(err500Span.attributes["http.status_code"]).toBe(500);

      const netErrSpan = spans.find((s) => s.name === "HTTP GET /network-boom")!;
      expect(netErrSpan.status.code).toBe("ERROR");
      expect(netErrSpan.events.some((e) => e.name === "exception")).toBe(true);

      // Ignored URL did not inject traceparent or record a span
      expect(captured[3]!.headers.get("traceparent")).toBeNull();
    });
  });

  describe("ObservabilityModule.forRootAsync", () => {
    it("configures tracing, metrics, global interceptors, and structured logger via useFactory", async () => {
      const exporter = new InMemorySpanExporter();
      const logLines: string[] = [];

      const CONFIG_TOKEN = Symbol("TEST_OBS_CONFIG");

      @Module({
        providers: [
          {
            provide: CONFIG_TOKEN,
            useValue: { serviceName: "async-orders-svc", env: "staging" },
          },
        ],
        exports: [CONFIG_TOKEN],
      })
      class FakeConfigModule {}

      @Injectable()
      class WorkService {
        constructor(private readonly logger: ObservabilityLogger) {}

        @Span("work.compute")
        async compute(id: string): Promise<string> {
          this.logger.info({ itemId: id }, "computing item");
          return `done:${id}`;
        }
      }

      @Controller("/work")
      class WorkController {
        constructor(private readonly svc: WorkService) {}

        @Get("/:id")
        async run() {
          return { result: await this.svc.compute("42") };
        }
      }

      @Module({
        imports: [
          FakeConfigModule,
          ObservabilityModule.forRootAsync({
            imports: [FakeConfigModule],
            inject: [CONFIG_TOKEN],
            useFactory: async (cfg: { serviceName: string; env: string }) => {
              await Promise.resolve();
              return {
                tracing: {
                  serviceName: cfg.serviceName,
                  exporter,
                  registerGlobalInterceptor: true,
                },
                metrics: {
                  registerGlobalInterceptor: true,
                },
                logging: {
                  serviceName: cfg.serviceName,
                  bindings: { env: cfg.env },
                  writer: (line) => logLines.push(line),
                },
              };
            },
          }),
        ],
        controllers: [WorkController],
        providers: [WorkService],
      })
      class AsyncAppModule {}

      const app = await BunestFactory.create(AsyncAppModule, { logger: false });
      try {
        const res = await app.fetch(new Request("http://localhost/work/42"));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ result: "done:42" });

        const httpSpan = exporter.findByName("HTTP GET /work/:id")[0]!;
        const workSpan = exporter.findByName("work.compute")[0]!;
        expect(httpSpan).toBeDefined();
        expect(workSpan).toBeDefined();
        expect(workSpan.traceId).toBe(httpSpan.traceId);
        expect(workSpan.parentSpanId).toBe(httpSpan.spanId);
        expect(httpSpan.resource["service.name"]).toBe("async-orders-svc");

        const registry = app.get(MetricsRegistry);
        expect(registry.toPrometheusText()).toContain("http_requests_total");

        expect(logLines).toHaveLength(1);
        const logEntry = JSON.parse(logLines[0]!) as Record<string, unknown>;
        expect(logEntry.service).toBe("async-orders-svc");
        expect(logEntry.env).toBe("staging");
        expect(logEntry.itemId).toBe("42");
        expect(logEntry.message).toBe("computing item");
        expect(logEntry.traceId).toBe(httpSpan.traceId);
        expect(logEntry.spanId).toBe(workSpan.spanId);

        const resolvedOpts = app.get<ObservabilityModuleOptions>(
          OBSERVABILITY_MODULE_OPTIONS,
        );
        expect(resolvedOpts.tracing).toBeDefined();
      } finally {
        await app.close();
      }
    });

    it("supports useClass and useExisting factories and rejects empty async config", async () => {
      const exporter = new InMemorySpanExporter();

      @Injectable()
      class MyObsConfigFactory implements ObservabilityOptionsFactory {
        createObservabilityOptions(): ObservabilityModuleOptions {
          return {
            tracing: { serviceName: "factory-class-svc", exporter },
            logging: { serviceName: "factory-class-svc" },
          };
        }
      }

      @Module({
        imports: [
          ObservabilityModule.forRootAsync({
            useClass: MyObsConfigFactory,
          }),
        ],
      })
      class ClassFactoryAppModule {}

      const ctx = await BunestFactory.createApplicationContext(
        ClassFactoryAppModule,
        { logger: false },
      );
      try {
        const tracer = ctx.get(Tracer);
        await tracer.startActiveSpan("factory.ping", async () => {});
        const span = exporter.findByName("factory.ping")[0]!;
        expect(span.resource["service.name"]).toBe("factory-class-svc");
      } finally {
        await ctx.close();
      }

      @Module({
        providers: [MyObsConfigFactory],
        exports: [MyObsConfigFactory],
      })
      class SharedFactoryModule {}

      @Module({
        imports: [
          SharedFactoryModule,
          ObservabilityModule.forRootAsync({
            imports: [SharedFactoryModule],
            useExisting: MyObsConfigFactory,
          }),
        ],
      })
      class ExistingFactoryAppModule {}

      const ctx2 = await BunestFactory.createApplicationContext(
        ExistingFactoryAppModule,
        { logger: false },
      );
      try {
        const logger = ctx2.get(ObservabilityLogger);
        expect(logger).toBeInstanceOf(ObservabilityLogger);
      } finally {
        await ctx2.close();
      }

      expect(() => ObservabilityModule.forRootAsync({} as any)).toThrow(
        /useFactory|useClass|useExisting/,
      );
    });
  });

  describe("ObservabilityLogger structured-first overloads & Pino-style child(bindings)", () => {
    it("supports child(bindings) inheritance/merging, structured (fields, message) overloads, secret redaction, and NestJS backward compatibility", () => {
      const lines: string[] = [];
      const root = new ObservabilityLogger({
        serviceName: "payments-api",
        json: true,
        bindings: { region: "us-east-1" },
        writer: (line) => lines.push(line),
      });

      const tenantLogger = root.child({
        tenantId: "acme",
        component: "checkout",
        apiKey: "sk_live_secret_xyz",
      });
      const orderLogger = tenantLogger.child({
        component: "settlement",
        orderId: "ord_99",
      });

      // Parent bindings are never mutated by child overrides
      expect(root.getBindings()).toEqual({ region: "us-east-1" });
      expect(tenantLogger.getBindings()).toEqual({
        region: "us-east-1",
        tenantId: "acme",
        component: "checkout",
        apiKey: "sk_live_secret_xyz",
      });
      expect(orderLogger.getBindings()).toEqual({
        region: "us-east-1",
        tenantId: "acme",
        component: "settlement",
        apiKey: "sk_live_secret_xyz",
        orderId: "ord_99",
      });

      // Structured-first calls across info/log/warn/error/debug
      orderLogger.info(
        { amount: 2500, password: "raw-password" },
        "payment captured",
      );
      orderLogger.warn({ retries: 2 }, "gateway slow");
      orderLogger.error(
        { code: "E_DECLINED", err: new Error("insufficient funds") },
        "capture failed",
      );
      orderLogger.debug({ cacheHit: true }, "rate lookup");
      orderLogger.log({ step: "finalize" }, "ledger updated");

      // Legacy NestJS signatures remain 100% compatible
      root.log("server booted", "Bootstrap");
      root.child("WorkerCtx").log("job finished", { jobId: "j-1" });
      tenantLogger.child("SubCtx").info("hybrid child message");

      const entries = lines.map(
        (line) => JSON.parse(line) as Record<string, any>,
      );
      expect(entries).toHaveLength(8);

      // 0: orderLogger.info
      expect(entries[0]).toMatchObject({
        level: "log",
        service: "payments-api",
        region: "us-east-1",
        tenantId: "acme",
        component: "settlement",
        orderId: "ord_99",
        amount: 2500,
        apiKey: "[REDACTED]",
        password: "[REDACTED]",
        message: "payment captured",
      });

      // 1: orderLogger.warn
      expect(entries[1]).toMatchObject({
        level: "warn",
        tenantId: "acme",
        retries: 2,
        message: "gateway slow",
      });

      // 2: orderLogger.error
      expect(entries[2]).toMatchObject({
        level: "error",
        code: "E_DECLINED",
        message: "capture failed",
      });
      expect(entries[2]!.err.message).toBe("insufficient funds");

      // 3: orderLogger.debug
      expect(entries[3]).toMatchObject({
        level: "debug",
        cacheHit: true,
        message: "rate lookup",
      });

      // 4: orderLogger.log
      expect(entries[4]).toMatchObject({
        level: "log",
        step: "finalize",
        message: "ledger updated",
      });

      // 5: NestJS legacy (message, context)
      expect(entries[5]).toMatchObject({
        level: "log",
        context: "Bootstrap",
        region: "us-east-1",
        message: "server booted",
      });

      // 6: NestJS legacy child(context) + (message, meta)
      expect(entries[6]).toMatchObject({
        level: "log",
        context: "WorkerCtx",
        region: "us-east-1",
        message: "job finished",
        meta: { jobId: "j-1" },
      });

      // 7: child(bindings).child(context) preserves bindings AND sets context
      expect(entries[7]).toMatchObject({
        level: "log",
        context: "SubCtx",
        tenantId: "acme",
        component: "checkout",
        apiKey: "[REDACTED]",
        message: "hybrid child message",
      });
    });

    it("renders bindings and structured fields cleanly in non-JSON text mode and protects trace correlation keys", () => {
      const textLines: string[] = [];
      const textLogger = new ObservabilityLogger({
        serviceName: "api",
        json: false,
        colors: false,
        timestamp: false,
        pid: false,
        writer: (line) => textLines.push(line),
      }).child({ tenantId: "t-1" });

      textLogger.info({ orderId: "o-7", secret: "nope" }, "order ok");
      expect(textLines).toHaveLength(1);
      expect(textLines[0]).toContain("order ok");
      expect(textLines[0]).toContain("tenantId");
      expect(textLines[0]).toContain("o-7");
      expect(textLines[0]).toContain("[REDACTED]");
      expect(textLines[0]).not.toContain("nope");

      // Active traceId cannot be overwritten by user fields
      const jsonLines: string[] = [];
      const jsonLogger = new ObservabilityLogger({
        json: true,
        writer: (line) => jsonLines.push(line),
      });
      const activeTraceId = generateTraceId();
      const activeSpanId = generateSpanId();
      traceContextStorage.run(
        {
          traceId: activeTraceId,
          spanId: activeSpanId,
          traceFlags: 1,
          sampled: true,
        },
        () => {
          jsonLogger.info(
            { traceId: "spoofed", level: "fake", ok: true },
            "correlated",
          );
        },
      );
      const parsed = JSON.parse(jsonLines[0]!) as Record<string, unknown>;
      expect(parsed.traceId).toBe(activeTraceId);
      expect(parsed.level).toBe("log");
      expect(parsed.ok).toBe(true);
      expect(parsed.message).toBe("correlated");
    });
  });
});
