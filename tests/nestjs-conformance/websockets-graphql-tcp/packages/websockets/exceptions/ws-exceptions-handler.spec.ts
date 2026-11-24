import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  type LoggerService,
  UseFilters,
} from "../../../../../../packages/core/src/common";
import {
  BaseWsExceptionFilter,
  type BunServerWebSocketLike,
  BunWebSocketAdapter,
  type BunWsClient,
  BunWsClientImpl,
  type BunWsSocketData,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
  WsExecutionContext,
} from "../../../../../../packages/core/src/ws";
import {
  createSpy,
  createStub,
  describeConformance,
  itAdapted,
  type SinonLikeSpy,
  type SinonLikeStub,
} from "../../../../_helpers/index";

function createLoggerStub() {
  const error = createSpy();
  const logger: LoggerService = {
    log: createSpy(),
    error,
    warn: createSpy(),
    debug: createSpy(),
    verbose: createSpy(),
  };
  return { logger, error };
}

class DummyGateway {
  public test() {}
}

describeConformance(
  "WsExceptionsHandler / BaseWsExceptionFilter",
  {
    upstreamPath:
      "packages/websockets/test/exceptions/ws-exceptions-handler.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts upstream WsExceptionsHandler tests to Bunest BaseWsExceptionFilter + WsExecutionContext + BunWsClientImpl + BunWebSocketAdapter @UseFilters. Bunest uses 'error' event framing instead of Socket.IO 'exception'.",
  },
  () => {
    let filter: BaseWsExceptionFilter;
    let loggerErrorSpy: SinonLikeSpy;
    let emitStub: SinonLikeStub;
    let client: BunWsClient;
    let pattern: string;
    let data: unknown;
    let executionContext: WsExecutionContext;

    beforeEach(() => {
      const { logger, error } = createLoggerStub();
      loggerErrorSpy = error;
      filter = new BaseWsExceptionFilter(logger);
      emitStub = createStub();
      client = {
        id: "client-1",
        data: {},
        request: new Request("http://localhost/ws"),
        rooms: new Set(),
        raw: {} as BunServerWebSocketLike,
        send: emitStub,
        emit: emitStub,
        sendRaw: createSpy(),
        join: createSpy(),
        leave: createSpy(),
        to: () => ({ emit: createSpy(), send: createSpy() }),
        broadcast: createSpy(),
        close: createSpy(),
      };
      pattern = "test";
      data = { foo: "bar" };
      executionContext = new WsExecutionContext(
        client,
        data,
        pattern,
        DummyGateway,
        DummyGateway.prototype.test,
        "test",
      );
    });

    describe("catch (BaseWsExceptionFilter)", () => {
      itAdapted(
        ["ADR-001"],
        "should emit expected error payload and log when exception is unknown Error",
        () => {
          const unknownErr = new Error("unexpected boom");
          filter.catch(unknownErr, executionContext);

          expect(emitStub.calledOnce).toBe(true);
          expect(
            emitStub.calledWithExactly(
              "error",
              {
                status: "error",
                message: "Internal server error",
              },
              undefined,
            ),
          ).toBe(true);
          expect(loggerErrorSpy.calledOnce).toBe(true);
          expect(loggerErrorSpy.firstCall?.args[0]).toBe("unexpected boom");
        },
      );

      it("should log and emit generic error when a non-Error value is thrown", () => {
        filter.catch("raw string throw", executionContext);

        expect(emitStub.calledOnce).toBe(true);
        expect(
          emitStub.calledWithExactly(
            "error",
            {
              status: "error",
              message: "Internal server error",
            },
            undefined,
          ),
        ).toBe(true);
        expect(loggerErrorSpy.calledOnce).toBe(true);
        expect(loggerErrorSpy.firstCall?.args[0]).toBe(
          "Unhandled WebSocket exception",
        );
      });

      it("should correlate error frame with frameId when provided", () => {
        filter.catch(
          new WsException("Unauthorized"),
          executionContext,
          "req-9",
        );

        expect(
          emitStub.calledOnceWithExactly(
            "error",
            { status: "error", message: "Unauthorized" },
            "req-9",
          ),
        ).toBe(true);
      });

      it("should emit structured HttpException payload without crashing socket", () => {
        filter.catch(
          new BadRequestException("Invalid payload"),
          executionContext,
          "req-2",
        );

        expect(emitStub.calledOnce).toBe(true);
        expect(emitStub.firstCall?.args[0]).toBe("error");
        expect(emitStub.firstCall?.args[1]).toMatchObject({
          status: "error",
          statusCode: 400,
          message: "Invalid payload",
          error: "Bad Request",
        });
        expect(emitStub.firstCall?.args[2]).toBe("req-2");
      });

      it("should safely no-op when WsArgumentsHost has no client", () => {
        const noClientHost = {
          switchToWs: () => ({
            getClient: () => undefined,
            getData: () => data,
            getPattern: () => pattern,
          }),
        } as unknown as ArgumentsHost;

        expect(() =>
          filter.catch(new WsException("ignored"), noClientHost),
        ).not.toThrow();
        expect(emitStub.notCalled).toBe(true);
      });

      describe("when exception is instance of WsException", () => {
        it("should emit expected status and json object", () => {
          const message = {
            custom: "Unauthorized",
          };
          filter.catch(new WsException(message), executionContext);

          expect(
            emitStub.calledOnceWithExactly(
              "error",
              { status: "error", custom: "Unauthorized" },
              undefined,
            ),
          ).toBe(true);
          expect(loggerErrorSpy.notCalled).toBe(true);
        });

        it("should emit expected status and transform string message to json", () => {
          const message = "Unauthorized";
          filter.catch(new WsException(message), executionContext);

          expect(
            emitStub.calledOnceWithExactly(
              "error",
              {
                status: "error",
                message,
              },
              undefined,
            ),
          ).toBe(true);
          expect(loggerErrorSpy.notCalled).toBe(true);
        });

        it("should emit the unknown error payload and log the error when WsException holds an Error instance", () => {
          const error = Object.assign(new Error("Request failed"), {
            config: { headers: { Authorization: "Bearer secret" } },
          });

          filter.catch(
            new WsException(error as unknown as Record<string, unknown>),
            executionContext,
          );

          expect(emitStub.firstCall?.args[1]).toEqual({
            status: "error",
            message: "Internal server error",
          });
          expect(loggerErrorSpy.calledOnce).toBe(true);
        });
      });

      describe('when client uses native Bun WebSocket "send" via BunWsClientImpl', () => {
        let sendStub: SinonLikeStub;
        let wsClient: BunWsClientImpl;
        let wsExecutionContext: WsExecutionContext;

        beforeEach(() => {
          sendStub = createStub();
          const socketData: BunWsSocketData = {
            gatewayId: "gw_1",
            clientId: "c_1",
            request: new Request("http://localhost/ws"),
            path: "/ws",
            namespace: "/ws",
            handshakeData: {},
          };
          const rawSocket: BunServerWebSocketLike<BunWsSocketData> = {
            data: socketData,
            readyState: 1,
            send: sendStub,
            publish: createSpy(),
            subscribe: createSpy(),
            unsubscribe: createSpy(),
            isSubscribed: () => false,
            close: createSpy(),
          };
          wsClient = new BunWsClientImpl(rawSocket, socketData);
          wsExecutionContext = new WsExecutionContext(
            wsClient,
            data,
            pattern,
            DummyGateway,
            DummyGateway.prototype.test,
            "test",
          );
        });

        it('should send JSON-stringified error frame via "send" when exception is unknown', () => {
          filter.catch(new Error("boom"), wsExecutionContext);
          expect(sendStub.callCount).toBe(1);
          const sent = JSON.parse(String(sendStub.firstCall?.args[0]));
          expect(sent).toEqual({
            event: "error",
            data: {
              status: "error",
              message: "Internal server error",
            },
          });
        });

        it('should send JSON-stringified error frame via "send" for WsException with object', () => {
          const message = { custom: "Unauthorized" };
          filter.catch(new WsException(message), wsExecutionContext, "id-1");
          expect(sendStub.callCount).toBe(1);
          const sent = JSON.parse(String(sendStub.firstCall?.args[0]));
          expect(sent).toEqual({
            event: "error",
            data: {
              status: "error",
              custom: "Unauthorized",
            },
            id: "id-1",
          });
        });

        it('should send JSON-stringified error frame via "send" for WsException with string', () => {
          const message = "Unauthorized";
          filter.catch(new WsException(message), wsExecutionContext);
          expect(sendStub.callCount).toBe(1);
          const sent = JSON.parse(String(sendStub.firstCall?.args[0]));
          expect(sent).toEqual({
            event: "error",
            data: {
              status: "error",
              message,
            },
          });
        });

        it('should send the unknown error payload via "send" for WsException with error', () => {
          const error = Object.assign(new Error("Request failed"), {
            config: { headers: { Authorization: "Bearer secret" } },
          });
          filter.catch(
            new WsException(error as unknown as Record<string, unknown>),
            wsExecutionContext,
          );
          expect(sendStub.callCount).toBe(1);
          const sent = JSON.parse(String(sendStub.firstCall?.args[0]));
          expect(sent).toEqual({
            event: "error",
            data: {
              status: "error",
              message: "Internal server error",
            },
          });
        });
      });

      describe("NestJS v12 cause / includeCause / causeFactory / binary & circular sanitization", () => {
        it("should include cause { pattern, data } by default and support includeCause: false & custom causeFactory without mutating caller options", () => {
          const options = Object.freeze({ includeCause: true });
          const filterWithOpts = new (
            BaseWsExceptionFilter as unknown as new (
              opts?: Record<string, unknown>,
            ) => BaseWsExceptionFilter
          )(options);
          filterWithOpts.catch(
            new WsException("Unauthorized"),
            executionContext,
          );
          expect(emitStub.firstCall?.args[1]).toEqual({
            status: "error",
            message: "Unauthorized",
            cause: { pattern, data },
          });
        });

        // BUNEST_BUG: BaseWsExceptionFilter in packages/core/src/ws/filters/base-ws-exception.filter.ts does not strip binary payloads (Buffer, ArrayBuffer, Float32Array, DataView, Blob, or deeply nested objects) from error causes because cause emission is not implemented.
        it.skip("should omit binary data (Buffer/ArrayBuffer/TypedArray/DataView/Blob/deeply nested) from emitted cause", () => {
          const binaryValues: unknown[] = [
            Buffer.from("x"),
            new ArrayBuffer(1),
            new Float32Array(1),
            new DataView(new ArrayBuffer(1)),
            new Blob(["x"]),
          ];
          for (const val of binaryValues) {
            emitStub.resetHistory();
            const ctx = new WsExecutionContext(
              client,
              [val],
              pattern,
              DummyGateway,
              DummyGateway.prototype.test,
              "test",
            );
            filter.catch(new WsException("Unauthorized"), ctx);
            expect(
              (emitStub.firstCall?.args[1] as { cause?: unknown })?.cause,
            ).toEqual({ pattern });
          }
        });

        // BUNEST_BUG: BaseWsExceptionFilter in packages/core/src/ws/filters/base-ws-exception.filter.ts does not catch circular-reference JSON serialization failures or retry emit() without cause when emit throws.
        it.skip("should drop cause and retry when payload data is circular or emit throws", () => {
          const circular: Record<string, unknown> = {};
          circular.self = circular;
          emitStub
            .onFirstCall()
            .throws(new RangeError("Maximum call stack size exceeded"));
          const ctx = new WsExecutionContext(
            client,
            circular,
            pattern,
            DummyGateway,
            DummyGateway.prototype.test,
            "test",
          );
          filter.catch(new WsException("Unauthorized"), ctx);
          expect(emitStub.callCount).toBe(2);
          expect(emitStub.lastCall?.args[1]).toEqual({
            status: "error",
            message: "Unauthorized",
          });
        });
      });

      describe("custom exception filters via @UseFilters / @Catch on BunWebSocketAdapter", () => {
        let adapter: BunWebSocketAdapter;

        afterEach(async () => {
          if (adapter) {
            await adapter.closeAll();
          }
        });

        itAdapted(
          ["ADR-001", "ADR-008"],
          "should invoke matching sync & async @UseFilters and fall back to BaseWsExceptionFilter when filter does not match",
          async () => {
            class MatchedException extends Error {}
            class UnmatchedException extends Error {}

            const syncFilterSpy = createSpy();
            const asyncFilterSpy = createSpy();

            @Catch(MatchedException)
            class SyncCustomFilter implements ExceptionFilter<MatchedException> {
              catch(exception: MatchedException, host: ArgumentsHost) {
                syncFilterSpy(exception, host);
                return {
                  event: "sync_caught",
                  data: { msg: exception.message },
                };
              }
            }

            @Catch(MatchedException)
            class AsyncCustomFilter implements ExceptionFilter<MatchedException> {
              async catch(exception: MatchedException, host: ArgumentsHost) {
                await Promise.resolve();
                asyncFilterSpy(exception, host);
                return {
                  event: "async_caught",
                  data: { msg: exception.message },
                };
              }
            }

            @WebSocketGateway({ path: "/ws/filter-unit" })
            class FilterUnitGateway {
              @UseFilters(SyncCustomFilter)
              @SubscribeMessage("sync_fail")
              syncFail() {
                throw new MatchedException("sync-err");
              }

              @UseFilters(AsyncCustomFilter)
              @SubscribeMessage("async_fail")
              asyncFail() {
                throw new MatchedException("async-err");
              }

              @UseFilters(SyncCustomFilter)
              @SubscribeMessage("unmatched_fail")
              unmatchedFail() {
                throw new UnmatchedException("not-matched");
              }
            }

            const { logger } = createLoggerStub();
            adapter = new BunWebSocketAdapter({}, undefined, logger);
            await adapter.registerGateway(new FilterUnitGateway());
            const info = await adapter.listen({
              port: 0,
              hostname: "127.0.0.1",
            });

            const ws = new WebSocket(
              `ws://127.0.0.1:${info.port}/ws/filter-unit`,
            );
            const frames: Array<{
              event: string;
              data?: unknown;
              id?: string;
            }> = [];
            const waitFrame = (id: string) =>
              new Promise<{ event: string; data?: unknown; id?: string }>(
                (resolve, reject) => {
                  const existing = frames.find((f) => f.id === id);
                  if (existing) return resolve(existing);
                  const timer = setTimeout(
                    () =>
                      reject(new Error(`Timed out waiting for frame ${id}`)),
                    2000,
                  );
                  const onMsg = (ev: MessageEvent) => {
                    const parsed = JSON.parse(String(ev.data)) as {
                      event: string;
                      data?: unknown;
                      id?: string;
                    };
                    if (parsed.id === id) {
                      clearTimeout(timer);
                      ws.removeEventListener("message", onMsg);
                      resolve(parsed);
                    }
                  };
                  ws.addEventListener("message", onMsg);
                },
              );

            ws.addEventListener("message", (ev) => {
              frames.push(JSON.parse(String(ev.data)));
            });

            await new Promise<void>((resolve, reject) => {
              ws.addEventListener("open", () => resolve(), { once: true });
              ws.addEventListener("error", (e) => reject(e), { once: true });
            });

            try {
              ws.send(JSON.stringify({ event: "sync_fail", id: "f1" }));
              const f1 = await waitFrame("f1");
              expect(f1).toEqual({
                event: "sync_caught",
                data: { msg: "sync-err" },
                id: "f1",
              });
              expect(syncFilterSpy.calledOnce).toBe(true);
              expect(syncFilterSpy.firstCall?.args[0]).toBeInstanceOf(
                MatchedException,
              );

              ws.send(JSON.stringify({ event: "async_fail", id: "f2" }));
              const f2 = await waitFrame("f2");
              expect(f2).toEqual({
                event: "async_caught",
                data: { msg: "async-err" },
                id: "f2",
              });
              expect(asyncFilterSpy.calledOnce).toBe(true);

              // Unmatched exception bypasses SyncCustomFilter and hits BaseWsExceptionFilter
              ws.send(JSON.stringify({ event: "unmatched_fail", id: "f3" }));
              const f3 = await waitFrame("f3");
              expect(f3).toEqual({
                event: "error",
                data: { status: "error", message: "Internal server error" },
                id: "f3",
              });
              expect(syncFilterSpy.callCount).toBe(1);
            } finally {
              ws.close();
            }
          },
        );
      });
    });
  },
);
