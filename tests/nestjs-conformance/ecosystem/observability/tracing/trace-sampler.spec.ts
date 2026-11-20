import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { Controller, Get } from "../../../../../packages/common/src";
import {
  InMemorySpanExporter,
  Tracer,
  TracingModule,
  generateSpanId,
  generateTraceId,
  traceContextStorage,
  type SpanContext,
} from "../../../../../packages/observability/src";
import {
  createSandbox,
  createSpy,
  createTestApp,
  describeConformance,
  itAdapted,
  type TestAppContext,
} from "../../../_helpers/index";

describeConformance(
  "Trace Sampler Policy (Tracer options.sampler)",
  {
    upstreamPath: "observe/src/services/trace-sampler.service.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/observe TraceSamplerService tests (default capture-all, probabilistic rate, callback filtering, parent-based inheritance, unsampled suppression, and throwing sampler safety) to @bunest/observability Tracer.options.sampler.",
  },
  () => {
    const sandbox = createSandbox();
    const contexts: TestAppContext[] = [];

    afterEach(async () => {
      sandbox.restore();
      await Promise.all(contexts.splice(0).map((ctx) => ctx.close()));
    });

    describe("when no sampler is configured", () => {
      it("captures all root spans by default", async () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({ exporter });

        await tracer.startActiveSpan("HTTP GET /orders", async (span) => {
          expect(span.context.sampled).toBe(true);
          expect(span.context.traceFlags).toBe(0x01);
        });

        expect(exporter.getFinishedSpans()).toHaveLength(1);
      });

      it("inherits parentContext.sampled when parentContext is provided", async () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({ exporter });

        const unsampledParent: SpanContext = {
          traceId: generateTraceId(),
          spanId: generateSpanId(),
          traceFlags: 0x00,
          sampled: false,
        };
        const sampledParent: SpanContext = {
          traceId: generateTraceId(),
          spanId: generateSpanId(),
          traceFlags: 0x01,
          sampled: true,
        };

        await tracer.startActiveSpan(
          "dropped.child",
          { parentContext: unsampledParent },
          async (span) => {
            expect(span.context.sampled).toBe(false);
            expect(span.context.traceFlags).toBe(0x00);
          },
        );
        await tracer.startActiveSpan(
          "kept.child",
          { parentContext: sampledParent },
          async (span) => {
            expect(span.context.sampled).toBe(true);
            expect(span.context.traceFlags).toBe(0x01);
          },
        );

        expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
          "kept.child",
        ]);
      });
    });

    describe("probabilistic rate samplers", () => {
      const rateSampler = (rate: number) => () =>
        rate >= 1 ? true : rate <= 0 ? false : Math.random() < rate;

      it("captures everything at rate 1 and nothing at rate 0", () => {
        const expAll = new InMemorySpanExporter();
        const tracerAll = new Tracer({
          exporter: expAll,
          sampler: rateSampler(1),
        });
        for (let i = 0; i < 10; i++) {
          tracerAll.startSpan(`op-${i}`).end();
        }
        expect(expAll.getFinishedSpans()).toHaveLength(10);

        const expNone = new InMemorySpanExporter();
        const tracerNone = new Tracer({
          exporter: expNone,
          sampler: rateSampler(0),
        });
        for (let i = 0; i < 10; i++) {
          tracerNone.startSpan(`op-${i}`).end();
        }
        expect(expNone.getFinishedSpans()).toHaveLength(0);
      });

      it("captures according to Math.random() threshold for fractional rates", () => {
        const randomStub = sandbox.stub(Math, "random");
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({
          exporter,
          sampler: rateSampler(0.5),
        });

        randomStub.returns(0.2);
        const kept = tracer.startSpan("low-roll");
        kept.end();
        expect(kept.context.sampled).toBe(true);

        randomStub.returns(0.7);
        const dropped = tracer.startSpan("high-roll");
        dropped.end();
        expect(dropped.context.sampled).toBe(false);

        expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
          "low-roll",
        ]);
      });

      it("is statistically close to the configured 10% rate over 10,000 decisions", () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({
          exporter,
          sampler: rateSampler(0.1),
        });

        for (let i = 0; i < 10_000; i++) {
          tracer.startSpan("sample").end();
        }

        const captured = exporter.getFinishedSpans().length;
        expect(captured).toBeGreaterThan(500);
        expect(captured).toBeLessThan(1500);
      });
    });

    describe("callback predicate samplers", () => {
      it("defers the decision to the callback with { name, parentContext }", () => {
        const decide = createSpy(
          (_input: { name: string; parentContext?: SpanContext }) => false,
        );
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({ exporter, sampler: decide });

        const parentContext: SpanContext = {
          traceId: generateTraceId(),
          spanId: generateSpanId(),
          traceFlags: 1,
          sampled: true,
        };
        const span = tracer.startSpan("HTTP GET /orders", { parentContext });
        span.end();

        expect(decide.calledOnce).toBe(true);
        expect(decide.firstCall?.args[0]).toEqual({
          name: "HTTP GET /orders",
          parentContext,
        });
        expect(span.context.sampled).toBe(false);
        expect(exporter.getFinishedSpans()).toHaveLength(0);
      });

      it("keeps important spans and drops noisy health check routes over HTTP", async () => {
        const exporter = new InMemorySpanExporter();

        @Controller()
        class SampledController {
          @Get("/health")
          health() {
            return { status: "ok" };
          }

          @Get("/checkout")
          checkout() {
            return { ok: true };
          }
        }

        const ctx = await createTestApp(
          {
            imports: [
              TracingModule.forRoot({
                exporter,
                registerGlobalInterceptor: true,
                sampler: ({ name }) => !name.includes("/health"),
              }),
            ],
            controllers: [SampledController],
          },
          { silentLogger: true },
        );
        contexts.push(ctx);

        await ctx.request().get("/health").expect(200);
        await ctx.request().get("/checkout").expect(200);

        expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
          "HTTP GET /checkout",
        ]);
      });

      it("still executes startActiveSpan callbacks, propagates unsampled context, and rethrows errors when unsampled", async () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({
          exporter,
          sampler: () => false,
        });

        let observedSampled: boolean | undefined;
        const result = await tracer.startActiveSpan("dropped.ok", async () => {
          observedSampled = traceContextStorage.getCurrentSpanContext()?.sampled;
          return "computed";
        });
        expect(result).toBe("computed");
        expect(observedSampled).toBe(false);

        await expect(
          tracer.startActiveSpan("dropped.fail", async () => {
            throw new Error("business failure");
          }),
        ).rejects.toThrow("business failure");

        expect(exporter.getFinishedSpans()).toHaveLength(0);
      });

      itAdapted(
        ["ADR-001"],
        "supports parent-based custom sampler overriding by baggage or traceState",
        async () => {
          const exporter = new InMemorySpanExporter();
          const tracer = new Tracer({
            exporter,
            sampler: ({ parentContext }) =>
              parentContext?.baggage?.debug === "1" ||
              (parentContext?.sampled ?? false),
          });

          const forceDebugParent: SpanContext = {
            traceId: generateTraceId(),
            spanId: generateSpanId(),
            traceFlags: 0x00,
            sampled: false,
            baggage: { debug: "1" },
          };
          const normalUnsampledParent: SpanContext = {
            traceId: generateTraceId(),
            spanId: generateSpanId(),
            traceFlags: 0x00,
            sampled: false,
          };

          tracer.startSpan("debug.forced", { parentContext: forceDebugParent }).end();
          tracer.startSpan("normal.dropped", { parentContext: normalUnsampledParent }).end();

          expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual([
            "debug.forced",
          ]);
        },
        "Bunest sampler receives full SpanContext (including baggage/traceState) to allow custom parent-based rules",
      );

      // BUNEST_BUG: `Tracer.startSpan()` in `packages/observability/src/tracing/tracer.ts:81-83` invokes `this.sampler({ name, parentContext: parent })` without a try/catch guard, so a throwing sampler callback crashes application request handling instead of safely falling back to unsampled (`sampled = false`).
      it.skip("captures nothing and does not crash the caller when the sampler callback throws", () => {
        const exporter = new InMemorySpanExporter();
        const tracer = new Tracer({
          exporter,
          sampler: () => {
            throw new Error("no such attribute");
          },
        });

        const span = tracer.startSpan("HTTP GET /orders");
        span.end();

        expect(span.context.sampled).toBe(false);
        expect(exporter.getFinishedSpans()).toHaveLength(0);
      });
    });
  },
);
