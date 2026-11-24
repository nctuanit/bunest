import { expect, it } from "bun:test";
import {
  MetadataRegistry,
  SSE_ABORT_CONTROLLER,
  SseSignal,
} from "../../../../../../packages/core/src/common";
import {
  HttpExecutionContext,
  RequestContext,
  compileParameters,
} from "../../../../../../packages/core/src/http";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "@SseSignal",
  {
    upstreamPath:
      "packages/common/test/decorators/sse-signal.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-001", "ADR-004"],
    notes:
      "Bunest registers @SseSignal() as ParameterMetadata `{ source: 'sseSignal' }` and extracts native Web `Request.signal` (ADR-001) rather than reading a custom factory from `[SSE_ABORT_CONTROLLER]`.",
  },
  () => {
    class Test {
      public stream(@SseSignal() _signal: AbortSignal) {}
    }

    const params = MetadataRegistry.getRouteParameters(Test, "stream");
    const { compiled } = compileParameters(params);
    const extractor = compiled[0]!.extract;

    itAdapted(
      ["ADR-001", "ADR-004"],
      "should register sseSignal parameter metadata and export SSE_ABORT_CONTROLLER token",
      () => {
        expect(typeof SSE_ABORT_CONTROLLER).toBe("symbol");
        expect(params).toHaveLength(1);
        expect(params[0]).toMatchObject({
          index: 0,
          source: "sseSignal",
        });
      },
      "native ParameterMetadata source: 'sseSignal'",
    );

    itAdapted(
      "ADR-001",
      "should return the signal of the abort controller attached to the Web Request",
      () => {
        const controller = new AbortController();
        const request = new Request("http://bunest.test/events", {
          signal: controller.signal,
        });
        const reqCtx = new RequestContext({ request });
        const execCtx = new HttpExecutionContext(
          reqCtx,
          Test,
          Test.prototype.stream,
          "stream",
          () => undefined,
        );

        const extracted = extractor(reqCtx, execCtx) as AbortSignal;
        expect(extracted).toBeInstanceOf(AbortSignal);
        expect(extracted.aborted).toBe(false);
        controller.abort();
        expect(extracted.aborted).toBe(true);
      },
      "extracts native Request.signal via RequestContext.signal",
    );

    it("should provide a non-aborted default signal on a standard Request without explicit AbortController", () => {
      const request = new Request("http://bunest.test/events");
      const reqCtx = new RequestContext({ request });
      const execCtx = new HttpExecutionContext(
        reqCtx,
        Test,
        Test.prototype.stream,
        "stream",
        () => undefined,
      );

      const extracted = extractor(reqCtx, execCtx) as AbortSignal;
      expect(extracted).toBe(request.signal);
      expect(extracted.aborted).toBe(false);
    });
  },
);
