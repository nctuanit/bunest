import { afterEach, describe, expect, it } from "bun:test";
import {
  GrpcClientProxy,
  GrpcContext,
  GrpcException,
  GrpcFrameDecoder,
  GrpcMetadata,
  GrpcServer,
  GrpcStatus,
  JsonGrpcCodec,
  Transport,
  decodeGrpcFrames,
  encodeGrpcFrame,
  encodeGrpcTrailerFrame,
  formatGrpcTimeout,
  parseGrpcTimeout,
  parseGrpcTrailers,
  type GrpcCodec,
} from "../../../../../../packages/microservices/src";
import {
  createSpy,
  describeConformance,
  itAdapted,
} from "../../../../_helpers";

describeConformance(
  "ClientGrpcProxy (GrpcClientProxy)",
  {
    upstreamPath: "packages/microservices/test/client/client-grpc.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapted from NestJS @grpc/grpc-js + RxJS ClientGrpcProxy unit tests to Bunest native zero-dep GrpcClientProxy, GrpcMetadata, GrpcFrameDecoder, and Promise/AsyncGenerator RPCs.",
  },
  () => {
    const servers: GrpcServer[] = [];
    const rawServers: Array<ReturnType<typeof Bun.serve>> = [];
    const clients: GrpcClientProxy[] = [];

    afterEach(async () => {
      while (clients.length > 0) {
        await clients.pop()!.close();
      }
      while (servers.length > 0) {
        await servers.pop()!.close();
      }
      while (rawServers.length > 0) {
        await rawServers.pop()!.stop(true);
      }
    });

    async function startGrpcServer(
      opts: {
        package?: string | readonly string[];
        codec?: GrpcCodec;
        maxMessageBytes?: number;
      } = {},
    ): Promise<GrpcServer> {
      const srv = new GrpcServer({ host: "127.0.0.1", port: 0, ...opts });
      servers.push(srv);
      await srv.listen();
      return srv;
    }

    describe("constructor & options", () => {
      it("should initialize transport as Transport.GRPC and support unwrap()", () => {
        const client = new GrpcClientProxy({
          host: "127.0.0.1",
          port: 50051,
          package: "test",
        });
        clients.push(client);
        expect(client.transport).toBe(Transport.GRPC);
        expect(client.unwrap()).toBe(client);
      });

      it("should accept url without scheme, with http:// scheme, and package array", async () => {
        const srv = await startGrpcServer({ package: ["test", "test2"] });
        srv.addGrpcHandler("Echo", "Ping", (d) => ({ pong: d }));

        const c1 = new GrpcClientProxy({
          url: `127.0.0.1:${srv.port}`,
          package: ["test", "test2"],
        });
        const c2 = new GrpcClientProxy({
          url: srv.url,
          package: "test2",
        });
        clients.push(c1, c2);

        expect(await c1.call("Echo", "Ping", { n: 1 })).toEqual({
          pong: { n: 1 },
        });
        expect(await c2.call("Echo", "Ping", { n: 2 })).toEqual({
          pong: { n: 2 },
        });
      });

      it("should clone default GrpcMetadata, accept GrpcMetadataLike, and accept plain Record", async () => {
        const srv = await startGrpcServer();
        srv.addGrpcHandler("Meta", "Echo", (_d, ctx) =>
          (ctx as GrpcContext).getMetadata().toRecord(),
        );

        const initialMd = new GrpcMetadata({ "x-origin": "initial" });
        const cMd = new GrpcClientProxy({ url: srv.url, metadata: initialMd });
        // Mutating original after construction must not affect client
        initialMd.set("x-origin", "mutated");

        const cLike = new GrpcClientProxy({
          url: srv.url,
          metadata: { toHeaders: () => ({ "x-like": "yes" }) },
        });
        const cRec = new GrpcClientProxy({
          url: srv.url,
          metadata: { "x-rec": "plain" },
        });
        clients.push(cMd, cLike, cRec);

        expect(
          await cMd.call<Record<string, string>>("Meta", "Echo", {}),
        ).toMatchObject({ "x-origin": "initial" });
        expect(
          await cLike.call<Record<string, string>>("Meta", "Echo", {}),
        ).toMatchObject({ "x-like": "yes" });
        expect(
          await cRec.call<Record<string, string>>("Meta", "Echo", {}),
        ).toMatchObject({ "x-rec": "plain" });
      });
    });

    describe("getService", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "should create a dynamic service proxy supporting lowercase and PascalCase methods",
        async () => {
          const srv = await startGrpcServer({ package: "test" });
          srv.addGrpcHandler("TestService", "FindOne", (data) => ({
            found: data,
          }));

          const client = new GrpcClientProxy({
            url: srv.url,
            package: "test",
          });
          clients.push(client);

          const svc = client.getService<{
            findOne(req: { id: number }): Promise<{ found: { id: number } }>;
            FindOne(req: { id: number }): Promise<{ found: { id: number } }>;
          }>("TestService");

          expect(await svc.findOne({ id: 1 })).toEqual({ found: { id: 1 } });
          expect(await svc.FindOne({ id: 2 })).toEqual({ found: { id: 2 } });
        },
      );

      it("should return undefined for `then` and Symbol accesses so returning a service from async functions does not hang", () => {
        const client = new GrpcClientProxy({ url: "http://127.0.0.1:1" });
        clients.push(client);
        const svc = client.getService<Record<PropertyKey, unknown>>("Hero");

        expect(svc.then).toBeUndefined();
        expect(svc[Symbol.toStringTag]).toBeUndefined();
      });

      it("should not double-prefix package when serviceName already contains a dot", async () => {
        const seenPaths: string[] = [];
        const raw = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(req) {
            seenPaths.push(new URL(req.url).pathname);
            return new Response(
              encodeGrpcFrame(
                new TextEncoder().encode(JSON.stringify({ ok: true })),
              ),
              {
                status: 200,
                headers: {
                  "content-type": "application/grpc+json",
                  "grpc-status": "0",
                },
              },
            );
          },
        });
        rawServers.push(raw);

        const client = new GrpcClientProxy({
          url: `http://127.0.0.1:${raw.port}`,
          package: "pkg",
        });
        clients.push(client);

        const qualified = client.getService<{
          ping(d: unknown): Promise<{ ok: boolean }>;
        }>("custom.ns.Service");
        const unqualified = client.getService<{
          ping(d: unknown): Promise<{ ok: boolean }>;
        }>("Service");

        await qualified.ping({});
        await unqualified.ping({});

        expect(seenPaths).toEqual([
          "/custom.ns.Service/ping",
          "/pkg.Service/ping",
        ]);
      });

      it("should pass GrpcCallOptions (metadata and timeoutMs) through getService proxy", async () => {
        const srv = await startGrpcServer({ package: "test" });
        srv.addGrpcHandler("TestService", "Find", (_data, ctx) => {
          const gCtx = ctx as GrpcContext;
          return {
            trace: gCtx.getMetadata().get("x-trace"),
            hasDeadline: gCtx.deadline !== undefined,
          };
        });

        const client = new GrpcClientProxy({ url: srv.url, package: "test" });
        clients.push(client);

        const svc = client.getService<{
          find(
            req: unknown,
            opts?: { metadata?: Record<string, string>; timeoutMs?: number },
          ): Promise<{ trace: string; hasDeadline: boolean }>;
        }>("TestService");

        expect(
          await svc.find(
            {},
            { metadata: { "x-trace": "t-99" }, timeoutMs: 1500 },
          ),
        ).toEqual({
          trace: "t-99",
          hasDeadline: true,
        });
      });

      // BUNEST_BUG: GrpcClientProxy.getService() unconditionally forwards every property call to unary `this.call()` and cannot invoke server-streaming methods as AsyncIterable or pass request streams (packages/microservices/src/transports/grpc.transport.ts:1560-1573).
      it.skip("should support invoking server-streaming methods through getService() proxy", async () => {
        const srv = await startGrpcServer();
        srv.addGrpcStreamHandler("StreamSvc", "List", async function* () {
          yield { n: 1 };
          yield { n: 2 };
        });
        const client = new GrpcClientProxy({ url: srv.url });
        clients.push(client);
        const svc = client.getService<{
          list(req: unknown): AsyncIterable<{ n: number }>;
        }>("StreamSvc");
        const out: Array<{ n: number }> = [];
        for await (const item of svc.list({})) {
          out.push(item);
        }
        expect(out).toEqual([{ n: 1 }, { n: 2 }]);
      });
    });

    describe("call & callWithMetadata", () => {
      it("should propagate request/response ASCII and binary (-bin) metadata and preserve caller metadata immutably", async () => {
        const srv = await startGrpcServer();
        srv.addGrpcHandler("Svc", "Meta", (_d, ctx) => {
          const gCtx = ctx as GrpcContext;
          const bin = gCtx.getMetadata().getBuffer("token-bin");
          gCtx.setResponseMetadata("x-resp", "ok");
          gCtx.setResponseMetadata("resp-bin", new Uint8Array([1, 2, 3]));
          return {
            reqId: gCtx.getMetadata().get("x-request-id"),
            tenant: gCtx.getMetadata().get("tenant"),
            binBytes: bin ? Array.from(bin) : [],
          };
        });

        const client = new GrpcClientProxy({
          url: srv.url,
          metadata: { "x-request-id": "default-id", tenant: "acme" },
        });
        clients.push(client);

        const callerMd = new GrpcMetadata();
        callerMd.set("x-request-id", "caller-id");
        callerMd.set("token-bin", new Uint8Array([0xca, 0xfe]));

        const res = await client.callWithMetadata<{
          reqId: string;
          tenant: string;
          binBytes: number[];
        }>("Svc", "Meta", {}, { metadata: callerMd });

        expect(res.status).toBe(GrpcStatus.OK);
        expect(res.data).toEqual({
          reqId: "caller-id",
          tenant: "acme",
          binBytes: [0xca, 0xfe],
        });
        expect(res.metadata.get("x-resp")).toBe("ok");
        expect(Array.from(res.metadata.getBuffer("resp-bin")!)).toEqual([
          1, 2, 3,
        ]);
        // Caller metadata untouched
        expect(callerMd.has("tenant")).toBe(false);
        expect(callerMd.get("x-request-id")).toBe("caller-id");
      });

      it("should decode trailer frames in unary responses and fail on non-OK trailer status", async () => {
        let failTrailer = false;
        const raw = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            const dataFrame = encodeGrpcFrame(
              new TextEncoder().encode(JSON.stringify({ v: 7 })),
            );
            const trailerFrame = encodeGrpcTrailerFrame(
              failTrailer
                ? {
                    "grpc-status": String(GrpcStatus.ABORTED),
                    "grpc-message": encodeURIComponent("trailer abort"),
                    "x-trailer-key": "t-err",
                  }
                : {
                    "grpc-status": "0",
                    "grpc-message": "",
                    "x-trailer-key": "t-ok",
                  },
            );
            const combined = new Uint8Array(
              dataFrame.byteLength + trailerFrame.byteLength,
            );
            combined.set(dataFrame, 0);
            combined.set(trailerFrame, dataFrame.byteLength);
            return new Response(combined, {
              status: 200,
              headers: {
                "content-type": "application/grpc+json",
                "grpc-status": "0",
              },
            });
          },
        });
        rawServers.push(raw);

        const client = new GrpcClientProxy({
          url: `http://127.0.0.1:${raw.port}`,
        });
        clients.push(client);

        const ok = await client.callWithMetadata<{ v: number }>("S", "M", {});
        expect(ok.data).toEqual({ v: 7 });
        expect(ok.metadata.get("x-trailer-key")).toBe("t-ok");

        failTrailer = true;
        let caught: unknown;
        try {
          await client.call("S", "M", {});
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(GrpcException);
        expect((caught as GrpcException).code).toBe(GrpcStatus.ABORTED);
        expect((caught as GrpcException).message).toBe("trailer abort");
        expect((caught as GrpcException).metadata?.get("x-trailer-key")).toBe(
          "t-err",
        );
      });

      it("should map HTTP error statuses when grpc-status header is omitted", async () => {
        const cases: Array<[number, GrpcStatus]> = [
          [400, GrpcStatus.INVALID_ARGUMENT],
          [401, GrpcStatus.UNAUTHENTICATED],
          [403, GrpcStatus.PERMISSION_DENIED],
          [404, GrpcStatus.NOT_FOUND],
          [409, GrpcStatus.ALREADY_EXISTS],
          [422, GrpcStatus.INVALID_ARGUMENT],
          [429, GrpcStatus.RESOURCE_EXHAUSTED],
          [499, GrpcStatus.CANCELLED],
          [501, GrpcStatus.UNIMPLEMENTED],
          [503, GrpcStatus.UNAVAILABLE],
          [504, GrpcStatus.DEADLINE_EXCEEDED],
          [500, GrpcStatus.INTERNAL],
        ];
        let nextStatus = 500;
        const raw = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            return new Response("err", { status: nextStatus });
          },
        });
        rawServers.push(raw);

        const client = new GrpcClientProxy({
          url: `http://127.0.0.1:${raw.port}`,
        });
        clients.push(client);

        for (const [httpStatus, expectedGrpc] of cases) {
          nextStatus = httpStatus;
          let caught: unknown;
          try {
            await client.call("S", "M", {});
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(GrpcException);
          expect((caught as GrpcException).code).toBe(expectedGrpc);
        }
      });

      it("should throw DATA_LOSS on truncated unary response frame and RESOURCE_EXHAUSTED on oversized response", async () => {
        let mode: "trunc" | "oversized" = "trunc";
        const raw = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            const body =
              mode === "trunc"
                ? new Uint8Array([0, 0, 0, 0, 10, 1, 2])
                : encodeGrpcFrame(new Uint8Array(600));
            return new Response(body, {
              status: 200,
              headers: {
                "content-type": "application/grpc+json",
                "grpc-status": "0",
              },
            });
          },
        });
        rawServers.push(raw);

        const client = new GrpcClientProxy({
          url: `http://127.0.0.1:${raw.port}`,
          maxMessageBytes: 256,
        });
        clients.push(client);

        let err1: unknown;
        try {
          await client.call("S", "M", {});
        } catch (err) {
          err1 = err;
        }
        expect(err1).toBeInstanceOf(GrpcException);
        expect((err1 as GrpcException).code).toBe(GrpcStatus.DATA_LOSS);

        mode = "oversized";
        let err2: unknown;
        try {
          await client.call("S", "M", {});
        } catch (err) {
          err2 = err;
        }
        expect(err2).toBeInstanceOf(GrpcException);
        expect((err2 as GrpcException).code).toBe(
          GrpcStatus.RESOURCE_EXHAUSTED,
        );
      });

      it("should tolerate malformed percent-encoding in grpc-message header", async () => {
        const raw = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            return new Response(new Uint8Array(0), {
              status: 200,
              headers: {
                "grpc-status": String(GrpcStatus.INTERNAL),
                "grpc-message": "%E0%A4%A",
              },
            });
          },
        });
        rawServers.push(raw);

        const client = new GrpcClientProxy({
          url: `http://127.0.0.1:${raw.port}`,
        });
        clients.push(client);

        let caught: unknown;
        try {
          await client.call("S", "M", {});
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(GrpcException);
        expect((caught as GrpcException).code).toBe(GrpcStatus.INTERNAL);
        expect((caught as GrpcException).message).toBe("%E0%A4%A");
      });

      it("should enforce call timeoutMs -> DEADLINE_EXCEEDED and map unreachable endpoint -> UNAVAILABLE", async () => {
        const srv = await startGrpcServer();
        srv.addGrpcHandler("S", "Slow", async () => {
          await Bun.sleep(250);
          return { ok: true };
        });

        const client = new GrpcClientProxy({ url: srv.url });
        clients.push(client);

        let timeoutErr: unknown;
        try {
          await client.call("S", "Slow", {}, { timeoutMs: 30 });
        } catch (err) {
          timeoutErr = err;
        }
        expect(timeoutErr).toBeInstanceOf(GrpcException);
        expect((timeoutErr as GrpcException).code).toBe(
          GrpcStatus.DEADLINE_EXCEEDED,
        );

        await srv.close();
        let unavailErr: unknown;
        try {
          await client.call("S", "Slow", {}, { timeoutMs: 500 });
        } catch (err) {
          unavailErr = err;
        }
        expect(unavailErr).toBeInstanceOf(GrpcException);
        expect((unavailErr as GrpcException).code).toBe(GrpcStatus.UNAVAILABLE);
      });
    });

    describe("stream (server-streaming flow control & errors)", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "should yield decoded frames incrementally, propagate mid-stream errors, and handle client-side cancellation",
        async () => {
          const srv = await startGrpcServer();
          srv.addGrpcStreamHandler("Feed", "Items", async function* (data) {
            const { count, failAt } = data as {
              count: number;
              failAt?: number;
            };
            for (let i = 1; i <= count; i++) {
              if (failAt === i) {
                throw new GrpcException(
                  GrpcStatus.OUT_OF_RANGE,
                  `stopped at ${i}`,
                  new GrpcMetadata({ "x-fail-idx": String(i) }),
                );
              }
              yield { i };
            }
          });

          const client = new GrpcClientProxy({ url: srv.url });
          clients.push(client);

          // 1. Complete stream
          const all: number[] = [];
          for await (const msg of client.stream<{ i: number }>(
            "Feed",
            "Items",
            { count: 3 },
          )) {
            all.push(msg.i);
          }
          expect(all).toEqual([1, 2, 3]);

          // 2. Server error mid-stream preserves items before error + trailer metadata
          const beforeErr: number[] = [];
          let caught: unknown;
          try {
            for await (const msg of client.stream<{ i: number }>(
              "Feed",
              "Items",
              { count: 5, failAt: 3 },
            )) {
              beforeErr.push(msg.i);
            }
          } catch (err) {
            caught = err;
          }
          expect(beforeErr).toEqual([1, 2]);
          expect(caught).toBeInstanceOf(GrpcException);
          expect((caught as GrpcException).code).toBe(GrpcStatus.OUT_OF_RANGE);
          expect((caught as GrpcException).message).toBe("stopped at 3");
          expect((caught as GrpcException).metadata?.get("x-fail-idx")).toBe(
            "3",
          );

          // 3. Client-side early cancel (break) stops consuming cleanly without throwing
          const partial: number[] = [];
          for await (const msg of client.stream<{ i: number }>(
            "Feed",
            "Items",
            { count: 10 },
          )) {
            partial.push(msg.i);
            if (msg.i === 2) break;
          }
          expect(partial).toEqual([1, 2]);
        },
      );

      it("should fail stream with initial non-OK status header and with DATA_LOSS on truncated stream body", async () => {
        let mode: "header-err" | "trunc-body" = "header-err";
        const raw = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            if (mode === "header-err") {
              return new Response(new Uint8Array(0), {
                status: 200,
                headers: {
                  "grpc-status": String(GrpcStatus.PERMISSION_DENIED),
                  "grpc-message": encodeURIComponent("nope"),
                },
              });
            }
            // One valid frame followed by truncated 3 bytes
            const valid = encodeGrpcFrame(
              new TextEncoder().encode(JSON.stringify({ ok: 1 })),
            );
            const buf = new Uint8Array(valid.byteLength + 3);
            buf.set(valid, 0);
            buf.set([0, 0, 0], valid.byteLength);
            return new Response(buf, {
              status: 200,
              headers: {
                "content-type": "application/grpc+json",
                "grpc-status": "0",
              },
            });
          },
        });
        rawServers.push(raw);

        const client = new GrpcClientProxy({
          url: `http://127.0.0.1:${raw.port}`,
        });
        clients.push(client);

        let err1: unknown;
        try {
          for await (const _x of client.stream("S", "M", {})) {
            // none
          }
        } catch (err) {
          err1 = err;
        }
        expect(err1).toBeInstanceOf(GrpcException);
        expect((err1 as GrpcException).code).toBe(GrpcStatus.PERMISSION_DENIED);

        mode = "trunc-body";
        const received: unknown[] = [];
        let err2: unknown;
        try {
          for await (const x of client.stream("S", "M", {})) {
            received.push(x);
          }
        } catch (err) {
          err2 = err;
        }
        expect(received).toEqual([{ ok: 1 }]);
        expect(err2).toBeInstanceOf(GrpcException);
        expect((err2 as GrpcException).code).toBe(GrpcStatus.DATA_LOSS);
      });
    });

    describe("send, emit, close, connect & pattern parsing", () => {
      it("should parse /Service/Method, Service.Method, and { service, method } patterns and reject invalid patterns", async () => {
        const srv = await startGrpcServer();
        srv.addGrpcHandler("Math", "Double", (d) => ({
          out: (d as { n: number }).n * 2,
        }));

        const client = new GrpcClientProxy({ url: srv.url });
        clients.push(client);

        expect(await client.send("/Math/Double", { n: 3 })).toEqual({ out: 6 });
        expect(await client.send("Math.Double", { n: 4 })).toEqual({ out: 8 });
        expect(
          await client.send({ service: "Math", method: "Double" }, { n: 5 }),
        ).toEqual({ out: 10 });

        await expect(client.send("InvalidPattern", {})).rejects.toMatchObject({
          code: GrpcStatus.INVALID_ARGUMENT,
        });
      });

      it("should retry UNAVAILABLE/DEADLINE_EXCEEDED on send() but never retry non-retryable GrpcException", async () => {
        const srv = await startGrpcServer();
        let unavailAttempts = 0;
        let notFoundAttempts = 0;
        srv.addGrpcHandler("Retry", "Transient", () => {
          unavailAttempts++;
          if (unavailAttempts < 3) {
            throw new GrpcException(GrpcStatus.UNAVAILABLE, "retry me");
          }
          return { ok: true, attempts: unavailAttempts };
        });
        srv.addGrpcHandler("Retry", "Missing", () => {
          notFoundAttempts++;
          throw new GrpcException(GrpcStatus.NOT_FOUND, "permanent");
        });

        const client = new GrpcClientProxy({ url: srv.url });
        clients.push(client);

        expect(
          await client.send(
            "Retry.Transient",
            {},
            { retries: 3, retryDelayMs: 5 },
          ),
        ).toEqual({ ok: true, attempts: 3 });

        await expect(
          client.send("Retry.Missing", {}, { retries: 3, retryDelayMs: 5 }),
        ).rejects.toMatchObject({ code: GrpcStatus.NOT_FOUND });
        expect(notFoundAttempts).toBe(1);
      });

      it("should support emit(), setPreRequestHook() on send()/emit(), and close()/connect()/onModuleDestroy()", async () => {
        const srv = await startGrpcServer();
        const received: unknown[] = [];
        srv.addGrpcHandler("Events", "Notify", (d) => {
          received.push(d);
          return { ack: true };
        });

        const client = new GrpcClientProxy({ url: srv.url });
        clients.push(client);

        const hookSpy = createSpy();
        client.setPreRequestHook(hookSpy);

        await client.emit("Events.Notify", { id: 1 });
        expect(received).toEqual([{ id: 1 }]);
        expect(hookSpy.calledOnce).toBe(true);

        await client.onModuleDestroy();
        await expect(client.call("Events", "Notify", {})).rejects.toMatchObject(
          {
            code: GrpcStatus.UNAVAILABLE,
          },
        );
        await expect(async () => {
          for await (const _x of client.stream("Events", "Notify", {})) {
            // should fail immediately
          }
        }).toThrow("GrpcClientProxy is closed.");

        // connect() re-opens client cleanly
        await client.connect();
        expect(await client.send("Events.Notify", { id: 2 })).toEqual({
          ack: true,
        });
        expect(hookSpy.calledTwice).toBe(true);
      });

      // BUNEST_BUG: GrpcClientProxy.connect() and close() do not call ClientProxy.emitStatus("connected") / emitStatus("disconnected"), so client.status stays "disconnected" and onStatus() listeners never fire (packages/microservices/src/transports/grpc.transport.ts:1217-1227).
      it.skip("should update client.status and notify onStatus listeners on connect() and close()", async () => {
        const client = new GrpcClientProxy({ url: "http://127.0.0.1:1" });
        clients.push(client);
        const statuses: string[] = [];
        client.onStatus((s) => statuses.push(s));

        await client.connect();
        expect(client.status).toBe("connected");
        await client.close();
        expect(client.status).toBe("disconnected");
        expect(statuses).toEqual(["connected", "disconnected"]);
      });
    });

    describe("GrpcFrameDecoder, GrpcMetadata, timeout helpers & JsonGrpcCodec", () => {
      it("should encode/decode compressed frames, trailer frames, reset decoder, and handle timeout units", () => {
        const codec = new JsonGrpcCodec();
        expect(codec.contentType).toBe("application/grpc+json");
        expect(codec.decode(new Uint8Array(0))).toBeUndefined();
        expect(codec.decode(codec.encode(undefined))).toBeNull();
        expect(codec.decode(codec.encode({ a: [1, 2] }))).toEqual({
          a: [1, 2],
        });

        const compressedFrame = encodeGrpcFrame(
          new Uint8Array([10, 20, 30]),
          true,
        );
        const frames = decodeGrpcFrames(compressedFrame);
        expect(frames).toHaveLength(1);
        expect(frames[0]!.compressed).toBe(true);
        expect(frames[0]!.isTrailer).toBe(false);
        expect(Array.from(frames[0]!.payload)).toEqual([10, 20, 30]);

        const decoder = new GrpcFrameDecoder();
        expect(decoder.push(compressedFrame.subarray(0, 3))).toEqual([]);
        expect(decoder.remainingBytes).toBe(3);
        decoder.reset();
        expect(decoder.remainingBytes).toBe(0);

        // Trailer frame parsing ignores blank & colon-less lines
        const trailerFrame = encodeGrpcTrailerFrame({
          "X-Custom": "val\r\ninjected",
          "grpc-status": "0",
        });
        const decodedTrailer = decodeGrpcFrames(trailerFrame)[0]!;
        expect(decodedTrailer.isTrailer).toBe(true);
        expect(parseGrpcTrailers(decodedTrailer.payload)).toEqual({
          "x-custom": "val injected",
          "grpc-status": "0",
        });

        // Timeout formatting & parsing across all gRPC spec units
        expect(formatGrpcTimeout(0)).toBe("1m");
        expect(formatGrpcTimeout(12.3)).toBe("13m");
        expect(parseGrpcTimeout("1H")).toBe(3_600_000);
        expect(parseGrpcTimeout("2M")).toBe(120_000);
        expect(parseGrpcTimeout("3S")).toBe(3_000);
        expect(parseGrpcTimeout("45m")).toBe(45);
        expect(parseGrpcTimeout("1500u")).toBe(2);
        expect(parseGrpcTimeout("2500000n")).toBe(3);
        expect(parseGrpcTimeout(null)).toBeUndefined();
        expect(parseGrpcTimeout("bad")).toBeUndefined();

        // GrpcMetadata add/getAll/has/delete/keys/clone/fromHeaders
        const md = new GrpcMetadata();
        md.add("X-Tag", "a").add("x-tag", "b");
        expect(md.get("x-tag")).toBe("a");
        expect(md.getAll("X-TAG")).toEqual(["a", "b"]);
        expect(md.toHeaders()).toEqual({ "x-tag": "a, b" });
        expect(md.has("x-tag")).toBe(true);
        expect(md.keys()).toEqual(["x-tag"]);
        const cloned = md.clone();
        expect(md.delete("x-tag")).toBe(true);
        expect(md.has("x-tag")).toBe(false);
        expect(cloned.getAll("x-tag")).toEqual(["a", "b"]);

        // fromHeaders filters reserved HTTP/gRPC headers
        const fromH = GrpcMetadata.fromHeaders(
          new Headers({
            "content-type": "application/grpc+json",
            "grpc-status": "0",
            "x-tenant": "acme",
          }),
        );
        expect(fromH.has("content-type")).toBe(false);
        expect(fromH.has("grpc-status")).toBe(false);
        expect(fromH.get("x-tenant")).toBe("acme");
      });
    });
  },
);
