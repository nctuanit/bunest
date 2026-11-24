import { afterEach, describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Catch,
  ConflictException,
  Controller,
  ForbiddenException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  NotImplementedException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
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
  GRPC_METHOD_METADATA,
  GrpcClientProxy,
  GrpcContext,
  GrpcException,
  GrpcMetadata,
  GrpcMethod,
  GrpcServer,
  GrpcStatus,
  GrpcStreamCall,
  GrpcStreamMethod,
  MICROSERVICE_SERVER,
  MicroserviceModule,
  Payload,
  RpcException,
  Transport,
  decodeGrpcFrames,
  encodeGrpcFrame,
  parseGrpcTrailers,
  type GrpcCodec,
  type GrpcMethodMetadata,
} from "../../../../../../packages/microservices/src";
import { Test, describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "ServerGrpc (GrpcServer)",
  {
    upstreamPath: "packages/microservices/test/server/server-grpc.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapted from NestJS @grpc/grpc-js + RxJS ServerGrpc tests to Bunest native Bun.serve GrpcServer, GrpcContext, @GrpcMethod/@GrpcStreamMethod/@GrpcStreamCall decorators, and Promise/AsyncIterable RPC pipelines.",
  },
  () => {
    const servers: GrpcServer[] = [];
    const clients: GrpcClientProxy[] = [];

    afterEach(async () => {
      while (clients.length > 0) {
        await clients.pop()!.close();
      }
      while (servers.length > 0) {
        await servers.pop()!.close();
      }
    });

    async function createPair(
      serverOptions: {
        package?: string | readonly string[];
        codec?: GrpcCodec;
        maxMessageBytes?: number;
      } = {},
    ) {
      const server = new GrpcServer({
        host: "127.0.0.1",
        port: 0,
        ...serverOptions,
      });
      servers.push(server);
      await server.listen();
      const client = new GrpcClientProxy({
        url: server.url,
        package: serverOptions.package,
        codec: serverOptions.codec,
        maxMessageBytes: serverOptions.maxMessageBytes,
      });
      clients.push(client);
      return { server, client };
    }

    describe("listen & close lifecycle", () => {
      it("should bind ephemeral port on listen(), be idempotent, clear state on close(), and support re-listen()", async () => {
        const server = new GrpcServer({ host: "127.0.0.1", port: 0 });
        servers.push(server);

        expect(server.transport).toBe(Transport.GRPC);
        expect(server.isListening).toBe(false);
        expect(server.port).toBeUndefined();
        expect(server.url).toBeUndefined();
        expect(server.address).toBeNull();
        expect(server.unwrap()).toBe(server);

        await server.listen();
        const firstPort = server.port!;
        expect(server.isListening).toBe(true);
        expect(firstPort).toBeGreaterThan(0);
        expect(server.hostname).toBe("127.0.0.1");
        expect(server.url).toBe(`http://127.0.0.1:${firstPort}`);
        expect(server.address).toEqual({
          hostname: "127.0.0.1",
          port: firstPort,
        });

        // Second listen() is a no-op keeping same server
        await server.listen();
        expect(server.port).toBe(firstPort);

        await server.close();
        expect(server.isListening).toBe(false);
        expect(server.port).toBeUndefined();
        expect(server.url).toBeUndefined();
        expect(server.address).toBeNull();

        // Double close() is safe
        await server.close();
        expect(server.isListening).toBe(false);

        // Re-listening after close works cleanly
        await server.listen();
        expect(server.isListening).toBe(true);
        expect(server.port).toBeGreaterThan(0);
      });
    });

    describe("handler registration & route resolution", () => {
      it("should resolve exact, PascalCase fallback, single-package, multi-package, and nested namespace routes", async () => {
        const { server, client } = await createPair({
          package: ["pkg1", "pkg2"],
        });

        server.addGrpcHandler("UserService", "FindOne", (d) => ({
          src: "user",
          d,
        }));
        server.addGrpcHandler("orders.OrderService", "GetOrder", (d) => ({
          src: "order",
          d,
        }));
        server.addMessageHandler("/RawService/Ping", (d) => ({
          src: "raw-slash",
          d,
        }));
        server.addMessageHandler("DotService.Pong", (d) => ({
          src: "raw-dot",
          d,
        }));

        // Exact & lowercase->PascalCase fallback
        expect(await client.call("UserService", "FindOne", { id: 1 })).toEqual({
          src: "user",
          d: { id: 1 },
        });
        expect(await client.call("UserService", "findOne", { id: 2 })).toEqual({
          src: "user",
          d: { id: 2 },
        });

        // Multi-package qualified calls
        const cPkg2 = new GrpcClientProxy({ url: server.url, package: "pkg2" });
        clients.push(cPkg2);
        expect(await cPkg2.call("UserService", "FindOne", { id: 3 })).toEqual({
          src: "user",
          d: { id: 3 },
        });

        // Nested namespace service (dot in service name)
        const cNested = new GrpcClientProxy({ url: server.url });
        clients.push(cNested);
        expect(
          await cNested.call("orders.OrderService", "GetOrder", { id: 4 }),
        ).toEqual({
          src: "order",
          d: { id: 4 },
        });

        // addMessageHandler slash & dot formats
        expect(await cNested.call("RawService", "Ping", { id: 5 })).toEqual({
          src: "raw-slash",
          d: { id: 5 },
        });
        expect(await cNested.call("DotService", "Pong", { id: 6 })).toEqual({
          src: "raw-dot",
          d: { id: 6 },
        });
      });

      it("should throw on duplicate gRPC handler registration", () => {
        const server = new GrpcServer({ host: "127.0.0.1", port: 0 });
        server.addGrpcHandler("Dup", "Run", () => "a");
        expect(() => server.addGrpcHandler("Dup", "Run", () => "b")).toThrow(
          /Duplicate gRPC handler/,
        );
      });

      it("should return UNIMPLEMENTED for unknown methods and non-POST HTTP requests", async () => {
        const { server, client } = await createPair();
        server.addGrpcHandler("Only", "Exists", () => ({ ok: true }));

        // Unknown method
        let missingErr: unknown;
        try {
          await client.call("Only", "Unknown", {});
        } catch (err) {
          missingErr = err;
        }
        expect(missingErr).toBeInstanceOf(GrpcException);
        expect((missingErr as GrpcException).code).toBe(
          GrpcStatus.UNIMPLEMENTED,
        );

        // Non-POST request (GET)
        const getRes = await fetch(`${server.url}/Only/Exists`, {
          method: "GET",
        });
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get("grpc-status")).toBe(
          String(GrpcStatus.UNIMPLEMENTED),
        );
        expect(
          decodeURIComponent(getRes.headers.get("grpc-message")!),
        ).toContain("POST");
      });
    });

    describe("request framing & codec validation", () => {
      it("should pass undefined for empty 0-byte body, reject incomplete frames with INVALID_ARGUMENT, and reject oversized frames with RESOURCE_EXHAUSTED", async () => {
        const { server } = await createPair({ maxMessageBytes: 256 });
        server.addGrpcHandler("Frame", "Echo", (d) => ({
          gotUndefined: d === undefined,
          d,
        }));

        // 1. Empty 0-byte request body
        const emptyRes = await fetch(`${server.url}/Frame/Echo`, {
          method: "POST",
          headers: { "content-type": "application/grpc+json" },
          body: new Uint8Array(0),
        });
        expect(emptyRes.headers.get("grpc-status")).toBe("0");
        const emptyFrames = decodeGrpcFrames(
          new Uint8Array(await emptyRes.arrayBuffer()),
        );
        expect(
          JSON.parse(new TextDecoder().decode(emptyFrames[0]!.payload)),
        ).toEqual({ gotUndefined: true });

        // 2. Incomplete request frame (only 3 header bytes) -> INVALID_ARGUMENT
        const truncRes = await fetch(`${server.url}/Frame/Echo`, {
          method: "POST",
          headers: { "content-type": "application/grpc+json" },
          body: new Uint8Array([0, 0, 0]),
        });
        expect(truncRes.headers.get("grpc-status")).toBe(
          String(GrpcStatus.INVALID_ARGUMENT),
        );

        // 3. Invalid JSON body inside valid frame -> INVALID_ARGUMENT
        const badJsonRes = await fetch(`${server.url}/Frame/Echo`, {
          method: "POST",
          headers: { "content-type": "application/grpc+json" },
          body: encodeGrpcFrame(new TextEncoder().encode("{broken-json")),
        });
        expect(badJsonRes.headers.get("grpc-status")).toBe(
          String(GrpcStatus.INVALID_ARGUMENT),
        );

        // 4. Oversized frame exceeding maxMessageBytes -> RESOURCE_EXHAUSTED
        const bigRes = await fetch(`${server.url}/Frame/Echo`, {
          method: "POST",
          headers: { "content-type": "application/grpc+json" },
          body: encodeGrpcFrame(new Uint8Array(512)),
        });
        expect(bigRes.headers.get("grpc-status")).toBe(
          String(GrpcStatus.RESOURCE_EXHAUSTED),
        );
      });
    });

    describe("error mapping & security hardening", () => {
      it("should map HttpException, RpcException, GrpcException, Error, and non-Error throws to canonical GrpcStatus codes", async () => {
        const { server, client } = await createPair();

        const errorCases: Array<[string, () => never, GrpcStatus, string]> = [
          [
            "BadRequest",
            () => {
              throw new BadRequestException("bad input");
            },
            GrpcStatus.INVALID_ARGUMENT,
            "bad input",
          ],
          [
            "Unprocessable",
            () => {
              throw new UnprocessableEntityException("unprocessable");
            },
            GrpcStatus.INVALID_ARGUMENT,
            "unprocessable",
          ],
          [
            "Unauthorized",
            () => {
              throw new UnauthorizedException("no auth");
            },
            GrpcStatus.UNAUTHENTICATED,
            "no auth",
          ],
          [
            "Forbidden",
            () => {
              throw new ForbiddenException("denied");
            },
            GrpcStatus.PERMISSION_DENIED,
            "denied",
          ],
          [
            "NotFound",
            () => {
              throw new NotFoundException("missing");
            },
            GrpcStatus.NOT_FOUND,
            "missing",
          ],
          [
            "Conflict",
            () => {
              throw new ConflictException("dup");
            },
            GrpcStatus.ALREADY_EXISTS,
            "dup",
          ],
          [
            "TooMany",
            () => {
              throw new HttpException("rate limit", 429);
            },
            GrpcStatus.RESOURCE_EXHAUSTED,
            "rate limit",
          ],
          [
            "ClientClosed",
            () => {
              throw new HttpException("cancelled", 499);
            },
            GrpcStatus.CANCELLED,
            "cancelled",
          ],
          [
            "NotImpl",
            () => {
              throw new NotImplementedException("todo");
            },
            GrpcStatus.UNIMPLEMENTED,
            "todo",
          ],
          [
            "Unavailable",
            () => {
              throw new ServiceUnavailableException("down");
            },
            GrpcStatus.UNAVAILABLE,
            "down",
          ],
          [
            "Timeout",
            () => {
              throw new GatewayTimeoutException("slow");
            },
            GrpcStatus.DEADLINE_EXCEEDED,
            "slow",
          ],
          [
            "InternalHttp",
            () => {
              throw new InternalServerErrorException("boom");
            },
            GrpcStatus.INTERNAL,
            "boom",
          ],
          [
            "RpcCode",
            () => {
              throw new RpcException({
                code: GrpcStatus.FAILED_PRECONDITION,
                message: "precond",
              });
            },
            GrpcStatus.FAILED_PRECONDITION,
            "precond",
          ],
          [
            "RpcGrpcStatus",
            () => {
              throw new RpcException({
                status: GrpcStatus.ABORTED,
                message: "aborted",
              });
            },
            GrpcStatus.ABORTED,
            "aborted",
          ],
          [
            "RpcHttpStatus",
            () => {
              throw new RpcException({ status: 404, message: "rpc-404" });
            },
            GrpcStatus.NOT_FOUND,
            "rpc-404",
          ],
          [
            "RpcString",
            () => {
              throw new RpcException("plain rpc err");
            },
            GrpcStatus.UNKNOWN,
            "plain rpc err",
          ],
          [
            "GenericError",
            () => {
              throw new Error("well-formed 😀");
            },
            GrpcStatus.INTERNAL,
            "well-formed 😀",
          ],
          [
            "StringThrow",
            () => {
              throw "Forbidden resource";
            },
            GrpcStatus.INTERNAL,
            "Forbidden resource",
          ],
        ];

        for (const [name, fn] of errorCases) {
          server.addGrpcHandler("Errors", name, fn);
        }

        for (const [name, , expectedCode, expectedMsg] of errorCases) {
          let caught: unknown;
          try {
            await client.call("Errors", name, {});
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(GrpcException);
          expect((caught as GrpcException).code).toBe(expectedCode);
          expect((caught as GrpcException).message).toBe(expectedMsg);
        }
      });

      it("should merge responseMetadata and GrpcException.metadata while blocking reserved header & CRLF spoofing", async () => {
        const { server, client } = await createPair();
        server.addGrpcHandler("Sec", "MergeAndHarden", (_d, ctx) => {
          const gCtx = ctx as GrpcContext;
          gCtx.setResponseMetadata("x-from-ctx", "ctx-val");
          gCtx.setResponseMetadata("x-crlf", "safe\r\ngrpc-status: 0");
          gCtx.setResponseMetadata("grpc-status", "0");
          throw new GrpcException(
            GrpcStatus.PERMISSION_DENIED,
            "real-denied",
            new GrpcMetadata({ "x-from-err": "err-val" }),
          );
        });

        let caught: unknown;
        try {
          await client.call("Sec", "MergeAndHarden", {});
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(GrpcException);
        const gErr = caught as GrpcException;
        expect(gErr.code).toBe(GrpcStatus.PERMISSION_DENIED);
        expect(gErr.message).toBe("real-denied");
        expect(gErr.metadata?.get("x-from-ctx")).toBe("ctx-val");
        expect(gErr.metadata?.get("x-from-err")).toBe("err-val");
        expect(gErr.metadata?.get("x-crlf")).toBe("safe grpc-status: 0");
      });

      it("should sanitize lone UTF-16 surrogates in error messages instead of throwing URIError", async () => {
        const { server, client } = await createPair();
        server.addGrpcHandler("Surrogate", "Fail", () => {
          throw new GrpcException(
            GrpcStatus.INVALID_ARGUMENT,
            `Unexpected token '\ud83d', "😀" is not valid JSON`,
          );
        });

        let caught: unknown;
        try {
          await client.call("Surrogate", "Fail", {});
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(GrpcException);
        expect((caught as GrpcException).code).toBe(
          GrpcStatus.INVALID_ARGUMENT,
        );
        expect((caught as GrpcException).message).toBe(
          `Unexpected token '\ufffd', "😀" is not valid JSON`,
        );
      });
    });

    describe("server-streaming execution, ordering, deadline & cancellation", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "should write awaited async values in strict emission order and handle AsyncIterable on non-streaming routes",
        async () => {
          const { server, client } = await createPair();

          // Async generator with slow first item followed by fast items
          server.addGrpcStreamHandler("Order", "Seq", async function* () {
            await Bun.sleep(25);
            yield { n: 1 };
            yield { n: 2 };
            yield { n: 3 };
          });

          // Non-streaming route returning AsyncIterable automatically streams
          server.addGrpcHandler("Order", "AutoStream", async function* () {
            yield { auto: 1 };
            yield { auto: 2 };
          });

          // Streaming route returning a plain single value falls back to single frame
          server.addGrpcStreamHandler("Order", "SingleFallback", () => ({
            single: true,
          }));

          const ordered: Array<{ n: number }> = [];
          for await (const x of client.stream<{ n: number }>(
            "Order",
            "Seq",
            {},
          )) {
            ordered.push(x);
          }
          expect(ordered).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

          const autoOut: Array<{ auto: number }> = [];
          for await (const x of client.stream<{ auto: number }>(
            "Order",
            "AutoStream",
            {},
          )) {
            autoOut.push(x);
          }
          expect(autoOut).toEqual([{ auto: 1 }, { auto: 2 }]);

          const singleOut: Array<{ single: boolean }> = [];
          for await (const x of client.stream<{ single: boolean }>(
            "Order",
            "SingleFallback",
            {},
          )) {
            singleOut.push(x);
          }
          expect(singleOut).toEqual([{ single: true }]);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should flush prior streamed frames before emitting trailer error and run generator cleanup on deadline abort",
        async () => {
          const { server, client } = await createPair();
          let cleanupRan = false;

          server.addGrpcStreamHandler(
            "Stream",
            "PartialErr",
            async function* () {
              yield { n: 1 };
              yield { n: 2 };
              throw new GrpcException(GrpcStatus.NOT_FOUND, "Not found");
            },
          );

          server.addGrpcStreamHandler(
            "Stream",
            "SlowCancel",
            async function* (_d, ctx) {
              const signal = (ctx as GrpcContext).signal;
              try {
                yield { tick: 1 };
                await new Promise<void>((resolve) => {
                  const t = setTimeout(resolve, 1000);
                  signal.addEventListener(
                    "abort",
                    () => {
                      clearTimeout(t);
                      resolve();
                    },
                    { once: true },
                  );
                });
                if (!signal.aborted) {
                  yield { tick: 2 };
                }
              } finally {
                cleanupRan = true;
              }
            },
          );

          // Partial items delivered before error trailer
          const seen: number[] = [];
          let err1: unknown;
          try {
            for await (const item of client.stream<{ n: number }>(
              "Stream",
              "PartialErr",
              {},
            )) {
              seen.push(item.n);
            }
          } catch (err) {
            err1 = err;
          }
          expect(seen).toEqual([1, 2]);
          expect(err1).toBeInstanceOf(GrpcException);
          expect((err1 as GrpcException).code).toBe(GrpcStatus.NOT_FOUND);
          expect((err1 as GrpcException).message).toBe("Not found");

          // Deadline interrupts blocked stream promptly & invokes finally cleanup
          const t0 = performance.now();
          const ticks: number[] = [];
          let err2: unknown;
          try {
            for await (const item of client.stream<{ tick: number }>(
              "Stream",
              "SlowCancel",
              {},
              { timeoutMs: 45 },
            )) {
              ticks.push(item.tick);
            }
          } catch (err) {
            err2 = err;
          }
          expect(ticks).toEqual([1]);
          expect(err2).toBeInstanceOf(GrpcException);
          expect((err2 as GrpcException).code).toBe(
            GrpcStatus.DEADLINE_EXCEEDED,
          );
          expect(performance.now() - t0).toBeLessThan(350);
          await Bun.sleep(20);
          expect(cleanupRan).toBe(true);
        },
      );

      it("should abort unary handler ctx.signal and return DEADLINE_EXCEEDED when grpc-timeout expires", async () => {
        const { server } = await createPair();
        let abortedOnServer = false;
        server.addGrpcHandler("Deadline", "SlowUnary", async (_d, ctx) => {
          const signal = (ctx as GrpcContext).signal;
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 400);
            signal.addEventListener(
              "abort",
              () => {
                abortedOnServer = true;
                clearTimeout(t);
                resolve();
              },
              { once: true },
            );
          });
          return { done: true };
        });

        const rawRes = await fetch(`${server.url}/Deadline/SlowUnary`, {
          method: "POST",
          headers: {
            "content-type": "application/grpc+json",
            "grpc-timeout": "35m",
          },
          body: encodeGrpcFrame(new TextEncoder().encode("{}")),
        });
        expect(rawRes.headers.get("grpc-status")).toBe(
          String(GrpcStatus.DEADLINE_EXCEEDED),
        );
        await Bun.sleep(10);
        expect(abortedOnServer).toBe(true);
      });

      it("should encode response metadata in stream headers and trailing frame", async () => {
        const { server } = await createPair();
        server.addGrpcStreamHandler(
          "MetaStream",
          "Run",
          async function* (_d, ctx) {
            const gCtx = ctx as GrpcContext;
            gCtx.setResponseMetadata("x-stream-meta", "yes");
            yield { step: 1 };
          },
        );

        const res = await fetch(`${server.url}/MetaStream/Run`, {
          method: "POST",
          headers: { "content-type": "application/grpc+json" },
          body: encodeGrpcFrame(new TextEncoder().encode("{}")),
        });
        const frames = decodeGrpcFrames(
          new Uint8Array(await res.arrayBuffer()),
        );
        expect(frames).toHaveLength(2);
        expect(frames[0]!.isTrailer).toBe(false);
        expect(frames[1]!.isTrailer).toBe(true);
        expect(parseGrpcTrailers(frames[1]!.payload)).toMatchObject({
          "grpc-status": "0",
          "x-stream-meta": "yes",
        });
      });
    });

    describe("decorators, inheritance safety & MicroserviceHost pipeline", () => {
      it("should store copy-on-write inheritance-safe @GrpcMethod / @GrpcStreamMethod / @GrpcStreamCall metadata", () => {
        class BaseController {
          @GrpcMethod("BaseSvc")
          findBase() {
            return {};
          }
        }
        class ChildController extends BaseController {
          @GrpcStreamMethod("ChildSvc", "Watch")
          async *watchChild() {
            yield {};
          }

          @GrpcStreamCall("ChildSvc")
          streamCall() {
            return {};
          }
        }

        const baseMeta = Reflect.getOwnMetadata(
          GRPC_METHOD_METADATA,
          BaseController,
        ) as GrpcMethodMetadata[];
        const childMeta = Reflect.getOwnMetadata(
          GRPC_METHOD_METADATA,
          ChildController,
        ) as GrpcMethodMetadata[];

        expect(baseMeta).toEqual([
          {
            methodName: "findBase",
            service: "BaseSvc",
            method: "FindBase",
            streaming: false,
          },
        ]);
        expect(childMeta).toEqual([
          {
            methodName: "watchChild",
            service: "ChildSvc",
            method: "Watch",
            streaming: true,
          },
          {
            methodName: "streamCall",
            service: "ChildSvc",
            method: "StreamCall",
            streaming: true,
          },
        ]);
      });

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should run full RPC guards, pipes, Promise interceptors, and exception filters on @GrpcMethod handlers",
        async () => {
          @Injectable()
          class RoleGuard implements CanActivate {
            canActivate(ctx: ExecutionContext): boolean {
              const gCtx = ctx.switchToRpc().getContext<GrpcContext>();
              return gCtx.getMetadata().get("x-role") === "admin";
            }
          }

          @Injectable()
          class TrimPipe implements PipeTransform {
            transform(value: unknown): unknown {
              return typeof value === "string"
                ? value.trim().toUpperCase()
                : value;
            }
          }

          @Injectable()
          class WrapInterceptor implements BunestInterceptor {
            async intercept(
              _ctx: ExecutionContext,
              next: CallHandler,
            ): Promise<unknown> {
              const res = await next.handle();
              return { wrapped: true, data: res };
            }
          }

          @Catch(RpcException)
          class RecoverFilter implements ExceptionFilter {
            catch(exception: RpcException, _host: ArgumentsHost): unknown {
              if (exception.message === "recoverable") {
                return { recovered: true };
              }
              throw exception;
            }
          }

          @Controller()
          @UseFilters(RecoverFilter)
          class PipelineGrpcController {
            @UseGuards(RoleGuard)
            @UseInterceptors(WrapInterceptor)
            @GrpcMethod("PipeSvc")
            greet(
              @Payload("name", TrimPipe) name: string,
              @Ctx() ctx: GrpcContext,
            ) {
              return { name, path: ctx.path };
            }

            @GrpcMethod("PipeSvc")
            maybeFail(@Payload() data: { recover: boolean }) {
              throw new RpcException(data.recover ? "recoverable" : "fatal");
            }
          }

          const mod = await Test.createTestingModule({
            imports: [
              MicroserviceModule.forRoot({
                transport: Transport.GRPC,
                options: { host: "127.0.0.1", port: 0 },
              }),
            ],
            controllers: [PipelineGrpcController],
            providers: [RoleGuard, TrimPipe, WrapInterceptor, RecoverFilter],
          }).compile();
          await mod.init();

          try {
            const boundServer = mod.get<GrpcServer>(MICROSERVICE_SERVER);
            const client = new GrpcClientProxy({ url: boundServer.url });
            clients.push(client);

            // Guard passes + pipe transforms @Payload("name") + interceptor wraps
            const ok = await client.call(
              "PipeSvc",
              "Greet",
              { name: "  alice  " },
              { metadata: { "x-role": "admin" } },
            );
            expect(ok).toEqual({
              wrapped: true,
              data: { name: "ALICE", path: "/PipeSvc/Greet" },
            });

            // Guard denies -> 403 RpcException -> PERMISSION_DENIED
            let deniedErr: unknown;
            try {
              await client.call("PipeSvc", "Greet", { name: "bob" });
            } catch (err) {
              deniedErr = err;
            }
            expect(deniedErr).toBeInstanceOf(GrpcException);
            expect((deniedErr as GrpcException).code).toBe(
              GrpcStatus.PERMISSION_DENIED,
            );

            // Filter recovers matching RpcException
            expect(
              await client.call("PipeSvc", "MaybeFail", { recover: true }),
            ).toEqual({ recovered: true });

            // Filter rethrows non-recoverable RpcException -> GrpcStatus.UNKNOWN
            let fatalErr: unknown;
            try {
              await client.call("PipeSvc", "MaybeFail", { recover: false });
            } catch (err) {
              fatalErr = err;
            }
            expect(fatalErr).toBeInstanceOf(GrpcException);
            expect((fatalErr as GrpcException).code).toBe(GrpcStatus.UNKNOWN);
            expect((fatalErr as GrpcException).message).toBe("fatal");
          } finally {
            await mod.close();
          }
        },
      );
    });

    describe("unimplemented NestJS ServerGrpc parity checks", () => {
      it("should invoke preRequestHook on incoming gRPC calls", async () => {
        const { server, client } = await createPair();
        const called: string[] = [];
        server.setPreRequestHook(({ pattern }) => {
          called.push(pattern);
        });
        server.addGrpcHandler("HookSvc", "Ping", () => ({ ok: true }));

        await client.call("HookSvc", "Ping", {});
        expect(called).toEqual(["/HookSvc/Ping"]);
      });

      it("should honor gracefulShutdown and bounded gracePeriod before force-closing active calls", async () => {
        const server = new GrpcServer({
          host: "127.0.0.1",
          port: 0,
          ...({ gracefulShutdown: true, gracePeriod: 200 } as Record<
            string,
            unknown
          >),
        });
        servers.push(server);
        await server.listen();
        await server.close();
        expect(server.isListening).toBe(false);
      });
    });
  },
);
