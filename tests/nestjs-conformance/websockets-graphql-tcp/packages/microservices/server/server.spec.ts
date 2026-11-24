import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Catch,
  Controller,
  HttpException,
  Injectable,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type PipeTransform,
} from "../../../../../../packages/core/src/common";
import {
  Ctx,
  EventPattern,
  InMemoryBroker,
  InMemoryClientProxy,
  InMemoryServer,
  MICROSERVICE_SERVER,
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  MicroserviceTransportServer,
  Payload,
  RpcException,
  RpcExecutionContext,
  Transport,
  type CustomTransportStrategy,
  type MessageHandler,
  type RpcContext,
  type SerializedRpcError,
} from "../../../../../../packages/microservices/src";
import { Test } from "../../../../../../packages/testing/src";
import {
  createSandbox,
  createSpy,
  describeConformance,
  expectCalledOnce,
  expectCalledWith,
  expectNotCalled,
  itAdapted,
} from "../../../../_helpers";

class TestServer extends MicroserviceTransportServer {
  public readonly transport = Transport.IN_MEMORY;

  public async listen(): Promise<void> {
    this.listening = true;
  }

  public async close(): Promise<void> {
    this.listening = false;
  }

  public async callDispatchMessage(
    pattern: string,
    data: unknown,
    ctx: RpcContext = { transport: Transport.IN_MEMORY, pattern },
  ): Promise<{ response?: unknown; error?: SerializedRpcError }> {
    return await this.dispatchMessage(pattern, data, ctx);
  }

  public async callDispatchEvent(
    pattern: string,
    data: unknown,
    ctx: RpcContext = { transport: Transport.IN_MEMORY, pattern },
  ): Promise<void> {
    await this.dispatchEvent(pattern, data, ctx);
  }

  public callSerializeError(err: unknown): SerializedRpcError {
    return this.serializeError(err);
  }
}

