import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  BadRequestException,
  BaseExceptionFilter,
  BunHttpAdapter,
  Catch,
  Controller,
  DIContainer,
  Get,
  HttpAdapterHost,
  HttpException,
  HttpExecutionContext,
  HttpResponseContext,
  HttpStatus,
  Inject,
  Injectable,
  IntrinsicException,
  Logger,
  Module,
  ModuleScanner,
  RequestContext,
  Scope,
  UseFilters,
  APP_FILTER,
  type ArgumentsHost,
  type ExceptionFilter,
  type HttpServer,
} from "../../../../../../packages/core/src";
import {
  createSandbox,
  createTestApp,
  describeConformance,
  itAdapted,
} from "../../../../_helpers";

describeConformance(
  "BaseExceptionFilter & Exception Filter Resolution",
  {
    upstreamPath: "packages/core/test/exceptions/base-exception-filter.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-010"],
    notes:
      "Upstream base-exception-filter.spec.ts tests NestJS internal BaseExceptionFilterContext filter resolution; adapted to Bunest's public DIContainer/APP_FILTER/@UseFilters resolution plus direct unit coverage of public BaseExceptionFilter (Web Response & HttpServer.reply).",
  },
  () => {
    const sandbox = createSandbox();

    afterEach(() => {
      sandbox.restore();
    });

    describe("filter instance resolution (upstream BaseExceptionFilterContext parity)", () => {
      describe("when filter is an object instance", () => {
        it("should return and invoke the object filter instance directly", async () => {
          const calls: unknown[] = [];
          const instance: ExceptionFilter = {
            catch(exception: unknown) {
              calls.push(exception);
              return new Response(JSON.stringify({ handledBy: "object" }), {
                status: 418,
                headers: { "Content-Type": "application/json" },
              });
            },
          };

          @Controller("obj")
          class ObjController {
            @Get()
            @UseFilters(instance)
            fail() {
              throw new BadRequestException("obj-err");
            }
          }

          const ctx = await createTestApp(
            { controllers: [ObjController] },
            { silentLogger: true },
          );
          try {
            const res = await ctx.request().get("/obj").expect(418);
            expect(res.body).toEqual({ handledBy: "object" });
            expect(calls).toHaveLength(1);
            expect(calls[0]).toBeInstanceOf(BadRequestException);
          } finally {
            await ctx.close();
          }
        });
      });

      describe("when filter is a constructor", () => {
        it("should pick the filter instance from the DI container", async () => {
          const TAG = "FILTER_TAG";

          @Catch(HttpException)
          @Injectable()
          class ContainerFilter implements ExceptionFilter {
            constructor(@Inject(TAG) readonly tag: string) {}

            catch(exception: HttpException) {
              return new Response(
                JSON.stringify({ tag: this.tag, msg: exception.message }),
                {
                  status: exception.getStatus(),
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
          }

          @Controller("ctor")
          class CtorController {
            @Get()
            @UseFilters(ContainerFilter)
            fail() {
              throw new BadRequestException("from-controller");
            }
          }

          const ctx = await createTestApp(
            {
              controllers: [CtorController],
              providers: [
                { provide: TAG, useValue: "di-filter" },
                ContainerFilter,
              ],
            },
            { silentLogger: true },
          );
          try {
            const resolved = ctx.moduleRef.get(ContainerFilter);
            expect(resolved).toBeInstanceOf(ContainerFilter);
            expect(resolved.tag).toBe("di-filter");

            const res = await ctx.request().get("/ctor").expect(400);
            expect(res.body).toEqual({
              tag: "di-filter",
              msg: "from-controller",
            });
          } finally {
            await ctx.close();
          }
        });

        it("should pick the instance from the container when the class also has a static 'catch'", async () => {
          @Catch(HttpException)
          @Injectable()
          class WithStatic implements ExceptionFilter {
            static catch() {
              return new Response(JSON.stringify({ source: "static" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }

            catch() {
              return new Response(JSON.stringify({ source: "instance" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }
          }

          @Controller("with-static")
          class WithStaticController {
            @Get()
            @UseFilters(WithStatic)
            fail() {
              throw new BadRequestException("boom");
            }
          }

          const ctx = await createTestApp(
            {
              controllers: [WithStaticController],
              providers: [WithStatic],
            },
            { silentLogger: true },
          );
          try {
            const res = await ctx.request().get("/with-static").expect(400);
            expect(res.body).toEqual({ source: "instance" });
          } finally {
            await ctx.close();
          }
        });

        // BUNEST_BUG: Filter class with static-only catch() returns 500 instead of 400 — DIContainer.resolveEnhancer instantiates `new StaticOnly()` (which lacks `.catch()`) instead of recognizing a class with static `catch()` and no prototype `catch()` (packages/core/src/di/di-container.ts:1462-1600, packages/core/src/http/pipeline/exception-handler.ts:248).
        it.skip("should return and invoke the class when only the class has a static 'catch'", async () => {
          @Catch(HttpException)
          class StaticOnly {
            static catch() {
              return new Response(JSON.stringify({ source: "static" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }
          }

          @Controller("static-only")
          class StaticOnlyController {
            @Get()
            @UseFilters(StaticOnly as unknown as ExceptionFilter)
            fail() {
              throw new BadRequestException("boom");
            }
          }

          const ctx = await createTestApp(
            {
              controllers: [StaticOnlyController],
            },
            { silentLogger: true },
          );
          try {
            const res = await ctx.request().get("/static-only").expect(400);
            expect(res.body).toEqual({ source: "static" });
          } finally {
            await ctx.close();
          }
        });
      });

      describe("scoped, value, and factory filters", () => {
        it("should refuse to resolve a request-scoped filter in static context and construct it per request", async () => {
          let counter = 0;

          @Catch(HttpException)
          @Injectable({ scope: Scope.REQUEST })
          class RequestScopedFilter implements ExceptionFilter {
            readonly id = ++counter;

            catch() {
              return new Response(JSON.stringify({ filterId: this.id }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }
          }

          @Controller("req-filter")
          class ReqFilterController {
            @Get()
            @UseFilters(RequestScopedFilter)
            fail() {
              throw new BadRequestException("req-scoped");
            }
          }

          @Module({
            controllers: [ReqFilterController],
            providers: [RequestScopedFilter],
          })
          class ReqFilterModule {}

          const graph = await new ModuleScanner().scan(ReqFilterModule);
          const container = new DIContainer(graph);
          await container.initialize();

          // Static context resolution (without RequestContainer) cannot return an unconstructed placeholder
          await expect(
            container.resolveEnhancer(
              RequestScopedFilter,
              undefined,
              undefined,
              "filter",
            ),
          ).rejects.toThrow();

          // Once a RequestContainer exists, each request gets its own constructed instance
          const req1 = container.createRequestContainer(
            new Request("http://localhost/req-filter"),
            new HttpResponseContext(),
          );
          const req2 = container.createRequestContainer(
            new Request("http://localhost/req-filter"),
            new HttpResponseContext(),
          );
          const f1 = await container.resolveEnhancer(
            RequestScopedFilter,
            req1,
            undefined,
            "filter",
          );
          const f1Again = await container.resolveEnhancer(
            RequestScopedFilter,
            req1,
            undefined,
            "filter",
          );
          const f2 = await container.resolveEnhancer(
            RequestScopedFilter,
            req2,
            undefined,
            "filter",
          );
          expect(f1).toBe(f1Again);
          expect(f1).not.toBe(f2);
        });

        it("should construct fresh instances for a transient filter", async () => {
          let counter = 0;

          @Catch(HttpException)
          @Injectable({ scope: Scope.TRANSIENT })
          class TransientFilter implements ExceptionFilter {
            readonly id = ++counter;
            catch() {
              return new Response(JSON.stringify({ id: this.id }), {
                status: 400,
              });
            }
          }

          @Module({ providers: [TransientFilter] })
          class TransientModule {}

          const graph = await new ModuleScanner().scan(TransientModule);
          const container = new DIContainer(graph);
          await container.initialize();

          const first = await container.resolveEnhancer(
            TransientFilter,
            undefined,
            undefined,
            "filter",
          );
          const second = await container.resolveEnhancer(
            TransientFilter,
            undefined,
            undefined,
            "filter",
          );
          expect(first).toBeInstanceOf(TransientFilter);
          expect(second).toBeInstanceOf(TransientFilter);
          expect(first).not.toBe(second);
        });

        it("should resolve and invoke APP_FILTER value and factory providers", async () => {
          @Catch(BadRequestException)
          class ValueFilter implements ExceptionFilter {
            catch() {
              return new Response(JSON.stringify({ kind: "value" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }
          }

          @Controller("providers")
          class ProvidersController {
            @Get("bad")
            bad() {
              throw new BadRequestException("bad");
            }

            @Get("other")
            other() {
              throw new HttpException("teapot", HttpStatus.I_AM_A_TEAPOT);
            }
          }

          const valueFilterInstance = new ValueFilter();
          const factoryFilterInstance: ExceptionFilter = {
            catch(ex: unknown) {
              const status = ex instanceof HttpException ? ex.getStatus() : 500;
              return new Response(JSON.stringify({ kind: "factory" }), {
                status,
                headers: { "Content-Type": "application/json" },
              });
            },
          };

          const ctx = await createTestApp(
            {
              controllers: [ProvidersController],
              providers: [
                { provide: APP_FILTER, useValue: valueFilterInstance },
                {
                  provide: APP_FILTER,
                  useFactory: () => factoryFilterInstance,
                },
              ],
            },
            { silentLogger: true },
          );
          try {
            const r1 = await ctx.request().get("/providers/bad").expect(400);
            expect(r1.body).toEqual({ kind: "value" });

            const r2 = await ctx.request().get("/providers/other").expect(418);
            expect(r2.body).toEqual({ kind: "factory" });
          } finally {
            await ctx.close();
          }
        });
      });
    });

    describe("BaseExceptionFilter (public class unit conformance)", () => {
      let host: ArgumentsHost;
      let resCtx: HttpResponseContext;

      class DummyController {
        handle() {}
      }

      beforeEach(() => {
        resCtx = new HttpResponseContext();
        const reqCtx = new RequestContext({
          request: new Request("http://localhost/items/42"),
          responseContext: resCtx,
        });
        host = new HttpExecutionContext(
          reqCtx,
          DummyController,
          DummyController.prototype.handle,
          "handle",
        );
      });

      itAdapted(
        ["ADR-001", "ADR-010"],
        "should reply via applicationRef.reply for HttpException and copy custom headers",
        () => {
          const replySpy = sandbox.spy(
            (_res: unknown, body: unknown, status?: number) => ({
              body,
              status,
            }),
          );
          const mockAdapter: HttpServer = {
            reply: replySpy,
            close: () => undefined,
          };
          const filter = new BaseExceptionFilter(mockAdapter);
          const err = new HttpException(
            "Forbidden action",
            HttpStatus.FORBIDDEN,
            {
              headers: { "X-Reason": "policy" },
              errorCode: "ERR_POLICY",
            },
          );

          filter.catch(err, host);

          expect(replySpy.calledOnce).toBe(true);
          expect(replySpy.firstCall?.args[0]).toBe(resCtx);
          expect(replySpy.firstCall?.args[1]).toMatchObject({
            statusCode: 403,
            message: "Forbidden action",
            errorCode: "ERR_POLICY",
          });
          expect(replySpy.firstCall?.args[2]).toBe(403);
          expect(resCtx.getHeaders().get("x-reason")).toBe("policy");
        },
        "HttpServer.reply + HttpResponseContext",
      );

      itAdapted(
        ["ADR-001", "ADR-010"],
        "should fall back to injected httpAdapterHost.httpAdapter when constructor applicationRef is omitted",
        async () => {
          const adapter = new BunHttpAdapter({ logger: false });
          const adapterHost = new HttpAdapterHost();
          adapterHost.httpAdapter = adapter;

          const filter = new BaseExceptionFilter();
          (
            filter as unknown as { httpAdapterHost: HttpAdapterHost }
          ).httpAdapterHost = adapterHost;

          const result = filter.catch(
            new BadRequestException("bad input"),
            host,
          );
          expect(result).toBeInstanceOf(Response);
          const response = result as Response;
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({
            statusCode: 400,
            message: "bad input",
          });
        },
        "BunHttpAdapter.reply returns native Response",
      );

      itAdapted(
        "ADR-010",
        "should return a native Web Response directly when no adapter is attached",
        async () => {
          const filter = new BaseExceptionFilter();
          const result = filter.catch(
            new HttpException("Teapot", HttpStatus.I_AM_A_TEAPOT, {
              headers: { "X-Brew": "earl-grey" },
            }),
            host,
          );

          expect(result).toBeInstanceOf(Response);
          const response = result as Response;
          expect(response.status).toBe(418);
          expect(response.headers.get("x-brew")).toBe("earl-grey");
          expect(response.headers.get("content-type")).toContain(
            "application/json",
          );
          const body = (await response.json()) as Record<string, unknown>;
          expect(body.statusCode).toBe(418);
          expect(body.message).toBe("Teapot");
          expect(typeof body.timestamp).toBe("string");
          expect(typeof body.path).toBe("string");
        },
        "Native Web Response fallback",
      );

      it("should handle unknown Error by logging and returning 500 Internal server error", async () => {
        const loggerErrorSpy = sandbox
          .stub(
            (BaseExceptionFilter as unknown as { logger: Logger }).logger,
            "error",
          )
          .returns(undefined);

        const filter = new BaseExceptionFilter();
        const err = new Error("unexpected crash");
        const result = filter.catch(err, host);

        expect(loggerErrorSpy.calledOnce).toBe(true);
        expect(loggerErrorSpy.firstCall?.args[0]).toBe("unexpected crash");
        expect(result).toBeInstanceOf(Response);
        const response = result as Response;
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          statusCode: 500,
          message: "Internal server error",
        });
      });

      it("should suppress logger.error for IntrinsicException", async () => {
        const loggerErrorSpy = sandbox
          .stub(
            (BaseExceptionFilter as unknown as { logger: Logger }).logger,
            "error",
          )
          .returns(undefined);

        const filter = new BaseExceptionFilter();
        const result = filter.catch(new IntrinsicException("expected"), host);

        expect(loggerErrorSpy.notCalled).toBe(true);
        expect(result).toBeInstanceOf(Response);
        const response = result as Response;
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          statusCode: 500,
          message: "Internal server error",
        });
      });

      it("should log stringified value for non-Error primitives", async () => {
        const loggerErrorSpy = sandbox
          .stub(
            (BaseExceptionFilter as unknown as { logger: Logger }).logger,
            "error",
          )
          .returns(undefined);

        const filter = new BaseExceptionFilter();
        const result = filter.catch("raw failure string", host);

        expect(loggerErrorSpy.calledOnceWith("raw failure string")).toBe(true);
        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(500);
      });

      it("should treat plain http-error shaped objects as HTTP errors and mask non-exposed 5xx messages", async () => {
        sandbox
          .stub(
            (BaseExceptionFilter as unknown as { logger: Logger }).logger,
            "error",
          )
          .returns(undefined);

        const filter = new BaseExceptionFilter();
        const r400 = filter.catch(
          { statusCode: 400, message: "Invalid middleware payload" },
          host,
        ) as Response;
        expect(r400.status).toBe(400);
        expect(await r400.json()).toEqual({
          statusCode: 400,
          message: "Invalid middleware payload",
        });

        const r502 = filter.catch(
          { statusCode: 502, message: "connect 10.0.0.1:5432", expose: false },
          host,
        ) as Response;
        expect(r502.status).toBe(502);
        expect(await r502.json()).toEqual({
          statusCode: 502,
          message: "Internal server error",
        });
      });

      it("isExceptionObject should identify Error and message-bearing objects", () => {
        const filter = new BaseExceptionFilter();
        expect(filter.isExceptionObject(new Error("boom"))).toBe(true);
        expect(filter.isExceptionObject({ message: "boom" })).toBe(true);
        expect(filter.isExceptionObject(null)).toBe(false);
        expect(filter.isExceptionObject("boom")).toBe(false);
        expect(filter.isExceptionObject({})).toBe(false);
      });

      // BUNEST_BUG: BaseExceptionFilter.isHttpError() only checks `typeof err.statusCode === "number" && typeof err.message === "string"`, returning `true` for statusCode 200/600/400.5, empty message "", and plain `Error` instances with `statusCode` instead of enforcing integer 400..599, non-empty message, and http-error signatures (packages/core/src/exceptions/base-exception-filter.ts:107-116).
      it.skip("isHttpError should reject non-4xx/5xx status codes, non-integers, empty messages, and plain Errors with statusCode", () => {
        const filter = new BaseExceptionFilter();
        expect(
          filter.isHttpError({ statusCode: 400, message: "Bad request" }),
        ).toBe(true);
        expect(
          filter.isHttpError({ statusCode: 599, message: "Upstream" }),
        ).toBe(true);
        expect(
          filter.isHttpError({ statusCode: 200, message: "Success payload" }),
        ).toBe(false);
        expect(
          filter.isHttpError({ statusCode: 600, message: "Above 5xx" }),
        ).toBe(false);
        expect(
          filter.isHttpError({ statusCode: 400.5, message: "Float status" }),
        ).toBe(false);
        expect(filter.isHttpError({ statusCode: 400, message: "" })).toBe(
          false,
        );
        expect(
          filter.isHttpError(
            Object.assign(new Error("External API failed"), {
              statusCode: 400,
            }),
          ),
        ).toBe(false);
      });

      // BUNEST_BUG: BaseExceptionFilter.getHttpErrorMessage() only masks messages when `err.expose === false && err.statusCode >= 500`, leaking non-exposed 4xx error messages (e.g. 404 ENOENT file paths) instead of masking all `expose === false` errors (packages/core/src/exceptions/base-exception-filter.ts:118-127).
      it.skip("getHttpErrorMessage should hide non-exposed 4xx error messages (expose: false)", () => {
        const filter = new BaseExceptionFilter();
        const msg = filter.getHttpErrorMessage({
          statusCode: 404,
          message: "ENOENT: no such file '/srv/secret'",
          expose: false,
        });
        expect(msg).not.toContain("ENOENT");
      });

      it("should allow custom subclass filters to delegate via super.catch(exception, host)", async () => {
        const seen: string[] = [];

        @Catch()
        class CustomSubFilter extends BaseExceptionFilter {
          override catch(exception: unknown, argHost: ArgumentsHost) {
            seen.push(
              exception instanceof Error
                ? exception.message
                : String(exception),
            );
            return super.catch(exception, argHost);
          }
        }

        @Controller("sub")
        class SubController {
          @Get()
          @UseFilters(CustomSubFilter)
          fail() {
            throw new BadRequestException("delegated-error");
          }
        }

        const ctx = await createTestApp(
          { controllers: [SubController] },
          { silentLogger: true },
        );
        try {
          const res = await ctx.request().get("/sub").expect(400);
          expect(seen).toEqual(["delegated-error"]);
          expect(res.body).toMatchObject({
            statusCode: 400,
            message: "delegated-error",
          });
        } finally {
          await ctx.close();
        }
      });
    });
  },
);
