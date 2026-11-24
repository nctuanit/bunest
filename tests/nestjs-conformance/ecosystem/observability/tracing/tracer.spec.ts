import { afterEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Injectable,
  Module,
  Param,
  Post,
  type MiddlewareConsumer,
  type NestModule,
} from "../../../../../packages/core/src/common";
import {
  InMemorySpanExporter,
  MetricsRegistry,
  TRACER_OPTIONS,
  Tracer,
  TracingInterceptor,
  TracingMiddleware,
  TracingModule,
  createTracingMiddleware,
  formatTraceParent,
  generateSpanId,
  generateTraceId,
  parseTraceParent,
  traceContextStorage,
  type SpanExporter,
} from "../../../../../packages/observability/src";
import {
  Test,
  createMockCallHandler,
  createMockExecutionContext,
  createSpy,
  createTestApp,
  describeConformance,
  itAdapted,
  type TestAppContext,
} from "../../../_helpers/index";

describeConformance(
  "Tracer, TraceContextStorage, TracingModule & HTTP Tracing",
  {
    upstreamPath: "observe/src/services/tracer.service.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts upstream @nestjs/observe TracerService tests (sync/async spans, nested parent-child ALS context propagation, attributes, exception capture, exporter isolation, module DI, HTTP middleware/interceptor, and registry-backed metrics identity) to @bunest/observability Tracer & TracingModule.",
  },
  () => {
    const contexts: TestAppContext[] = [];

    afterEach(async () => {
      await Promise.all(contexts.splice(0).map((ctx) => ctx.close()));
    });

    describe("startActiveSpan", () => {
      it("runs a synchronous callback and returns its value", async () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({ exporter });

        const result = await tracer.startActiveSpan("work", () => "done");

        expect(result).toBe("done");
        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0]!.name).toBe("work");
        expect(spans[0]!.status).toEqual({ code: "OK" });
      });

      it("awaits an async callback and records duration", async () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({ exporter });

        const result = await tracer.startActiveSpan("async work", async () => {
          await Bun.sleep(5);
          return "eventually";
        });

        expect(result).toBe("eventually");
        expect(
          exporter.findByName("async work")[0]!.durationMs,
        ).toBeGreaterThanOrEqual(0);
      });

      it("records nested child spans under the active parent in the same trace and restores parent after child finishes", async () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({ exporter });

        let rootTraceId = "";
        let rootSpanId = "";
        let childParentId: string | undefined;
        let restoredSpanId: string | undefined;

        await tracer.startActiveSpan("parent", async (parentSpan) => {
          rootTraceId = parentSpan.traceId;
          rootSpanId = parentSpan.spanId;

          await tracer.startActiveSpan("child", async (childSpan) => {
            childParentId = childSpan.parentSpanId;
            expect(traceContextStorage.getTraceId()).toBe(rootTraceId);
            expect(traceContextStorage.getSpanId()).toBe(childSpan.spanId);
            expect(traceContextStorage.getParentSpanId()).toBe(rootSpanId);
          });

          restoredSpanId = traceContextStorage.getSpanId();
        });

        expect(childParentId).toBe(rootSpanId);
        expect(restoredSpanId).toBe(rootSpanId);
        expect(traceContextStorage.getCurrentSpanContext()).toBeUndefined();

        const spans = exporter.findByTraceId(rootTraceId);
        expect(spans).toHaveLength(2);
        const child = spans.find((s) => s.name === "child")!;
        const parent = spans.find((s) => s.name === "parent")!;
        expect(child.parentSpanId).toBe(parent.spanId);
        expect(parent.parentSpanId).toBeUndefined();
      });

      it("supports concurrent sibling spans under one parent with independent ALS contexts", async () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({ exporter });

        await tracer.startActiveSpan("root", async (rootSpan) => {
          const [a, b] = await Promise.all([
            tracer.startActiveSpan("branch-a", async (span) => {
              await Bun.sleep(10);
              expect(traceContextStorage.getSpanId()).toBe(span.spanId);
              return span.spanId;
            }),
            tracer.startActiveSpan("branch-b", async (span) => {
              await Bun.sleep(5);
              expect(traceContextStorage.getSpanId()).toBe(span.spanId);
              return span.spanId;
            }),
          ]);

          expect(a).not.toBe(b);
          expect(traceContextStorage.getSpanId()).toBe(rootSpan.spanId);
        });

        const spans = exporter.getFinishedSpans();
        const root = spans.find((s) => s.name === "root")!;
        const branchA = spans.find((s) => s.name === "branch-a")!;
        const branchB = spans.find((s) => s.name === "branch-b")!;
        expect(branchA.parentSpanId).toBe(root.spanId);
        expect(branchB.parentSpanId).toBe(root.spanId);
        expect(branchA.traceId).toBe(root.traceId);
        expect(branchB.traceId).toBe(root.traceId);
      });

      it("records exception, sets ERROR status, ends span, and re-throws from failing callback", async () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({ exporter });

        await expect(
          tracer.startActiveSpan("failing", () => {
            throw new Error("inner boom");
          }),
        ).rejects.toThrow("inner boom");

        const finished = exporter.findByName("failing")[0]!;
        expect(finished.status).toEqual({
          code: "ERROR",
          message: "inner boom",
        });
        expect(finished.events).toHaveLength(1);
        expect(finished.events[0]!.name).toBe("exception");
        expect(finished.events[0]!.attributes?.["exception.message"]).toBe(
          "inner boom",
        );
      });

      it("hands the callback a Span that accepts attributes, events, and explicit status", async () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({ exporter });

        await tracer.startActiveSpan(
          "tagged",
          { kind: "CLIENT", attributes: { initial: true } },
          (span) => {
            span.setAttribute("orderId", "o-1");
            span.setAttributes({ items: 3, total: 49.99 });
            span.addEvent("checkpoint", { step: 1 });
            span.setStatus("ERROR", "custom warning");
          },
        );

        const finished = exporter.findByName("tagged")[0]!;
        expect(finished.kind).toBe("CLIENT");
        expect(finished.attributes).toEqual({
          initial: true,
          orderId: "o-1",
          items: 3,
          total: 49.99,
        });
        expect(finished.events[0]!.name).toBe("checkpoint");
        // Explicit ERROR status is NOT overwritten with OK
        expect(finished.status).toEqual({
          code: "ERROR",
          message: "custom warning",
        });
      });

      it("runs cleanly even when no exporters are configured", async () => {
        const tracer = new Tracer();

        const value = await tracer.startActiveSpan("orphan", (span) => {
          span.setAttribute("orderId", "o-1");
          return span.name;
        });

        expect(value).toBe("orphan");
      });
    });

    describe("startSpan & traceContextStorage outside active context", () => {
      it("returns undefined from traceContextStorage accessors outside any async context", () => {
        expect(traceContextStorage.getStore()).toBeUndefined();
        expect(traceContextStorage.getCurrentSpanContext()).toBeUndefined();
        expect(traceContextStorage.getTraceId()).toBeUndefined();
        expect(traceContextStorage.getSpanId()).toBeUndefined();
        expect(traceContextStorage.getParentSpanId()).toBeUndefined();
        expect(traceContextStorage.getRequestId()).toBeUndefined();
      });

      it("propagates requestId and resource attributes onto started spans", async () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({
          serviceName: "checkout-api",
          serviceVersion: "2.1.0",
          resourceAttributes: { "deployment.environment": "test" },
          exporter,
        });

        await tracer.startActiveSpan(
          "outer",
          { requestId: "req-99" },
          async () => {
            expect(traceContextStorage.getRequestId()).toBe("req-99");
            const manual = tracer.startSpan("manual.child");
            expect(manual.context.requestId).toBe("req-99");
            manual.end();
          },
        );

        const finished = exporter.findByName("manual.child")[0]!;
        expect(finished.resource).toEqual({
          "service.name": "checkout-api",
          "service.version": "2.1.0",
          "deployment.environment": "test",
        });
      });

      it("allows explicit parentContext to override ambient ALS context", async () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({ exporter });
        const externalTraceId = generateTraceId();
        const externalSpanId = generateSpanId();

        await tracer.startActiveSpan("ambient", async () => {
          const detached = tracer.startSpan("explicit-parent", {
            parentContext: {
              traceId: externalTraceId,
              spanId: externalSpanId,
              traceFlags: 1,
              sampled: true,
            },
          });
          detached.end();
        });

        const detachedData = exporter.findByName("explicit-parent")[0]!;
        expect(detachedData.traceId).toBe(externalTraceId);
        expect(detachedData.parentSpanId).toBe(externalSpanId);
      });
    });

    describe("exporters, flush, shutdown & fault isolation", () => {
      it("broadcasts finished spans to initial exporter, exporters[], and addExporter()", async () => {
        const e1 = new InMemorySpanExporter();
        const e2 = new InMemorySpanExporter();
        const e3 = new InMemorySpanExporter();
        const tracer = new Tracer({ exporter: e1, exporters: [e2] });
        tracer.addExporter(e3);

        await tracer.startActiveSpan("fanout", () => 1);

        expect(e1.findByName("fanout")).toHaveLength(1);
        expect(e2.findByName("fanout")).toHaveLength(1);
        expect(e3.findByName("fanout")).toHaveLength(1);
      });

      it("invokes flush() and shutdown() on all registered exporters", async () => {
        const flushSpy = createSpy(async () => undefined);
        const shutdownSpy = createSpy(async () => undefined);
        const custom: SpanExporter = {
          export() {},
          flush: flushSpy,
          shutdown: shutdownSpy,
        };
        const tracer = new Tracer({ exporter: custom });

        await tracer.flush();
        expect(flushSpy.calledOnce).toBe(true);

        await tracer.onModuleDestroy();
        expect(shutdownSpy.calledOnce).toBe(true);
      });

      it("isolates sync-throwing and async-rejecting exporters without failing callers or leaking rejections", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);

        const healthy = new InMemorySpanExporter();
        const tracer = new Tracer({
          exporters: [
            {
              export() {
                throw new Error("sync exporter crash");
              },
            },
            {
              async export() {
                await Promise.resolve();
                throw new Error("async exporter crash");
              },
            },
            healthy,
          ],
        });

        try {
          const val = await tracer.startActiveSpan("resilient", async () => 42);
          expect(val).toBe(42);
          await Bun.sleep(15);
          expect(unhandled).toHaveLength(0);
          expect(healthy.findByName("resilient")).toHaveLength(1);
        } finally {
          process.removeListener("unhandledRejection", onUnhandled);
        }
      });
    });

    describe("TracingModule DI, TracingInterceptor & TracingMiddleware", () => {
      it("supports TracingModule.forRoot() and TracingModule.forRootAsync()", async () => {
        @Injectable()
        class TracingConfig {
          readonly serviceName = "async-traced-service";
        }

        @Module({
          providers: [TracingConfig],
          exports: [TracingConfig],
        })
        class ConfigMod {}

        const syncMod = await Test.createTestingModule({
          imports: [
            TracingModule.forRoot({
              serviceName: "sync-svc",
              global: true,
            }),
          ],
        }).compile({ logger: false });
        try {
          expect(syncMod.get(Tracer)).toBeInstanceOf(Tracer);
          expect(syncMod.get(TracingMiddleware)).toBeInstanceOf(
            TracingMiddleware,
          );
          expect(syncMod.get(TracingInterceptor)).toBeInstanceOf(
            TracingInterceptor,
          );
          expect(syncMod.get(TRACER_OPTIONS)).toMatchObject({
            serviceName: "sync-svc",
          });
        } finally {
          await syncMod.close();
        }

        const memExporter = new InMemorySpanExporter();
        const asyncMod = await Test.createTestingModule({
          imports: [
            TracingModule.forRootAsync({
              imports: [ConfigMod],
              inject: [TracingConfig],
              useFactory: async (cfg: TracingConfig) => ({
                serviceName: cfg.serviceName,
                exporter: memExporter,
              }),
            }),
          ],
        }).compile({ logger: false });
        try {
          const tracer = asyncMod.get(Tracer);
          await tracer.startActiveSpan("boot", () => "ok");
          expect(
            memExporter.findByName("boot")[0]!.resource["service.name"],
          ).toBe("async-traced-service");
        } finally {
          await asyncMod.close();
        }
      });

      it("extracts W3C traceparent, records route/status attributes, and propagates trace headers via TracingInterceptor", async () => {
        const exporter = new InMemorySpanExporter();

        @Controller("/orders")
        class OrdersController {
          constructor(private readonly tracer: Tracer) {}

          @Get(":id")
          async findOne(@Param("id") id: string) {
            if (id === "boom") {
              throw new HttpException(
                "internal fail",
                HttpStatus.INTERNAL_SERVER_ERROR,
              );
            }
            return this.tracer.startActiveSpan("db.find", async () => ({
              id,
              traceId: traceContextStorage.getTraceId(),
            }));
          }

          @Post()
          create() {
            return { created: true };
          }
        }

        const ctx = await createTestApp(
          {
            imports: [
              TracingModule.forRoot({
                serviceName: "orders-api",
                exporter,
                registerGlobalInterceptor: true,
              }),
            ],
            controllers: [OrdersController],
          },
          { silentLogger: true },
        );
        contexts.push(ctx);

        const incomingTraceId = generateTraceId();
        const incomingSpanId = generateSpanId();
        const incomingHeader = formatTraceParent({
          traceId: incomingTraceId,
          spanId: incomingSpanId,
          sampled: true,
        });

        const okRes = await ctx
          .request()
          .get("/orders/42")
          .set("traceparent", incomingHeader)
          .set("x-request-id", "req-abc")
          .expect(200);

        expect(okRes.body).toEqual({ id: "42", traceId: incomingTraceId });
        expect(okRes.headers["x-request-id"]).toBe("req-abc");
        const respTrace = parseTraceParent(
          typeof okRes.headers.traceparent === "string"
            ? okRes.headers.traceparent
            : undefined,
        );
        expect(respTrace?.traceId).toBe(incomingTraceId);

        const httpSpan = exporter.findByName("HTTP GET /orders/:id")[0]!;
        const dbSpan = exporter.findByName("db.find")[0]!;
        expect(httpSpan.kind).toBe("SERVER");
        expect(httpSpan.parentSpanId).toBe(incomingSpanId);
        expect(httpSpan.attributes["http.method"]).toBe("GET");
        expect(httpSpan.attributes["http.route"]).toBe("/orders/:id");
        expect(httpSpan.attributes["url.path"]).toBe("/orders/42");
        expect(httpSpan.attributes["http.status_code"]).toBe(200);
        expect(httpSpan.attributes["code.namespace"]).toBe("OrdersController");
        expect(httpSpan.attributes["code.function"]).toBe("findOne");
        expect(dbSpan.parentSpanId).toBe(httpSpan.spanId);

        // POST defaults to 201
        await ctx.request().post("/orders").expect(201);
        const postSpan = exporter.findByName("HTTP POST /orders")[0]!;
        expect(postSpan.attributes["http.status_code"]).toBe(201);

        // Thrown 500 records exception + ERROR status
        await ctx.request().get("/orders/boom").expect(500);
        const errSpan = exporter
          .findByName("HTTP GET /orders/:id")
          .find((s) => s.attributes["url.path"] === "/orders/boom")!;
        expect(errSpan.attributes["http.status_code"]).toBe(500);
        expect(errSpan.status.code).toBe("ERROR");
        expect(errSpan.events[0]!.name).toBe("exception");
      });

      it("creates SERVER spans via TracingMiddleware / createTracingMiddleware and skips non-HTTP in TracingInterceptor", async () => {
        const exporter = new InMemorySpanExporter();

        @Controller("/ping")
        class PingController {
          @Get()
          ping() {
            return {
              traceId: traceContextStorage.getTraceId(),
              requestId: traceContextStorage.getRequestId(),
            };
          }
        }

        @Module({
          imports: [TracingModule.forRoot({ exporter })],
          controllers: [PingController],
        })
        class MiddlewareApp implements NestModule {
          configure(consumer: MiddlewareConsumer) {
            consumer.apply(TracingMiddleware).forRoutes("*");
          }
        }

        const ctx = await createTestApp(
          { imports: [MiddlewareApp] },
          { silentLogger: true },
        );
        contexts.push(ctx);

        const res = await ctx.request().get("/ping").expect(200);
        expect(res.body.traceId).toMatch(/^[0-9a-f]{32}$/);
        expect(typeof res.body.requestId).toBe("string");
        expect(
          parseTraceParent(
            typeof res.headers.traceparent === "string"
              ? res.headers.traceparent
              : undefined,
          )?.traceId,
        ).toBe(res.body.traceId);
        expect(exporter.findByName("HTTP GET /ping")).toHaveLength(1);

        // Non-HTTP context bypasses TracingInterceptor cleanly
        const tracer = new Tracer({ exporter });
        const interceptor = new TracingInterceptor(tracer);
        const rpcCtx = createMockExecutionContext({ contextType: "rpc" });
        const result = await interceptor.intercept(
          rpcCtx,
          createMockCallHandler("rpc-ok"),
        );
        expect(result).toBe("rpc-ok");

        // createTracingMiddleware factory returns a middleware function
        expect(typeof createTracingMiddleware(tracer)).toBe("function");
      });
    });

    describe("registry-backed metrics parity (co-located with Tracer)", () => {
      itAdapted(
        ["ADR-001"],
        "returns the same Counter, Gauge, and Histogram instance per metric name and enforces type isolation",
        () => {
          const registry = new MetricsRegistry();

          const c1 = registry.createCounter({ name: "orders", help: "Orders" });
          c1.inc(5);
          const c2 = registry.createCounter({ name: "orders", help: "Orders" });
          expect(c2).toBe(c1);
          expect(c2.get()).toBe(5);

          const g1 = registry.createGauge({
            name: "in_flight",
            help: "In flight",
          });
          g1.inc(3);
          expect(
            registry.createGauge({ name: "in_flight", help: "In flight" }),
          ).toBe(g1);

          const h1 = registry.createHistogram({
            name: "latency",
            help: "Latency",
          });
          h1.observe(10);
          expect(
            registry.createHistogram({ name: "latency", help: "Latency" }),
          ).toBe(h1);

          expect(() =>
            registry.createGauge({ name: "orders", help: "Collision" }),
          ).toThrow(/already registered as "counter"/);
        },
        "Bunest separates metrics into MetricsRegistry (Prometheus) rather than coupling custom metrics onto Tracer",
      );
    });
  },
);
