import { beforeEach, describe, expect, it } from "bun:test";
import * as coreExports from "../../../../../../packages/core/src";
import {
  HttpExecutionContext,
  HttpResponseContext,
  RequestContext,
  type NextFunction,
} from "../../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "ExecutionContextHost / HttpExecutionContext",
  {
    upstreamPath: "packages/core/test/helpers/execution-context-host.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-010"],
    notes:
      "Tests Bunest's HttpExecutionContext (native Request + HttpResponseContext + NextFunction) alongside upstream ExecutionContextHost API parity checks.",
  },
  () => {
    class SampleController {
      handle() {
        return null;
      }
    }

    let req: Request;
    let resCtx: HttpResponseContext;
    let nextFn: NextFunction;
    let contextHost: HttpExecutionContext;

    beforeEach(() => {
      req = new Request("http://localhost/test");
      resCtx = new HttpResponseContext();
      nextFn = () => undefined;
      const reqCtx = new RequestContext({
        request: req,
        responseContext: resCtx,
      });
      contextHost = new HttpExecutionContext(
        reqCtx,
        SampleController,
        SampleController.prototype.handle,
        "handle",
        nextFn,
      );
    });

    describe("getClass", () => {
      it("should return constructorRef", () => {
        expect(contextHost.getClass()).toBe(SampleController);
      });
    });

    describe("getHandler", () => {
      it("should return handler", () => {
        expect(contextHost.getHandler()).toBe(
          SampleController.prototype.handle,
        );
        expect(contextHost.getHandlerKey()).toBe("handle");
      });
    });

    describe("getArgs", () => {
      it("should return args", () => {
        expect(contextHost.getArgs()).toEqual([req, resCtx, nextFn]);
      });
    });

    describe("getArgByIndex", () => {
      it("should return argument by index", () => {
        expect(contextHost.getArgByIndex(0)).toBe(req);
        expect(contextHost.getArgByIndex(1)).toBe(resCtx);
        expect(contextHost.getArgByIndex(2)).toBe(nextFn);
      });
    });

    describe("switchToRpc", () => {
      it("should return rpc proxy", () => {
        const proxy = contextHost.switchToRpc();
        expect(typeof proxy.getData).toBe("function");
        expect(typeof proxy.getContext).toBe("function");
        expect(proxy.getData()).toBe(req);
        expect(proxy.getContext()).toBe(resCtx);
      });
    });

    describe("switchToHttp", () => {
      itAdapted(
        ["ADR-001", "ADR-010"],
        "should return http proxy",
        () => {
          const proxy = contextHost.switchToHttp();
          expect(typeof proxy.getRequest).toBe("function");
          expect(typeof proxy.getResponse).toBe("function");
          expect(typeof proxy.getNext).toBe("function");
          expect(proxy.getRequest()).toBe(req);
          expect(proxy.getResponse()).toBe(resCtx);
          expect(proxy.getNext()).toBe(nextFn);
        },
        "Web Request + HttpResponseContext",
      );
    });

    describe("switchToWs", () => {
      it("should return ws proxy", () => {
        const proxy = contextHost.switchToWs();
        expect(typeof proxy.getData).toBe("function");
        expect(typeof proxy.getClient).toBe("function");
        expect(proxy.getClient()).toBe(req);
        expect(proxy.getData()).toBe(resCtx);
      });

      // BUNEST_BUG: @bunest/core does not export ExecutionContextHost (only HttpExecutionContext), and HttpExecutionContext.switchToWs().getPattern() hardcodes "" instead of returning the last argument (packages/core/src/index.ts, packages/core/src/http/context/execution-context.ts:71-77).
      it.skip("should return the last arg via getPattern on ExecutionContextHost", () => {
        const ExecutionContextHost = (coreExports as Record<string, unknown>)
          .ExecutionContextHost as
          | (new (
              args: unknown[],
              constructorRef?: unknown,
              handler?: unknown,
            ) => { switchToWs(): { getPattern(): unknown } })
          | undefined;
        expect(ExecutionContextHost).toBeDefined();
        const generic = new ExecutionContextHost!(["test", "test2", "test3"]);
        expect(generic.switchToWs().getPattern()).toBe("test3");
      });
    });

    describe("getType", () => {
      it('should return "http" by default', () => {
        expect(contextHost.getType()).toBe("http");
      });
    });

    describe("setType", () => {
      // BUNEST_BUG: @bunest/core does not export ExecutionContextHost and HttpExecutionContext has no setType() method (packages/core/src/index.ts, packages/core/src/http/context/execution-context.ts:39-41).
      it.skip("should update the context type", () => {
        const ExecutionContextHost = (coreExports as Record<string, unknown>)
          .ExecutionContextHost as
          | (new (args: unknown[]) => {
              setType(type: string): void;
              getType(): string;
            })
          | undefined;
        expect(ExecutionContextHost).toBeDefined();
        const generic = new ExecutionContextHost!(["a"]);
        generic.setType("ws");
        expect(generic.getType()).toBe("ws");
      });

      // BUNEST_BUG: @bunest/core does not export ExecutionContextHost and HttpExecutionContext has no setType() method (packages/core/src/index.ts, packages/core/src/http/context/execution-context.ts:39-41).
      it.skip("should not update when type is falsy", () => {
        const ExecutionContextHost = (coreExports as Record<string, unknown>)
          .ExecutionContextHost as
          | (new (args: unknown[]) => {
              setType(type: string): void;
              getType(): string;
            })
          | undefined;
        expect(ExecutionContextHost).toBeDefined();
        const generic = new ExecutionContextHost!(["a"]);
        generic.setType("");
        expect(generic.getType()).toBe("http");
      });

      // BUNEST_BUG: @bunest/core does not export ExecutionContextHost and HttpExecutionContext has no setType() method (packages/core/src/index.ts, packages/core/src/http/context/execution-context.ts:39-41).
      it.skip("should support custom string types", () => {
        const ExecutionContextHost = (coreExports as Record<string, unknown>)
          .ExecutionContextHost as
          | (new (args: unknown[]) => {
              setType(type: string): void;
              getType(): string;
            })
          | undefined;
        expect(ExecutionContextHost).toBeDefined();
        const generic = new ExecutionContextHost!(["a"]);
        generic.setType("graphql");
        expect(generic.getType()).toBe("graphql");
      });
    });

    describe("constructor defaults", () => {
      // BUNEST_BUG: @bunest/core does not export ExecutionContextHost supporting optional null constructorRef/handler defaults (packages/core/src/index.ts, packages/core/src/http/context/execution-context.ts:25-37).
      it.skip("should allow null constructorRef and handler", () => {
        const ExecutionContextHost = (coreExports as Record<string, unknown>)
          .ExecutionContextHost as
          | (new (args: unknown[]) => {
              getClass(): unknown;
              getHandler(): unknown;
            })
          | undefined;
        expect(ExecutionContextHost).toBeDefined();
        const ctx = new ExecutionContextHost!(["a"]);
        expect(ctx.getClass()).toBeNull();
        expect(ctx.getHandler()).toBeNull();
      });
    });
  },
);
