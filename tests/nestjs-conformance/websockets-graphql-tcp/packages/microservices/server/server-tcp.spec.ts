import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "bun";
import {
  Controller,
  HttpException,
  Injectable,
  UseInterceptors,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "../../../../../../packages/core/src/common";
import {
  Ctx,
  EventPattern,
  FrameDecoder,
  MessagePattern,
  MicroserviceModule,
  Payload,
  RpcException,
  TcpClientProxy,
  TcpServer,
  Transport,
  encodeFrame,
  type RpcContext,
  type RpcEventEnvelope,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
} from "../../../../../../packages/microservices/src";
import { Test } from "../../../../../../packages/testing/src";
import {
  createSpy,
  describeConformance,
  expectCalledOnce,
  expectNotCalled,
  itAdapted,
} from "../../../../_helpers";

const createDeeplyNestedObject = (depth: number): Record<string, unknown> => {
  let pattern: Record<string, unknown> = {};
  for (let i = 0; i < depth; i++) {
    pattern = { nested: pattern };
  }
  return pattern;
};

describeConformance(
  "TcpServer (ServerTCP)",
  {
    upstreamPath: "packages/microservices/test/server/server-tcp.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Ports ServerTCP listen/close, socket tracking, handleMessage/handleEvent wire framing, peer disconnect resilience, interceptors, and maxFrameBytes to Bunest native Bun.listen TcpServer (ephemeral port: 0).",
  },
  () => {
    const servers: TcpServer[] = [];
    const clients: TcpClientProxy[] = [];
    const rawSockets: Array<Socket<unknown>> = [];

    afterEach(async () => {
      while (rawSockets.length > 0) {
        try {
          rawSockets.pop()!.end();
        } catch {
          // Ignore already-closed raw sockets
        }
      }
      while (clients.length > 0) {
        await clients.pop()!.close();
      }
      while (servers.length > 0) {
        await servers.pop()!.close();
      }
    });

    async function createListeningServer(
      options: { host?: string; port?: number; maxFrameBytes?: number } = {},
    ): Promise<TcpServer> {
      const server = new TcpServer({
        host: options.host ?? "127.0.0.1",
        port: options.port ?? 0,
        maxFrameBytes: options.maxFrameBytes,
      });
      servers.push(server);
      await server.listen();
      return server;
    }

    async function connectRaw(port: number): Promise<{
      socket: Socket<undefined>;
      responses: RpcResponseEnvelope[];
      closed: Promise<void>;
      waitForResponses: (count: number) => Promise<RpcResponseEnvelope[]>;
    }> {
      const decoder = new FrameDecoder();
      const responses: RpcResponseEnvelope[] = [];
      const waiters: Array<{
        count: number;
        resolve: (list: RpcResponseEnvelope[]) => void;
      }> = [];
      let resolveClosed!: () => void;
      const closed = new Promise<void>((res) => {
        resolveClosed = res;
      });

      const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          data(_sock, chunk) {
            const decoded = decoder.push<RpcResponseEnvelope>(chunk);
            responses.push(...decoded);
            for (let i = waiters.length - 1; i >= 0; i--) {
              const w = waiters[i]!;
              if (responses.length >= w.count) {
                waiters.splice(i, 1);
                w.resolve([...responses]);
              }
            }
          },
          close() {
            resolveClosed();
          },
          error() {
            resolveClosed();
          },
        },
      });
      rawSockets.push(socket);

      const waitForResponses = (count: number) => {
        if (responses.length >= count) {
          return Promise.resolve([...responses]);
        }
        return new Promise<RpcResponseEnvelope[]>((resolve) => {
          waiters.push({ count, resolve });
        });
      };

      return { socket, responses, closed, waitForResponses };
    }

    describe("listen & defaults", () => {
      it("should default host to 127.0.0.1, requestedPort to 0, and expose address/port after listen()", async () => {
        const server = new TcpServer();
        servers.push(server);

        expect(server.transport).toBe(Transport.TCP);
        expect(server.isListening).toBe(false);
        expect(server.address).toBeNull();
        expect(server.port).toBeUndefined();

        await server.listen();

        expect(server.isListening).toBe(true);
        expect(server.port).toBeGreaterThan(0);
        expect(server.address).toEqual({
          hostname: "127.0.0.1",
          port: server.port!,
        });
      });

      it("should default host to 127.0.0.1 when host is undefined or null", async () => {
        for (const host of [undefined, null]) {
          const server = new TcpServer({
            host: host as unknown as string,
            port: 0,
          });
          servers.push(server);
          await server.listen();
          expect(server.address?.hostname).toBe("127.0.0.1");
        }
      });

      it("should be idempotent when listen() is called while already listening", async () => {
        const server = await createListeningServer();
        const firstPort = server.port;

        await server.listen();

        expect(server.isListening).toBe(true);
        expect(server.port).toBe(firstPort);
      });

      it("should throw EADDRINUSE when binding to a port already occupied by another server", async () => {
        const first = await createListeningServer();
        const second = new TcpServer({
          host: "127.0.0.1",
          port: first.port!,
        });
        servers.push(second);

        await expect(second.listen()).rejects.toThrow();
        expect(second.isListening).toBe(false);
      });

      it("should allow re-listening after close()", async () => {
        const server = await createListeningServer();
        expect(server.isListening).toBe(true);

        await server.close();
        expect(server.isListening).toBe(false);
        expect(server.address).toBeNull();
        expect(server.port).toBeUndefined();

        await server.listen();
        expect(server.isListening).toBe(true);
        expect(server.port).toBeGreaterThan(0);
      });
    });

    describe("socket tracking & close", () => {
      it("should track connected client sockets, forget them on close, and close remaining sockets on server.close()", async () => {
        const server = await createListeningServer();
        const internalClients = (server as unknown as { clients: Set<unknown> })
          .clients;

        const conn1 = await connectRaw(server.port!);
        const conn2 = await connectRaw(server.port!);
        await Bun.sleep(20);
        expect(internalClients.size).toBe(2);

        // Closing conn1 removes only conn1
        conn1.socket.end();
        await conn1.closed;
        await Bun.sleep(20);
        expect(internalClients.size).toBe(1);

        // server.close() shuts down conn2 and clears all tracked sockets
        await server.close();
        await conn2.closed;
        expect(internalClients.size).toBe(0);
        expect(server.isListening).toBe(false);
        expect(server.address).toBeNull();
      });

      it("should be safe to call close() before listen() or multiple times", async () => {
        const server = new TcpServer({ port: 0 });
        servers.push(server);

        await expect(server.close()).resolves.toBeUndefined();
        await server.listen();
        await expect(server.close()).resolves.toBeUndefined();
        await expect(server.close()).resolves.toBeUndefined();
      });
    });

    describe("handleEnvelope (requests & events over TCP)", () => {
      it("should send 404 RpcException error when no message handler exists for pattern", async () => {
        const server = await createListeningServer();
        const conn = await connectRaw(server.port!);

        conn.socket.write(
          encodeFrame({
            type: "request",
            id: "req-404",
            pattern: "unknown.pattern",
            data: "tests",
          } satisfies RpcRequestEnvelope),
        );

        const [reply] = await conn.waitForResponses(1);
        expect(reply).toEqual({
          type: "response",
          id: "req-404",
          response: undefined,
          error: {
            status: 404,
            name: "RpcException",
            message:
              'No @MessagePattern() handler found for pattern "unknown.pattern".',
            details: {
              status: 404,
              message:
                'No @MessagePattern() handler found for pattern "unknown.pattern".',
            },
            isRpcException: true,
          },
          isDisposed: true,
        });
      });

      it("should call matching handler, return response, and expose remoteAddress in RpcContext metadata", async () => {
        const server = await createListeningServer();
        let capturedCtx: RpcContext | undefined;

        server.addMessageHandler("test", (data, ctx) => {
          capturedCtx = ctx;
          return { echo: data };
        });

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        const res = await client.send("test", "hello-tcp");
        expect(res).toEqual({ echo: "hello-tcp" });
        expect(capturedCtx?.transport).toBe(Transport.TCP);
        expect(capturedCtx?.pattern).toBe("test");
        expect(typeof capturedCtx?.metadata?.remoteAddress).toBe("string");
      });

      it("should call the handler of a string pattern that reads as JSON (e.g. '1.0', 'true', 'null')", async () => {
        const server = await createListeningServer();
        server.addMessageHandler("1.0", (d) => `v1:${String(d)}`);
        server.addMessageHandler("true", () => "bool-str");
        server.addMessageHandler("null", () => "null-str");

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        expect(await client.send("1.0", "ok")).toBe("v1:ok");
        expect(await client.send("true", null)).toBe("bool-str");
        expect(await client.send("null", null)).toBe("null-str");
      });

      it("should match canonical object patterns regardless of key order over TCP", async () => {
        const server = await createListeningServer();
        server.addMessageHandler({ cmd: "sum", version: 2 }, (nums: unknown) =>
          (nums as number[]).reduce((a, b) => a + b, 0),
        );

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        expect(
          await client.send<number>({ version: 2, cmd: "sum" }, [5, 10, 15]),
        ).toBe(30);
      });

      it("should serialize HttpException, RpcException, and plain Error thrown by TCP handlers", async () => {
        const server = await createListeningServer();
        server.addMessageHandler("http-err", () => {
          throw new HttpException("bad gateway", 502);
        });
        server.addMessageHandler("rpc-err", () => {
          throw new RpcException({ status: 400, message: "bad rpc" });
        });
        server.addMessageHandler("plain-err", () => {
          throw new Error("internal crash");
        });

        const conn = await connectRaw(server.port!);
        conn.socket.write(
          Buffer.concat([
            encodeFrame({
              type: "request",
              id: "1",
              pattern: "http-err",
              data: null,
            } satisfies RpcRequestEnvelope),
            encodeFrame({
              type: "request",
              id: "2",
              pattern: "rpc-err",
              data: null,
            } satisfies RpcRequestEnvelope),
            encodeFrame({
              type: "request",
              id: "3",
              pattern: "plain-err",
              data: null,
            } satisfies RpcRequestEnvelope),
          ]),
        );

        const replies = await conn.waitForResponses(3);
        const byId = new Map(replies.map((r) => [r.id, r]));

        expect(byId.get("1")?.error?.status).toBe(502);
        expect(byId.get("1")?.error?.isRpcException).toBe(true);
        expect(byId.get("2")?.error?.status).toBe(400);
        expect(byId.get("2")?.error?.isRpcException).toBe(true);
        expect(byId.get("3")?.error?.message).toBe("internal crash");
        expect(byId.get("3")?.error?.isRpcException).toBe(false);
      });

      it("should NOT reply to request envelopes using an @EventPattern handler", async () => {
        const server = await createListeningServer();
        const eventSpy = createSpy(() => "stored");
        server.addEventHandler("only-evt", eventSpy);

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        await expect(client.send("only-evt", {})).rejects.toBeInstanceOf(
          RpcException,
        );
        expectNotCalled(eventSpy);
      });

      it("should dispatch event envelopes to all registered event handlers without writing any response frame", async () => {
        const server = await createListeningServer();
        const received: Array<{
          handler: string;
          data: unknown;
          pattern: string;
        }> = [];
        let resolveDone!: () => void;
        const done = new Promise<void>((res) => {
          resolveDone = res;
        });

        server.addEventHandler("evt.chan", (data, ctx) => {
          received.push({ handler: "h1", data, pattern: ctx.pattern });
        });
        server.addEventHandler("evt.chan", (data, ctx) => {
          received.push({ handler: "h2", data, pattern: ctx.pattern });
          resolveDone();
        });

        const conn = await connectRaw(server.port!);
        conn.socket.write(
          encodeFrame({
            type: "event",
            pattern: "evt.chan",
            data: { k: "v" },
          } satisfies RpcEventEnvelope),
        );

        await done;
        await Bun.sleep(20);

        expect(received).toEqual([
          { handler: "h1", data: { k: "v" }, pattern: "evt.chan" },
          { handler: "h2", data: { k: "v" }, pattern: "evt.chan" },
        ]);
        // Fire-and-forget events must produce zero response frames
        expect(conn.responses).toHaveLength(0);
      });

      it("should ignore unsolicited response envelopes sent to the server", async () => {
        const server = await createListeningServer();
        server.addMessageHandler("ping", () => "pong");

        const conn = await connectRaw(server.port!);
        conn.socket.write(
          Buffer.concat([
            encodeFrame({
              type: "response",
              id: "bogus",
              response: "ignored",
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            encodeFrame({
              type: "request",
              id: "real-1",
              pattern: "ping",
              data: null,
            } satisfies RpcRequestEnvelope),
          ]),
        );

        const [reply] = await conn.waitForResponses(1);
        expect(reply?.id).toBe("real-1");
        expect(reply?.response).toBe("pong");
      });

      it("should run setPreRequestHook on incoming TCP requests and reject when hook throws", async () => {
        const server = await createListeningServer();
        const handler = createSpy(() => "ok");
        server.addMessageHandler("guarded", handler);
        server.setPreRequestHook(({ data }) => {
          if ((data as { auth?: boolean })?.auth !== true) {
            throw new RpcException({ status: 401, message: "missing auth" });
          }
        });

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        await expect(client.send("guarded", { auth: false })).rejects.toThrow(
          "missing auth",
        );
        expectNotCalled(handler);

        expect(await client.send("guarded", { auth: true })).toBe("ok");
        expectCalledOnce(handler);
      });
    });

    describe("when the peer disconnects mid-request & with interceptors", () => {
      it("should not crash when a client disconnects before an async handler completes", async () => {
        const server = await createListeningServer();
        let resolveHandler!: (val: string) => void;
        let handlerFinished = false;

        server.addMessageHandler("slow", async () => {
          const val = await new Promise<string>((res) => {
            resolveHandler = res;
          });
          handlerFinished = true;
          return val;
        });
        server.addMessageHandler("health", () => "alive");

        const conn = await connectRaw(server.port!);
        conn.socket.write(
          encodeFrame({
            type: "request",
            id: "r1",
            pattern: "slow",
            data: null,
          } satisfies RpcRequestEnvelope),
        );
        await Bun.sleep(15);

        // Peer disconnects while handler is still pending
        conn.socket.end();
        await conn.closed;
        await Bun.sleep(15);

        // Now complete the handler — server should skip writing to the closed socket cleanly
        resolveHandler("done");
        await Bun.sleep(15);
        expect(handlerFinished).toBe(true);

        // Server remains healthy for new connections
        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);
        expect(await client.send("health", {})).toBe("alive");
      });

      itAdapted(
        "ADR-008",
        "should let an RPC interceptor finish its post-handler work when the handler resolves after peer disconnect",
        async () => {
          const interceptorWork = createSpy((_val: unknown) => {});
          let resolveValue!: (val: string) => void;
          let resolveDone!: () => void;
          const interceptorDone = new Promise<void>((res) => {
            resolveDone = res;
          });

          @Injectable()
          class TapInterceptor implements BunestInterceptor {
            async intercept(_ctx: ExecutionContext, next: CallHandler) {
              const value = await next.handle();
              interceptorWork(value);
              resolveDone();
              return value;
            }
          }

          @Controller()
          class SlowRpcController {
            @UseInterceptors(TapInterceptor)
            @MessagePattern("slow-tap")
            handle() {
              return new Promise<string>((res) => {
                resolveValue = res;
              });
            }

            @EventPattern("bg-evt")
            onBgEvent(@Payload() data: unknown, @Ctx() _ctx: RpcContext) {
              return data;
            }
          }

          const tcpServer = new TcpServer({ host: "127.0.0.1", port: 0 });
          const mod = await Test.createTestingModule({
            imports: [MicroserviceModule.forRoot({ server: tcpServer })],
            controllers: [SlowRpcController],
            providers: [TapInterceptor],
          }).compile();
          await mod.init();

          try {
            const conn = await connectRaw(tcpServer.port!);
            conn.socket.write(
              encodeFrame({
                type: "request",
                id: "tap-1",
                pattern: "slow-tap",
                data: null,
              } satisfies RpcRequestEnvelope),
            );
            await Bun.sleep(20);

            conn.socket.end();
            await conn.closed;

            resolveValue("value");
            await interceptorDone;

            expectCalledOnce(interceptorWork);
            expect(interceptorWork.firstCall?.args).toEqual(["value"]);
          } finally {
            await mod.close();
          }
        },
        "Promise onion interceptor instead of RxJS tap()",
      );
    });

    describe("maxFrameBytes & framing resilience", () => {
      it("should accept frames up to custom maxFrameBytes and reject larger frames while keeping server alive", async () => {
        const server = await createListeningServer({ maxFrameBytes: 2048 });
        server.addMessageHandler("echo", (d) => d);

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        // Within 2048-byte frame budget
        expect(await client.send("echo", "a".repeat(1000))).toBe(
          "a".repeat(1000),
        );

        // Separate raw connection sends an oversized frame (> 2048 bytes)
        const badConn = await connectRaw(server.port!);
        badConn.socket.write(
          encodeFrame({
            type: "request",
            id: "too-big",
            pattern: "echo",
            data: "b".repeat(3000),
          } satisfies RpcRequestEnvelope),
        );
        await badConn.closed;

        expect(badConn.responses).toHaveLength(1);
        expect(badConn.responses[0]?.error?.message).toMatch(/exceeds limit/);

        // Existing healthy client continues working unaffected
        expect(await client.send("echo", "still-working")).toBe(
          "still-working",
        );
      });

      it("should reassemble fragmented TCP frames and handle coalesced frames from multiple clients independently", async () => {
        const server = await createListeningServer();
        server.addMessageHandler("upper", (d: unknown) =>
          String(d).toUpperCase(),
        );

        const connA = await connectRaw(server.port!);
        const connB = await connectRaw(server.port!);

        // connA sends a frame split byte-by-byte across chunks
        const frameA = encodeFrame({
          type: "request",
          id: "a1",
          pattern: "upper",
          data: "frag",
        } satisfies RpcRequestEnvelope);
        for (let i = 0; i < frameA.byteLength; i++) {
          connA.socket.write(frameA.subarray(i, i + 1));
        }

        // connB sends 3 coalesced frames in a single write
        connB.socket.write(
          Buffer.concat([
            encodeFrame({
              type: "request",
              id: "b1",
              pattern: "upper",
              data: "one",
            } satisfies RpcRequestEnvelope),
            encodeFrame({
              type: "request",
              id: "b2",
              pattern: "upper",
              data: "two",
            } satisfies RpcRequestEnvelope),
            encodeFrame({
              type: "request",
              id: "b3",
              pattern: "upper",
              data: "three",
            } satisfies RpcRequestEnvelope),
          ]),
        );

        const [resA, resB] = await Promise.all([
          connA.waitForResponses(1),
          connB.waitForResponses(3),
        ]);

        expect(resA[0]?.response).toBe("FRAG");
        expect(resB.map((r) => r.response)).toEqual(["ONE", "TWO", "THREE"]);
      });
    });

    describe("NestJS v12 hardening & graceful shutdown parity (unimplemented)", () => {
      // BUNEST_BUG: TcpServer.handleEnvelope() in packages/microservices/src/transports/tcp.transport.ts does not validate `envelope.id` (rejecting non-string/number IDs or IDs > 256 chars with InvalidPacketIdException), allowing oversized/nested IDs to be echoed back in every reply.
      it.skip("should drop a request whose id is neither a number nor a short string (<= 256 chars)", async () => {
        const server = await createListeningServer();
        const handler = createSpy(() => "should-not-run");
        server.addMessageHandler("test", handler);

        const conn = await connectRaw(server.port!);
        for (const badId of [[[["nested"]]], "a".repeat(257)]) {
          conn.socket.write(
            encodeFrame({
              type: "request",
              id: badId as unknown as string,
              pattern: "test",
              data: "x",
            }),
          );
        }
        await Bun.sleep(30);

        expectNotCalled(handler);
        expect(conn.responses).toHaveLength(0);
      });

      // BUNEST_BUG: TcpTransportOptions and TcpServer in packages/microservices/src/transports/tcp.transport.ts do not support `gracefulShutdown` / `gracePeriod` (close() terminates all sockets immediately without waiting for in-flight handlers).
      it.skip("should wait for in-flight handlers up to gracePeriod before closing sockets when gracefulShutdown is enabled", async () => {
        const server = new TcpServer({
          host: "127.0.0.1",
          port: 0,
          ...({ gracefulShutdown: true, gracePeriod: 500 } as Record<
            string,
            unknown
          >),
        });
        servers.push(server);
        server.addMessageHandler("slow-graceful", async () => {
          await Bun.sleep(40);
          return "finished-before-close";
        });
        await server.listen();

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        const inFlight = client.send("slow-graceful", {});
        await Bun.sleep(10);
        const closing = server.close();

        expect(await inFlight).toBe("finished-before-close");
        await closing;
      });

      // BUNEST_BUG: TcpTransportOptions and TcpServer in packages/microservices/src/transports/tcp.transport.ts do not support `maxConcurrentMessages` per-socket concurrency throttling.
      it.skip("should hold excess messages per peer while maxConcurrentMessages handlers are in flight", async () => {
        const server = new TcpServer({
          host: "127.0.0.1",
          port: 0,
          ...({ maxConcurrentMessages: 2 } as Record<string, unknown>),
        });
        servers.push(server);
        const pending: Array<() => void> = [];
        const handler = createSpy(
          () => new Promise<void>((res) => pending.push(res)),
        );
        server.addEventHandler("throttled", handler);
        await server.listen();

        const conn = await connectRaw(server.port!);
        const frame = encodeFrame({
          type: "event",
          pattern: "throttled",
          data: null,
        } satisfies RpcEventEnvelope);
        conn.socket.write(Buffer.concat([frame, frame, frame, frame, frame]));
        await Bun.sleep(30);

        expect(handler.callCount).toBe(2);
        pending.splice(0).forEach((fn) => fn());
        await Bun.sleep(30);
        expect(handler.callCount).toBe(4);
      });

      // BUNEST_BUG: normalizePattern() in packages/microservices/src/interfaces.ts has no recursion depth guard, so deeply nested patterns (e.g. depth 100_000) overflow the call stack instead of gracefully returning a 404 / NO_MESSAGE_HANDLER error.
      it.skip("should handle deeply nested object patterns without overflowing the stack", async () => {
        const server = await createListeningServer();
        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        const deepPattern = createDeeplyNestedObject(10_000);
        await expect(client.send(deepPattern, "tests")).rejects.toBeInstanceOf(
          RpcException,
        );
      });
    });
  },
);