describeConformance(
  "MicroserviceTransportServer (Server)",
  {
    upstreamPath: "packages/microservices/test/server/server.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
    notes:
      "Ports Server handler registration, pattern lookup, request/event dispatch, error serialization, preRequestHook, CustomTransportStrategy, RpcExecutionContext, and MicroserviceHost enhancer pipelines (Promise-based ADR-008).",
  },
  () => {
    const sandbox = createSandbox();
    let server: TestServer;

    beforeEach(() => {
      server = new TestServer();
    });

    afterEach(() => {
      sandbox.restore();
    });

    describe("addMessageHandler / getMessageHandler / getRegisteredPatterns", () => {
      it("should register and retrieve handlers for string, object, and RegExp patterns", () => {
        const strHandler: MessageHandler = () => "str";
        const objHandler: MessageHandler = () => "obj";
        const rxHandler: MessageHandler = () => "rx";

        server.addMessageHandler("hello", strHandler);
        server.addMessageHandler({ test: "pattern", a: 1 }, objHandler);
        server.addMessageHandler(/^rpc\./, rxHandler);

        expect(server.getMessageHandler("hello")).toBe(strHandler);
        expect(server.getMessageHandler({ a: 1, test: "pattern" })).toBe(
          objHandler,
        );
        expect(server.getMessageHandler('{"a":1,"test":"pattern"}')).toBe(
          objHandler,
        );
        expect(server.getMessageHandler(/^rpc\./)).toBe(rxHandler);
        expect(server.getMessageHandler("missing")).toBeUndefined();

        expect(server.getRegisteredPatterns()).toEqual({
          messagePatterns: ["hello", '{"a":1,"test":"pattern"}', "/^rpc\\./"],
          eventPatterns: [],
        });
      });

      it("should throw when registering a duplicate message handler for the same normalized pattern", () => {
        server.addMessageHandler({ b: 2, a: 1 }, () => 1);

        expect(() => server.addMessageHandler({ a: 1, b: 2 }, () => 2)).toThrow(
          /Duplicate @MessagePattern/,
        );
      });

      it("should find exact string handlers for string patterns that read as JSON", () => {
        for (const jsonLike of [
          "1.0",
          "1e3",
          "true",
          "false",
          "null",
          "[1]",
          '"x"',
        ]) {
          const s = new TestServer();
          const handler: MessageHandler = () => jsonLike;
          s.addMessageHandler(jsonLike, handler);

          expect(s.getMessageHandler(jsonLike)).toBe(handler);
        }
      });

      it("should keep exact string '\"x\"' separate from plain string 'x'", () => {
        const parsedHandler: MessageHandler = () => "x";
        const exactHandler: MessageHandler = () => '"x"';
        server.addMessageHandler("x", parsedHandler);
        server.addMessageHandler('"x"', exactHandler);

        expect(server.getMessageHandler('"x"')).toBe(exactHandler);
        expect(server.getMessageHandler("x")).toBe(parsedHandler);
      });

      it("should return undefined when no message handler matches", () => {
        server.addMessageHandler("1.0", () => "one");
        expect(server.getMessageHandler("2.0")).toBeUndefined();
      });
    });

    describe("addEventHandler / getEventHandlers", () => {
      it("should register multiple event handlers for the same pattern in registration order", () => {
        const h1: MessageHandler = () => "one";
        const h2: MessageHandler = () => "two";
        const h3: MessageHandler = () => "three";

        server.addEventHandler({ evt: "created" }, h1);
        server.addEventHandler({ evt: "created" }, h2);
        server.addEventHandler({ evt: "created" }, h3);

        expect(server.getEventHandlers({ evt: "created" })).toEqual([
          h1,
          h2,
          h3,
        ]);
        expect(server.getEventHandlers("unregistered")).toEqual([]);
        expect(server.getRegisteredPatterns().eventPatterns).toEqual([
          '{"evt":"created"}',
        ]);
      });

      it("should isolate messageHandlers and eventHandlers maps for the same pattern", () => {
        const msgHandler: MessageHandler = () => "msg";
        const evtHandler: MessageHandler = () => "evt";

        server.addMessageHandler("shared.pattern", msgHandler);
        server.addEventHandler("shared.pattern", evtHandler);

        expect(server.getMessageHandler("shared.pattern")).toBe(msgHandler);
        expect(server.getEventHandlers("shared.pattern")).toEqual([evtHandler]);
      });
    });

    describe("dispatchMessage (Promise request handling)", () => {
      itAdapted(
        "ADR-008",
        "should return { response } for sync primitives, arrays, objects, and async Promises",
        async () => {
          server.addMessageHandler("num", () => 100);
          server.addMessageHandler("arr", () => [1, 2, 3]);
          server.addMessageHandler("async", async (data) => {
            await Bun.sleep(5);
            return { echoed: data };
          });
          server.addMessageHandler("nullish", () => null);

          expect(await server.callDispatchMessage("num", null)).toEqual({
            response: 100,
          });
          expect(await server.callDispatchMessage("arr", null)).toEqual({
            response: [1, 2, 3],
          });
          expect(await server.callDispatchMessage("async", "hi")).toEqual({
            response: { echoed: "hi" },
          });
          expect(await server.callDispatchMessage("nullish", null)).toEqual({
            response: null,
          });
        },
        "Promise return instead of RxJS transformToObservable",
      );

      it("should pass data and RpcContext to the matched message handler", async () => {
        const handler = createSpy((data: unknown, ctx: RpcContext) => ({
          data,
          ctx,
        }));
        server.addMessageHandler("inspect", handler);

        const ctx: RpcContext = {
          transport: Transport.IN_MEMORY,
          pattern: "inspect",
          metadata: { traceId: "t-1" },
        };
        const out = await server.callDispatchMessage("inspect", { x: 7 }, ctx);

        expectCalledOnce(handler);
        expectCalledWith(handler, { x: 7 }, ctx);
        expect(out).toEqual({ response: { data: { x: 7 }, ctx } });
      });

      it("should return a 404 serialized RpcException when no message handler is found", async () => {
        const outcome = await server.callDispatchMessage("missing.cmd", {});

        expect(outcome.response).toBeUndefined();
        expect(outcome.error).toEqual({
          status: 404,
          name: "RpcException",
          message:
            'No @MessagePattern() handler found for pattern "missing.cmd".',
          details: {
            status: 404,
            message:
              'No @MessagePattern() handler found for pattern "missing.cmd".',
          },
          isRpcException: true,
        });
      });

      it("should NOT invoke an @EventPattern handler when dispatching a request message", async () => {
        const evtSpy = createSpy(() => "should-not-reply");
        server.addEventHandler("only.event", evtSpy);

        const outcome = await server.callDispatchMessage("only.event", {});

        expectNotCalled(evtSpy);
        expect(outcome.error?.status).toBe(404);
      });

      it("should run setPreRequestHook before handler and return error if hook throws", async () => {
        const order: string[] = [];
        const handler = createSpy(() => {
          order.push("handler");
          return "ok";
        });
        server.addMessageHandler("hooked", handler);

        const chained = server.setPreRequestHook(async ({ pattern, data }) => {
          order.push(`hook:${pattern}:${String(data)}`);
        });
        expect(chained).toBe(server);

        const ok = await server.callDispatchMessage("hooked", 123);
        expect(ok).toEqual({ response: "ok" });
        expect(order).toEqual(["hook:hooked:123", "handler"]);

        // Hook throwing blocks handler execution
        handler.resetHistory();
        server.setPreRequestHook(() => {
          throw new RpcException({ status: 401, message: "unauthenticated" });
        });
        const denied = await server.callDispatchMessage("hooked", 123);
        expectNotCalled(handler);
        expect(denied.error?.status).toBe(401);
        expect(denied.error?.message).toBe("unauthenticated");
        expect(denied.error?.isRpcException).toBe(true);

        // Clearing hook restores normal execution
        server.setPreRequestHook(undefined);
        expect(await server.callDispatchMessage("hooked", 456)).toEqual({
          response: "ok",
        });
        expectCalledOnce(handler);
      });
    });

    describe("dispatchEvent", () => {
      it("should safely return when no event handler exists", async () => {
        await expect(
          server.callDispatchEvent("unknown_event", null),
        ).resolves.toBeUndefined();
      });

      it("should invoke every registered event handler sequentially in registration order", async () => {
        const order: string[] = [];
        server.addEventHandler("order.evt", async (data) => {
          await Bun.sleep(10);
          order.push(`first:${String(data)}`);
        });
        server.addEventHandler("order.evt", (data) => {
          order.push(`second:${String(data)}`);
        });

        await server.callDispatchEvent("order.evt", "payload");
        expect(order).toEqual(["first:payload", "second:payload"]);
      });

      it("should isolate errors in throwing event handlers so subsequent handlers still execute", async () => {
        const secondSpy = createSpy(() => {});
        server.addEventHandler("resilient.evt", () => {
          throw new Error("sync boom");
        });
        server.addEventHandler("resilient.evt", async () => {
          throw new Error("async boom");
        });
        server.addEventHandler("resilient.evt", secondSpy);

        await expect(
          server.callDispatchEvent("resilient.evt", { ok: true }),
        ).resolves.toBeUndefined();
        expectCalledOnce(secondSpy);
        expectCalledWith(secondSpy, { ok: true });
      });

      it("should snapshot handler list so handlers added during dispatch do not run in the same dispatch", async () => {
        const lateSpy = createSpy(() => {});
        server.addEventHandler("mutate.evt", () => {
          server.addEventHandler("mutate.evt", lateSpy);
        });

        await server.callDispatchEvent("mutate.evt", null);
        expectNotCalled(lateSpy);

        // Subsequent dispatch includes the newly added handler
        await server.callDispatchEvent("mutate.evt", null);
        expectCalledOnce(lateSpy);
      });
    });

    describe("serializeError", () => {
      it("should serialize RpcException, HttpException, Error, and non-Error values", () => {
        expect(server.callSerializeError(new RpcException("rpc-str"))).toEqual({
          message: "rpc-str",
          name: "RpcException",
          isRpcException: true,
        });

        expect(
          server.callSerializeError(
            new RpcException({ status: 409, message: "conflict", id: 5 }),
          ),
        ).toEqual({
          message: "conflict",
          name: "RpcException",
          status: 409,
          details: { status: 409, message: "conflict", id: 5 },
          isRpcException: true,
        });

        const httpErr = new BadRequestException("bad input");
        expect(server.callSerializeError(httpErr)).toEqual({
          message: httpErr.message,
          name: httpErr.name,
          status: 400,
          details: httpErr.getResponse(),
          isRpcException: true,
        });

        const genericHttp = new HttpException("teapot", 418);
        expect(server.callSerializeError(genericHttp).status).toBe(418);

        expect(server.callSerializeError(new TypeError("invalid"))).toEqual({
          message: "invalid",
          name: "TypeError",
          isRpcException: false,
        });

        expect(server.callSerializeError("plain string error")).toEqual({
          message: "plain string error",
          isRpcException: false,
        });

        expect(server.callSerializeError(42)).toEqual({
          message: "42",
          isRpcException: false,
        });
      });
    });

    describe("isListening, unwrap & CustomTransportStrategy", () => {
      it("should track isListening across listen() and close() and unwrap() to self by default", async () => {
        expect(server.isListening).toBe(false);
        expect(server.unwrap()).toBe(server);

        await server.listen();
        expect(server.isListening).toBe(true);

        await server.close();
        expect(server.isListening).toBe(false);
      });

      it("should adapt callback-based, Promise-based, and sync CustomTransportStrategy via MicroserviceModule.forRoot({ strategy })", async () => {
        const nativeHandle = { tag: "custom-underlying" };
        let listened = false;
        let closed = false;

        const callbackStrategy: CustomTransportStrategy = {
          transportId: Symbol("CUSTOM_CB"),
          listen(callback) {
            listened = true;
            callback?.();
          },
          close() {
            closed = true;
          },
          unwrap<T>() {
            return nativeHandle as unknown as T;
          },
        };

        const mod = await Test.createTestingModule({
          imports: [MicroserviceModule.forRoot({ strategy: callbackStrategy })],
        }).compile();
        await mod.init();

        const adaptedServer =
          mod.get<MicroserviceTransportServer>(MICROSERVICE_SERVER);
        expect(listened).toBe(true);
        expect(adaptedServer.isListening).toBe(true);
        expect(adaptedServer.unwrap()).toBe(nativeHandle);

        await mod.close();
        expect(closed).toBe(true);
        expect(adaptedServer.isListening).toBe(false);
      });

      it("should adapt Promise-returning CustomTransportStrategy without requiring callback invocation", async () => {
        let listened = false;
        let closed = false;

        const asyncStrategy: CustomTransportStrategy = {
          async listen() {
            await Bun.sleep(5);
            listened = true;
          },
          async close() {
            await Bun.sleep(5);
            closed = true;
          },
        };

        const mod = await Test.createTestingModule({
          imports: [MicroserviceModule.forRoot({ strategy: asyncStrategy })],
        }).compile();
        await mod.init();

        const adaptedServer =
          mod.get<MicroserviceTransportServer>(MICROSERVICE_SERVER);
        expect(listened).toBe(true);
        expect(adaptedServer.isListening).toBe(true);
        expect(adaptedServer.unwrap()).toBe(asyncStrategy);

        await mod.close();
        expect(closed).toBe(true);
        expect(adaptedServer.isListening).toBe(false);
      });
    });

    describe("RpcExecutionContext & MicroserviceHost enhancer pipeline", () => {
      it("should expose rpc ExecutionContext metadata and reject HTTP/WS switches", () => {
        class SampleController {
          handle() {}
        }
        const rpcCtx: RpcContext = {
          transport: Transport.TCP,
          pattern: "sample.op",
          metadata: { remoteAddress: "127.0.0.1" },
        };
        const execCtx = new RpcExecutionContext(
          SampleController,
          SampleController.prototype.handle,
          "handle",
          { num: 7 },
          rpcCtx,
        );

        expect(execCtx.getType()).toBe("rpc");
        expect(execCtx.getClass()).toBe(SampleController);
        expect(execCtx.getHandler()).toBe(SampleController.prototype.handle);
        expect(execCtx.getHandlerKey()).toBe("handle");
        expect(execCtx.getArgs()).toEqual([{ num: 7 }, rpcCtx]);
        expect(execCtx.getArgByIndex(0)).toEqual({ num: 7 });
        expect(execCtx.getArgByIndex(1)).toBe(rpcCtx);
        expect(execCtx.getArgByIndex(2)).toBeUndefined();
        expect(execCtx.switchToRpc().getData()).toEqual({ num: 7 });
        expect(execCtx.switchToRpc().getContext()).toBe(rpcCtx);
        expect(() => execCtx.switchToHttp()).toThrow(/switchToRpc/);
        expect(() => execCtx.switchToWs()).toThrow(/switchToRpc/);
      });

      itAdapted(
        "ADR-008",
        "should execute global -> class -> method guards, interceptors, pipes, and method -> class -> global filters",
        async () => {
          const broker = new InMemoryBroker();
          const memServer = new InMemoryServer({
            channel: "pipeline-order",
            broker,
          });
          const trace: string[] = [];

          @Injectable()
          class GlobalGuard implements CanActivate {
            canActivate() {
              trace.push("guard:global");
              return true;
            }
          }

          @Injectable()
          class MethodGuard implements CanActivate {
            canActivate(ctx: ExecutionContext) {
              trace.push("guard:method");
              const data = ctx.switchToRpc().getData<{ allow?: boolean }>();
              return data?.allow !== false;
            }
          }

          @Injectable()
          class GlobalInterceptor implements BunestInterceptor {
            async intercept(_ctx: ExecutionContext, next: CallHandler) {
              trace.push("interceptor:global:before");
              const res = await next.handle();
              trace.push("interceptor:global:after");
              return res;
            }
          }

          @Injectable()
          class MethodInterceptor implements BunestInterceptor {
            async intercept(_ctx: ExecutionContext, next: CallHandler) {
              trace.push("interceptor:method:before");
              const res = await next.handle();
              trace.push("interceptor:method:after");
              return { intercepted: res };
            }
          }

          @Injectable()
          class AddSuffixPipe implements PipeTransform {
            transform(val: unknown) {
              trace.push("pipe:param");
              return `${String(val)}!`;
            }
          }

          @Catch(RpcException)
          class MethodRpcFilter implements ExceptionFilter<RpcException> {
            catch(exc: RpcException, _host: ArgumentsHost) {
              trace.push("filter:method");
              return { caught: exc.message };
            }
          }

          @Controller()
          class PipelineController {
            @UseGuards(MethodGuard)
            @UseInterceptors(MethodInterceptor)
            @MessagePattern("run")
            run(
              @Payload("text", AddSuffixPipe) text: string,
              @Ctx() ctx: RpcContext,
            ) {
              trace.push("handler");
              return `${text}@${ctx.pattern}`;
            }

            @UseFilters(MethodRpcFilter)
            @MessagePattern("fail")
            fail() {
              throw new RpcException("method-boom");
            }
          }

          const mod = await Test.createTestingModule({
            imports: [MicroserviceModule.forRoot({ server: memServer })],
            controllers: [PipelineController],
            providers: [
              GlobalGuard,
              MethodGuard,
              GlobalInterceptor,
              MethodInterceptor,
              AddSuffixPipe,
              MethodRpcFilter,
            ],
          }).compile();

          const host = mod.get(MicroserviceHost);
          host.useGlobalGuards(GlobalGuard);
          host.useGlobalInterceptors(GlobalInterceptor);
          await mod.init();

          const client = new InMemoryClientProxy({
            channel: "pipeline-order",
            broker,
          });

          try {
            const res = await client.send("run", { text: "ok", allow: true });
            expect(res).toEqual({ intercepted: "ok!@run" });
            expect(trace).toEqual([
              "guard:global",
              "guard:method",
              "interceptor:global:before",
              "interceptor:method:before",
              "pipe:param",
              "handler",
              "interceptor:method:after",
              "interceptor:global:after",
            ]);

            // Guard denial throws 403 RpcException
            try {
              await client.send("run", { text: "nope", allow: false });
              throw new Error("Expected forbidden");
            } catch (err) {
              expect(err).toBeInstanceOf(RpcException);
              expect((err as RpcException).getError()).toEqual({
                status: 403,
                message: "Forbidden resource",
              });
            }

            // Filter catches RpcException
            expect(await client.send("fail", {})).toEqual({
              caught: "method-boom",
            });
          } finally {
            await client.close();
            await mod.close();
          }
        },
        "11-stage Promise onion RPC pipeline",
      );
    });
  },
);
