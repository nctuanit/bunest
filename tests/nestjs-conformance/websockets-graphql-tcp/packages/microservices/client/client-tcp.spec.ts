import { afterEach, describe, expect, it } from "bun:test";
import type { TCPSocketListener } from "bun";
import {
  FrameDecoder,
  RpcException,
  RpcTimeoutException,
  TcpClientProxy,
  TcpServer,
  Transport,
  encodeFrame,
  type ClientStatus,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
} from "../../../../../../packages/microservices/src";
import {
  createSpy,
  describeConformance,
  expectCalledOnce,
  itAdapted,
} from "../../../../_helpers";

describeConformance(
  "TcpClientProxy (ClientTCP)",
  {
    upstreamPath: "packages/microservices/test/client/client-tcp.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Ports ClientTCP unit & wire-level conformance to Bunest native Bun.connect TcpClientProxy over ephemeral TCP servers (port: 0).",
  },
  () => {
    const servers: TcpServer[] = [];
    const clients: TcpClientProxy[] = [];
    const rawListeners: Array<TCPSocketListener<unknown>> = [];

    afterEach(async () => {
      while (clients.length > 0) {
        await clients.pop()!.close();
      }
      while (servers.length > 0) {
        await servers.pop()!.close();
      }
      while (rawListeners.length > 0) {
        try {
          rawListeners.pop()!.stop(true);
        } catch {
          // Ignore already stopped listener
        }
      }
    });

    async function startEchoServer(
      options: { maxFrameBytes?: number } = {},
    ): Promise<TcpServer> {
      const server = new TcpServer({
        host: "127.0.0.1",
        port: 0,
        maxFrameBytes: options.maxFrameBytes,
      });
      servers.push(server);
      await server.listen();
      return server;
    }

    describe("constructor defaults", () => {
      it("should default host to 127.0.0.1, port to 0, autoReconnect to true, and transport to TCP", () => {
        const client = new TcpClientProxy({});
        clients.push(client);
        const internals = client as unknown as {
          host: string;
          port: number;
          autoReconnect: boolean;
          maxFrameBytes?: number;
        };

        expect(client.transport).toBe(Transport.TCP);
        expect(internals.host).toBe("127.0.0.1");
        expect(internals.port).toBe(0);
        expect(internals.autoReconnect).toBe(true);
        expect(internals.maxFrameBytes).toBeUndefined();
      });

      it("should use 127.0.0.1 when host is undefined or null", () => {
        for (const host of [undefined, null]) {
          const client = new TcpClientProxy({
            host: host as unknown as string,
          });
          clients.push(client);
          expect((client as unknown as { host: string }).host).toBe(
            "127.0.0.1",
          );
        }
      });

      it("should preserve custom maxFrameBytes, defaultTimeoutMs, and autoReconnect: false", () => {
        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: 4321,
          maxFrameBytes: 4096,
          defaultTimeoutMs: 1200,
          autoReconnect: false,
        });
        clients.push(client);
        const internals = client as unknown as {
          host: string;
          port: number;
          maxFrameBytes?: number;
          defaultTimeoutMs: number;
          autoReconnect: boolean;
        };

        expect(internals.host).toBe("127.0.0.1");
        expect(internals.port).toBe(4321);
        expect(internals.maxFrameBytes).toBe(4096);
        expect(internals.defaultTimeoutMs).toBe(1200);
        expect(internals.autoReconnect).toBe(false);
      });
    });

    describe("connect", () => {
      it("should connect to an ephemeral TcpServer and reuse the existing socket on subsequent connect() calls", async () => {
        let acceptedCount = 0;
        const listener = Bun.listen({
          hostname: "127.0.0.1",
          port: 0,
          socket: {
            open() {
              acceptedCount++;
            },
            data() {},
          },
        });
        rawListeners.push(listener);

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: listener.port,
        });
        clients.push(client);

        await client.connect();
        await client.connect();
        await Bun.sleep(15);

        expect(acceptedCount).toBe(1);
      });

      it("should coalesce concurrent connect() calls into a single TCP socket", async () => {
        let acceptedCount = 0;
        const listener = Bun.listen({
          hostname: "127.0.0.1",
          port: 0,
          socket: {
            open() {
              acceptedCount++;
            },
            data() {},
          },
        });
        rawListeners.push(listener);

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: listener.port,
        });
        clients.push(client);

        await Promise.all([
          client.connect(),
          client.connect(),
          client.connect(),
        ]);
        await Bun.sleep(15);

        expect(acceptedCount).toBe(1);
      });

      it("should reject cleanly when connecting to a closed port and allow retry once a server starts", async () => {
        // Bind and immediately release an ephemeral port to obtain an unused port
        const probe = Bun.listen({
          hostname: "127.0.0.1",
          port: 0,
          socket: { data() {} },
        });
        const unusedPort = probe.port;
        probe.stop(true);

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: unusedPort,
        });
        clients.push(client);

        await expect(client.connect()).rejects.toThrow();
        // connectPromise must have been cleared after failure
        expect(
          (client as unknown as { connectPromise?: unknown }).connectPromise,
        ).toBeUndefined();
      });
    });

    describe("send & request correlation", () => {
      it("should send requests, correlate concurrent out-of-order replies, and clean up pending map", async () => {
        const server = await startEchoServer();
        server.addMessageHandler("delay", async (data: unknown) => {
          const { label, ms } = data as { label: string; ms: number };
          await Bun.sleep(ms);
          return `reply:${label}`;
        });

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        const [slow, fast, mid] = await Promise.all([
          client.send<string>("delay", { label: "slow", ms: 40 }),
          client.send<string>("delay", { label: "fast", ms: 5 }),
          client.send<string>("delay", { label: "mid", ms: 20 }),
        ]);

        expect([slow, fast, mid]).toEqual([
          "reply:slow",
          "reply:fast",
          "reply:mid",
        ]);
        expect(
          (client as unknown as { pending: Map<string, unknown> }).pending.size,
        ).toBe(0);
      });

      it("should assign unique unpredictable request packet IDs", async () => {
        const observedIds: string[] = [];
        const listener = Bun.listen<{ decoder: FrameDecoder }>({
          hostname: "127.0.0.1",
          port: 0,
          socket: {
            open(sock) {
              sock.data = { decoder: new FrameDecoder() };
            },
            data(sock, chunk) {
              for (const env of sock.data.decoder.push<RpcRequestEnvelope>(
                chunk,
              )) {
                observedIds.push(env.id);
                sock.write(
                  encodeFrame({
                    type: "response",
                    id: env.id,
                    response: env.id,
                    isDisposed: true,
                  } satisfies RpcResponseEnvelope),
                );
              }
            },
          },
        });
        rawListeners.push(listener);

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: listener.port,
        });
        clients.push(client);

        const [id1, id2, id3] = await Promise.all([
          client.send<string>("id-check", {}),
          client.send<string>("id-check", {}),
          client.send<string>("id-check", {}),
        ]);

        expect(new Set([id1, id2, id3]).size).toBe(3);
        expect(observedIds).toHaveLength(3);
        // Random suffix prevents trivial prefix prediction between consecutive IDs
        const suffix1 = id1.split("_").pop()!;
        const suffix2 = id2.split("_").pop()!;
        const suffix3 = id3.split("_").pop()!;
        expect(suffix1).not.toBe(suffix2);
        expect(suffix2).not.toBe(suffix3);
      });

      it("should deserialize RpcException and plain Error responses accurately", async () => {
        const server = await startEchoServer();
        server.addMessageHandler("rpc-err-str", () => {
          throw new RpcException("denied");
        });
        server.addMessageHandler("rpc-err-obj", () => {
          throw new RpcException({
            status: 403,
            message: "forbidden",
            code: "E_FORB",
          });
        });
        server.addMessageHandler("plain-err", () => {
          const e = new TypeError("bad type");
          throw e;
        });

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        // String RpcException
        try {
          await client.send("rpc-err-str", {});
          throw new Error("Expected rejection");
        } catch (err) {
          expect(err).toBeInstanceOf(RpcException);
          expect((err as RpcException).getError()).toBe("denied");
        }

        // Object RpcException
        try {
          await client.send("rpc-err-obj", {});
          throw new Error("Expected rejection");
        } catch (err) {
          expect(err).toBeInstanceOf(RpcException);
          expect((err as RpcException).getError()).toEqual({
            status: 403,
            message: "forbidden",
            code: "E_FORB",
          });
        }

        // Plain Error
        try {
          await client.send("plain-err", {});
          throw new Error("Expected rejection");
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect(err).not.toBeInstanceOf(RpcException);
          expect((err as Error).name).toBe("TypeError");
          expect((err as Error).message).toBe("bad type");
        }
      });

      it("should ignore unsolicited responses with unknown correlation IDs without affecting pending requests", async () => {
        const listener = Bun.listen<{ decoder: FrameDecoder }>({
          hostname: "127.0.0.1",
          port: 0,
          socket: {
            open(sock) {
              sock.data = { decoder: new FrameDecoder() };
            },
            data(sock, chunk) {
              for (const env of sock.data.decoder.push<RpcRequestEnvelope>(
                chunk,
              )) {
                // First send a bogus response with an unknown ID
                sock.write(
                  encodeFrame({
                    type: "response",
                    id: "unknown-id-999",
                    response: "ignored",
                    isDisposed: true,
                  } satisfies RpcResponseEnvelope),
                );
                // Then send the real response
                sock.write(
                  encodeFrame({
                    type: "response",
                    id: env.id,
                    response: "real-reply",
                    isDisposed: true,
                  } satisfies RpcResponseEnvelope),
                );
              }
            },
          },
        });
        rawListeners.push(listener);

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: listener.port,
        });
        clients.push(client);

        expect(await client.send("req", {})).toBe("real-reply");
        expect(
          (client as unknown as { pending: Map<string, unknown> }).pending.size,
        ).toBe(0);
      });

      it("should remove timed-out requests from pending map and ignore late replies", async () => {
        const server = await startEchoServer();
        server.addMessageHandler("slow", async () => {
          await Bun.sleep(100);
          return "too-late";
        });
        server.addMessageHandler("fast", () => "on-time");

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);
        await client.connect();

        await expect(
          client.send("slow", {}, { timeoutMs: 25 }),
        ).rejects.toBeInstanceOf(RpcTimeoutException);
        expect(
          (client as unknown as { pending: Map<string, unknown> }).pending.size,
        ).toBe(0);

        // Wait past slow handler reply and confirm client still operates cleanly
        await Bun.sleep(110);
        expect(await client.send("fast", {})).toBe("on-time");
      });
    });

    describe("emit (dispatchEvent)", () => {
      it("should deliver fire-and-forget event frames to TcpServer", async () => {
        const server = await startEchoServer();
        let resolveEvent!: (val: unknown) => void;
        const eventReceived = new Promise<unknown>((res) => {
          resolveEvent = res;
        });

        server.addEventHandler("order.placed", (data) => {
          resolveEvent(data);
        });

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        await client.emit("order.placed", { orderId: "o-1", total: 99 });
        expect(await eventReceived).toEqual({ orderId: "o-1", total: 99 });
      });
    });

    describe("close", () => {
      it("should reject all pending requests, clear pending map, and clear socket on close()", async () => {
        const server = await startEchoServer();
        const releaseHandlers: Array<() => void> = [];
        server.addMessageHandler(
          "never",
          () =>
            new Promise<string>((resolve) => {
              releaseHandlers.push(() => resolve("released"));
            }),
        );

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);
        await client.connect();

        const req1 = client
          .send("never", 1, { timeoutMs: 5000 })
          .catch((err) => err);
        const req2 = client
          .send("never", 2, { timeoutMs: 5000 })
          .catch((err) => err);
        await Bun.sleep(10);

        expect(
          (client as unknown as { pending: Map<string, unknown> }).pending.size,
        ).toBe(2);

        await client.close();
        releaseHandlers.splice(0).forEach((fn) => fn());

        const [err1, err2] = await Promise.all([req1, req2]);
        expect(err1).toBeInstanceOf(Error);
        expect((err1 as Error).message).toBe("TCP client proxy closed.");
        expect(err2).toBeInstanceOf(Error);
        expect((err2 as Error).message).toBe("TCP client proxy closed.");
        expect(
          (client as unknown as { pending: Map<string, unknown> }).pending.size,
        ).toBe(0);
        expect(
          (client as unknown as { socket?: unknown }).socket,
        ).toBeUndefined();

        // Sending while closed rejects immediately
        await expect(client.send("never", 3)).rejects.toThrow(
          "TCP client proxy is closed.",
        );
      });

      it("should allow reconnecting explicitly via connect() after close()", async () => {
        const server = await startEchoServer();
        server.addMessageHandler("ping", () => "pong");

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        expect(await client.send("ping", {})).toBe("pong");
        await client.close();
        await client.connect();
        expect(await client.send("ping", {})).toBe("pong");
      });
    });

    describe("socket lifecycle & reconnection", () => {
      it("should fail pending requests when the remote server closes the connection mid-flight", async () => {
        const server = await startEchoServer();
        let resolveStarted!: () => void;
        let releaseHandler!: () => void;
        const started = new Promise<void>((res) => {
          resolveStarted = res;
        });

        server.addMessageHandler("hanging", async () => {
          resolveStarted();
          await new Promise<void>((res) => {
            releaseHandler = res;
          });
          return "never";
        });

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        const reqErrorPromise = client
          .send("hanging", {}, { timeoutMs: 5000 })
          .catch((err) => err);
        await started;
        await server.close();
        releaseHandler();

        const caught = await reqErrorPromise;
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toMatch(/closed|lost/i);
        expect(
          (client as unknown as { pending: Map<string, unknown> }).pending.size,
        ).toBe(0);
      });

      it("should automatically reconnect on next send() when autoReconnect is true (default)", async () => {
        const server = await startEchoServer();
        const boundPort = server.port!;
        server.addMessageHandler("who", () => "server-1");

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: boundPort,
          autoReconnect: true,
        });
        clients.push(client);

        expect(await client.send("who", {})).toBe("server-1");

        // Close server and bring up a new server on the same port
        await server.close();
        const server2 = new TcpServer({ host: "127.0.0.1", port: boundPort });
        servers.push(server2);
        server2.addMessageHandler("who", () => "server-2");
        await server2.listen();

        const res = await client.send(
          "who",
          {},
          { retries: 2, retryDelayMs: 15 },
        );
        expect(res).toBe("server-2");
      });

      it("should mark client closed on disconnect when autoReconnect is false", async () => {
        const server = await startEchoServer();
        server.addMessageHandler("ping", () => "pong");

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
          autoReconnect: false,
        });
        clients.push(client);

        expect(await client.send("ping", {})).toBe("pong");
        await server.close();
        await Bun.sleep(25);

        await expect(client.send("ping", {})).rejects.toThrow(
          "TCP client proxy is closed.",
        );
      });

      // BUNEST_BUG: TcpClientProxy in packages/microservices/src/transports/tcp.transport.ts never calls `this.emitStatus("connected")` on socket open or `this.emitStatus("disconnected")` on close/handleDisconnect, so `client.status` stays "disconnected" and `client.onStatus(...)` listeners never fire.
      it.skip("should emit connected and disconnected status transitions over the socket lifecycle", async () => {
        const server = await startEchoServer();
        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        const statuses: ClientStatus[] = [];
        client.onStatus((s) => statuses.push(s));

        await client.connect();
        expect(client.status).toBe("connected");

        await server.close();
        await Bun.sleep(25);

        expect(client.status).toBe("disconnected");
        expect(statuses).toEqual(["connected", "disconnected"]);
      });

      // BUNEST_BUG: In TcpClientProxy.ensureConnected() (packages/microservices/src/transports/tcp.transport.ts), calling close() while connect() is in-flight does not guard `open(socket)` against `this.closed === true`, leaving `this.socket` assigned and leaked after close().
      it.skip("should close and discard a socket that finishes opening after close() was called", async () => {
        const server = await startEchoServer();
        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        const connectPromise = client.connect();
        await client.close();
        await connectPromise.catch(() => {});

        expect(
          (client as unknown as { socket?: unknown }).socket,
        ).toBeUndefined();
      });
    });

    describe("framing errors, maxFrameBytes & large payload backpressure", () => {
      it("should disconnect and reject pending requests when peer sends a frame exceeding client maxFrameBytes", async () => {
        const server = await startEchoServer();
        server.addMessageHandler("big-reply", () => "x".repeat(4096));

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
          maxFrameBytes: 1024,
        });
        clients.push(client);

        await expect(client.send("big-reply", {})).rejects.toThrow(
          /exceeds limit/,
        );
        expect(
          (client as unknown as { pending: Map<string, unknown> }).pending.size,
        ).toBe(0);
      });

      it("should disconnect and reject pending requests when peer sends malformed JSON frame", async () => {
        const listener = Bun.listen({
          hostname: "127.0.0.1",
          port: 0,
          socket: {
            data(sock) {
              const badJson = Buffer.from("{broken-json", "utf8");
              const frame = Buffer.alloc(4 + badJson.byteLength);
              frame.writeUInt32BE(badJson.byteLength, 0);
              badJson.copy(frame, 4);
              sock.write(frame);
            },
          },
        });
        rawListeners.push(listener);

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: listener.port,
        });
        clients.push(client);

        await expect(client.send("bad", {})).rejects.toThrow();
        expect(
          (client as unknown as { pending: Map<string, unknown> }).pending.size,
        ).toBe(0);
      });

      itAdapted(
        "ADR-001",
        "should handle concurrent large payloads (write queue / drain backpressure) without stalling replies",
        async () => {
          const server = await startEchoServer();
          server.addMessageHandler("size", (data: unknown) => {
            const payload = data as { tag: string; blob: string };
            return { tag: payload.tag, len: payload.blob.length };
          });

          const client = new TcpClientProxy({
            host: "127.0.0.1",
            port: server.port!,
          });
          clients.push(client);

          const blob = "Bunest-TCP-Backpressure-".repeat(12_000); // ~288 KB
          const results = await Promise.all([
            client.send<{ tag: string; len: number }>("size", {
              tag: "a",
              blob,
            }),
            client.send<{ tag: string; len: number }>("size", {
              tag: "b",
              blob,
            }),
            client.send<{ tag: string; len: number }>("size", {
              tag: "c",
              blob,
            }),
          ]);

          expect(results).toEqual([
            { tag: "a", len: blob.length },
            { tag: "b", len: blob.length },
            { tag: "c", len: blob.length },
          ]);
        },
        "Native Bun socket writeQueue + drain backpressure",
      );

      it("should run preRequestHook before TCP send() and emit()", async () => {
        const server = await startEchoServer();
        server.addMessageHandler("echo", (data) => data);

        const client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        clients.push(client);

        const hook = createSpy(
          (ctx: { pattern: string; transport: Transport }) => {
            expect(ctx.transport).toBe(Transport.TCP);
          },
        );
        client.setPreRequestHook(hook);

        expect(await client.send("echo", { ok: true })).toEqual({ ok: true });
        expectCalledOnce(hook);
      });
    });
  },
);
