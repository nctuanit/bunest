import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Inject,
  Injectable,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  ClientsModule,
  Ctx,
  GrpcClientProxy,
  GrpcContext,
  GrpcException,
  GrpcFrameDecoder,
  GrpcMetadata,
  GrpcMethod,
  GrpcServer,
  GrpcStatus,
  GrpcStreamMethod,
  MICROSERVICE_SERVER,
  MicroserviceModule,
  Payload,
  Transport,
  encodeGrpcFrame,
  encodeGrpcTrailerFrame,
  formatGrpcTimeout,
  parseGrpcTimeout,
  parseGrpcTrailers,
  type GrpcCodec,
} from "../src/index";

describe("gRPC Framing, Metadata & Timeout Utilities", () => {
  it("encodes and decodes 5-byte gRPC frames under 1-byte fragmentation, coalescing, and trailer frames", () => {
    const p1 = new TextEncoder().encode(JSON.stringify({ id: 1 }));
    const p2 = new TextEncoder().encode(JSON.stringify({ id: 2, msg: "hi" }));
    const f1 = encodeGrpcFrame(p1);
    const f2 = encodeGrpcFrame(p2);
    const trailer = encodeGrpcTrailerFrame({
      "grpc-status": "0",
      "grpc-message": "",
      "x-trace-id": "tr_123",
    });

    const combined = new Uint8Array(f1.byteLength + f2.byteLength + trailer.byteLength);
    combined.set(f1, 0);
    combined.set(f2, f1.byteLength);
    combined.set(trailer, f1.byteLength + f2.byteLength);

    // Push 1 byte at a time
    const decoder = new GrpcFrameDecoder();
    const out = [];
    for (let i = 0; i < combined.byteLength; i++) {
      out.push(...decoder.push(combined.subarray(i, i + 1)));
    }
    expect(out).toHaveLength(3);
    expect(out[0]!.isTrailer).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(out[0]!.payload))).toEqual({ id: 1 });
    expect(JSON.parse(new TextDecoder().decode(out[1]!.payload))).toEqual({
      id: 2,
      msg: "hi",
    });
    expect(out[2]!.isTrailer).toBe(true);
    expect(parseGrpcTrailers(out[2]!.payload)).toEqual({
      "grpc-status": "0",
      "grpc-message": "",
      "x-trace-id": "tr_123",
    });

    // Reject oversized frame
    const strictDecoder = new GrpcFrameDecoder(256);
    expect(() =>
      strictDecoder.push(encodeGrpcFrame(new Uint8Array(512))),
    ).toThrow(GrpcException);
  });

  it("formats and parses gRPC timeout headers across all units", () => {
    expect(formatGrpcTimeout(250)).toBe("250m");
    expect(parseGrpcTimeout("250m")).toBe(250);
    expect(parseGrpcTimeout("2S")).toBe(2000);
    expect(parseGrpcTimeout("1M")).toBe(60_000);
    expect(parseGrpcTimeout("1H")).toBe(3_600_000);
    expect(parseGrpcTimeout("5000u")).toBe(5);
    expect(parseGrpcTimeout("invalid")).toBeUndefined();
  });

  it("handles ASCII and binary (-bin) GrpcMetadata values", () => {
    const md = new GrpcMetadata({ "X-Request-Id": "req-1" });
    md.set("trace-bin", new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(md.get("x-request-id")).toBe("req-1");
    expect(Array.from(md.getBuffer("trace-bin")!)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
});

describe("GrpcServer & GrpcClientProxy (Real Live Bun.serve E2E)", () => {
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

  it("executes unary RPC, metadata propagation, GrpcException status codes, and timeouts over live HTTP", async () => {
    const server = new GrpcServer({ host: "127.0.0.1", port: 0, package: "hero" });
    servers.push(server);

    server.addGrpcHandler("HeroService", "FindOne", (data, ctx) => {
      const grpcCtx = ctx as GrpcContext;
      const { id } = data as { id: number };
      const reqId = grpcCtx.getMetadata().get("x-request-id") ?? "none";
      grpcCtx.setResponseMetadata("x-handled-by", "hero-node-1");
      grpcCtx.setResponseMetadata("x-echo-req", reqId);

      if (id === 404) {
        const errMd = new GrpcMetadata({ "x-error-domain": "heroes" });
        throw new GrpcException(
          GrpcStatus.NOT_FOUND,
          `Hero #${id} not found`,
          errMd,
        );
      }
      if (id === 401) {
        throw new GrpcException(
          GrpcStatus.UNAUTHENTICATED,
          "Missing bearer token",
        );
      }
      return { id, name: `Hero-${id}`, reqId };
    });

    server.addGrpcHandler("HeroService", "SlowOp", async (_data, ctx) => {
      const grpcCtx = ctx as GrpcContext;
      await Bun.sleep(250);
      return { aborted: grpcCtx.signal.aborted };
    });

    await server.listen();
    expect(server.port).toBeGreaterThan(0);

    const client = new GrpcClientProxy({
      url: server.url,
      package: "hero",
    });
    clients.push(client);

    // 1. Unary RPC with request & response metadata
    const md = new GrpcMetadata({ "x-request-id": "req-777" });
    const res = await client.callWithMetadata<
      { id: number; name: string; reqId: string },
      { id: number }
    >("HeroService", "FindOne", { id: 7 }, { metadata: md });

    expect(res.status).toBe(GrpcStatus.OK);
    expect(res.data).toEqual({ id: 7, name: "Hero-7", reqId: "req-777" });
    expect(res.metadata.get("x-handled-by")).toBe("hero-node-1");
    expect(res.metadata.get("x-echo-req")).toBe("req-777");

    // 2. Dynamic getService() proxy + standard ClientProxy.send()
    interface HeroServiceClient {
      FindOne(req: { id: number }): Promise<{ id: number; name: string; reqId: string }>;
    }
    const heroSvc = client.getService<HeroServiceClient>("HeroService");
    expect(await heroSvc.FindOne({ id: 9 })).toEqual({
      id: 9,
      name: "Hero-9",
      reqId: "none",
    });
    expect(await client.send("HeroService.FindOne", { id: 12 })).toEqual({
      id: 12,
      name: "Hero-12",
      reqId: "none",
    });

    // 3. GrpcException status code & error metadata mapping
    try {
      await client.call("HeroService", "FindOne", { id: 404 });
      throw new Error("Expected GrpcException");
    } catch (err) {
      expect(err).toBeInstanceOf(GrpcException);
      const gErr = err as GrpcException;
      expect(gErr.code).toBe(GrpcStatus.NOT_FOUND);
      expect(gErr.message).toBe("Hero #404 not found");
      expect(gErr.metadata?.get("x-error-domain")).toBe("heroes");
    }

    try {
      await client.call("HeroService", "FindOne", { id: 401 });
      throw new Error("Expected GrpcException");
    } catch (err) {
      expect(err).toBeInstanceOf(GrpcException);
      expect((err as GrpcException).code).toBe(GrpcStatus.UNAUTHENTICATED);
    }

    // 4. Unimplemented method returns GrpcStatus.UNIMPLEMENTED (12)
    try {
      await client.call("HeroService", "DoesNotExist", {});
      throw new Error("Expected UNIMPLEMENTED");
    } catch (err) {
      expect(err).toBeInstanceOf(GrpcException);
      expect((err as GrpcException).code).toBe(GrpcStatus.UNIMPLEMENTED);
    }

    // 5. Timeout maps to GrpcStatus.DEADLINE_EXCEEDED (4)
    try {
      await client.call("HeroService", "SlowOp", {}, { timeoutMs: 35 });
      throw new Error("Expected DEADLINE_EXCEEDED");
    } catch (err) {
      expect(err).toBeInstanceOf(GrpcException);
      expect((err as GrpcException).code).toBe(GrpcStatus.DEADLINE_EXCEEDED);
    }

    await client.close();
    await server.close();
    expect(server.isListening).toBe(false);
  });

  it("supports server-streaming RPC (AsyncIterable) including mid-stream GrpcException propagation", async () => {
    const server = new GrpcServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    server.addGrpcStreamHandler(
      "TickerService",
      "Subscribe",
      async function* (data) {
        const { count, failAt } = data as { count: number; failAt?: number };
        for (let i = 1; i <= count; i++) {
          if (failAt === i) {
            throw new GrpcException(
              GrpcStatus.PERMISSION_DENIED,
              `Denied at tick ${i}`,
            );
          }
          await Bun.sleep(5);
          yield { seq: i, value: i * 10 };
        }
      },
    );

    await server.listen();

    const client = new GrpcClientProxy({ url: server.url });
    clients.push(client);

    // 1. Clean stream completion
    const received: Array<{ seq: number; value: number }> = [];
    for await (const item of client.stream<{ seq: number; value: number }>(
      "TickerService",
      "Subscribe",
      { count: 4 },
    )) {
      received.push(item);
    }
    expect(received).toEqual([
      { seq: 1, value: 10 },
      { seq: 2, value: 20 },
      { seq: 3, value: 30 },
      { seq: 4, value: 40 },
    ]);

    // 2. Mid-stream GrpcException delivered via 0x80 trailer frame
    const partial: number[] = [];
    let caughtErr: unknown;
    try {
      for await (const item of client.stream<{ seq: number }>(
        "TickerService",
        "Subscribe",
        { count: 5, failAt: 3 },
      )) {
        partial.push(item.seq);
      }
    } catch (err) {
      caughtErr = err;
    }
    expect(partial).toEqual([1, 2]);
    expect(caughtErr).toBeInstanceOf(GrpcException);
    expect((caughtErr as GrpcException).code).toBe(GrpcStatus.PERMISSION_DENIED);
    expect((caughtErr as GrpcException).message).toBe("Denied at tick 3");
  });

  it("supports custom binary Protobuf GrpcCodec (application/grpc+proto) for unary and streaming RPCs", async () => {
    // Compact hand-rolled protobuf-like wire codec:
    // field 1 (varint/uint32 id): tag 0x08 + 4-byte uint32
    // field 2 (length-delimited utf8 label): tag 0x12 + uint16 len + bytes
    const binaryProtoCodec: GrpcCodec = {
      contentType: "application/grpc+proto",
      encode(value: unknown): Uint8Array {
        const obj = value as { id: number; label: string };
        const strBytes = new TextEncoder().encode(obj.label ?? "");
        const buf = new Uint8Array(1 + 4 + 1 + 2 + strBytes.byteLength);
        const view = new DataView(buf.buffer);
        buf[0] = 0x08;
        view.setUint32(1, obj.id >>> 0, false);
        buf[5] = 0x12;
        view.setUint16(6, strBytes.byteLength, false);
        buf.set(strBytes, 8);
        return buf;
      },
      decode<T = unknown>(bytes: Uint8Array): T {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes[0] !== 0x08 || bytes[5] !== 0x12) {
          throw new Error("Invalid binary protobuf wire tag");
        }
        const id = view.getUint32(1, false);
        const len = view.getUint16(6, false);
        const label = new TextDecoder().decode(bytes.subarray(8, 8 + len));
        return { id, label } as T;
      },
    };

    const server = new GrpcServer({
      host: "127.0.0.1",
      port: 0,
      codec: binaryProtoCodec,
    });
    servers.push(server);

    server.addGrpcHandler("ProtoService", "Echo", (data) => {
      const item = data as { id: number; label: string };
      return { id: item.id + 1, label: `proto:${item.label}` };
    });

    server.addGrpcStreamHandler(
      "ProtoService",
      "StreamItems",
      async function* (data) {
        const item = data as { id: number; label: string };
        for (let i = 0; i < 3; i++) {
          yield { id: item.id + i, label: `${item.label}#${i}` };
        }
      },
    );

    await server.listen();

    const client = new GrpcClientProxy({
      url: server.url,
      codec: binaryProtoCodec,
    });
    clients.push(client);

    const unary = await client.call<{ id: number; label: string }>(
      "ProtoService",
      "Echo",
      { id: 41, label: "bunest" },
    );
    expect(unary).toEqual({ id: 42, label: "proto:bunest" });

    const streamed: Array<{ id: number; label: string }> = [];
    for await (const msg of client.stream<{ id: number; label: string }>(
      "ProtoService",
      "StreamItems",
      { id: 10, label: "bin" },
    )) {
      streamed.push(msg);
    }
    expect(streamed).toEqual([
      { id: 10, label: "bin#0" },
      { id: 11, label: "bin#1" },
      { id: 12, label: "bin#2" },
    ]);
  });

  it("discovers @GrpcMethod and @GrpcStreamMethod via MicroserviceModule with Guards & ClientsModule", async () => {
    @Injectable()
    class GrpcApiKeyGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const rpcCtx = context.switchToRpc().getContext<GrpcContext>();
        return rpcCtx.getMetadata().get("x-api-key") === "top-secret";
      }
    }

    @Controller()
    class CatalogGrpcController {
      @UseGuards(GrpcApiKeyGuard)
      @GrpcMethod("CatalogService")
      getItem(@Payload() data: { sku: string }, @Ctx() ctx: GrpcContext) {
        ctx.setResponseMetadata("x-catalog-region", "us-east");
        return { sku: data.sku, price: 2999 };
      }

      @GrpcStreamMethod("CatalogService", "WatchPrices")
      async *watchPrices(@Payload() data: { sku: string }) {
        yield { sku: data.sku, price: 2999 };
        yield { sku: data.sku, price: 2499 };
      }
    }

    const GRPC_CLIENT = Symbol("GRPC_CLIENT");

    @Injectable()
    class CatalogConsumer {
      constructor(
        @Inject(GRPC_CLIENT) public readonly client: GrpcClientProxy,
      ) {}
    }

    const serverMod = await Test.createTestingModule({
      imports: [
        MicroserviceModule.forRoot({
          transport: Transport.GRPC,
          options: { host: "127.0.0.1", port: 0 },
        }),
      ],
      controllers: [CatalogGrpcController],
      providers: [GrpcApiKeyGuard],
    }).compile();
    await serverMod.init();

    const boundServer = serverMod.get<GrpcServer>(MICROSERVICE_SERVER);
    expect(boundServer.port).toBeGreaterThan(0);

    const clientMod = await Test.createTestingModule({
      imports: [
        ClientsModule.register([
          {
            name: GRPC_CLIENT,
            transport: Transport.GRPC,
            options: { url: boundServer.url },
          },
        ]),
      ],
      providers: [CatalogConsumer],
    }).compile();
    await clientMod.init();

    const { client } = clientMod.get(CatalogConsumer);

    // Authorized call passes guard and returns response metadata
    const okRes = await client.callWithMetadata<{ sku: string; price: number }>(
      "CatalogService",
      "GetItem",
      { sku: "BUN-1" },
      { metadata: { "x-api-key": "top-secret" } },
    );
    expect(okRes.data).toEqual({ sku: "BUN-1", price: 2999 });
    expect(okRes.metadata.get("x-catalog-region")).toBe("us-east");

    // Unauthorized call rejected with PERMISSION_DENIED (from RpcException 403)
    try {
      await client.call("CatalogService", "GetItem", { sku: "BUN-1" });
      throw new Error("Expected guard rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GrpcException);
      expect((err as GrpcException).code).toBe(GrpcStatus.PERMISSION_DENIED);
    }

    // @GrpcStreamMethod streams cleanly
    const prices: Array<{ sku: string; price: number }> = [];
    for await (const p of client.stream<{ sku: string; price: number }>(
      "CatalogService",
      "WatchPrices",
      { sku: "BUN-1" },
    )) {
      prices.push(p);
    }
    expect(prices).toEqual([
      { sku: "BUN-1", price: 2999 },
      { sku: "BUN-1", price: 2499 },
    ]);

    await clientMod.close();
    await serverMod.close();
    expect(boundServer.isListening).toBe(false);
  });

  it("hardens against trailer CRLF/status spoofing, rejects truncated frames with DATA_LOSS, aborts blocked server streams on grpc-timeout, and retries UNAVAILABLE", async () => {
    const server = new GrpcServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    // 1. Metadata CRLF / grpc-status spoofing must never override real error status
    server.addGrpcHandler("SecService", "Spoof", (_data, ctx) => {
      const gCtx = ctx as GrpcContext;
      gCtx.setResponseMetadata("x-echo", "ok\r\ngrpc-status: 0");
      gCtx.setResponseMetadata("grpc-status", "0");
      throw new GrpcException(GrpcStatus.PERMISSION_DENIED, "real-denied");
    });

    // 2. Blocked server stream must be interrupted promptly by grpc-timeout (not wait 600ms!)
    let streamCleanupCalled = false;
    server.addGrpcStreamHandler(
      "SecService",
      "BlockedStream",
      async function* (_data, ctx) {
        const signal = (ctx as GrpcContext).signal;
        try {
          yield { tick: 1 };
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            const timer = setTimeout(resolve, 600);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          if (!signal.aborted) {
            yield { tick: 2 };
          }
        } finally {
          streamCleanupCalled = true;
        }
      },
    );

    // 3. Transient UNAVAILABLE retried by ClientProxy.send(..., { retries: 2 })
    let attempts = 0;
    server.addGrpcHandler("SecService", "Flaky", () => {
      attempts++;
      if (attempts === 1) {
        throw new GrpcException(GrpcStatus.UNAVAILABLE, "temporary-unavailable");
      }
      return { recovered: true, attempts };
    });

    await server.listen();

    const client = new GrpcClientProxy({ url: server.url });
    clients.push(client);

    // Verify spoofing blocked
    try {
      await client.call("SecService", "Spoof", {});
      throw new Error("Expected PERMISSION_DENIED");
    } catch (err) {
      expect(err).toBeInstanceOf(GrpcException);
      expect((err as GrpcException).code).toBe(GrpcStatus.PERMISSION_DENIED);
      expect((err as GrpcException).message).toBe("real-denied");
    }

    // Verify blocked stream aborted promptly by deadline
    const t0 = performance.now();
    const seen: number[] = [];
    let streamErr: unknown;
    try {
      for await (const item of client.stream<{ tick: number }>(
        "SecService",
        "BlockedStream",
        {},
        { timeoutMs: 50 },
      )) {
        seen.push(item.tick);
      }
    } catch (err) {
      streamErr = err;
    }
    const elapsed = performance.now() - t0;
    expect(seen).toEqual([1]);
    expect(streamErr).toBeInstanceOf(GrpcException);
    expect((streamErr as GrpcException).code).toBe(GrpcStatus.DEADLINE_EXCEEDED);
    expect(elapsed).toBeLessThan(250);
    await Bun.sleep(20);
    expect(streamCleanupCalled).toBe(true);

    // Verify UNAVAILABLE is retried by send()
    const recovered = await client.send<{ recovered: boolean; attempts: number }>(
      "SecService.Flaky",
      {},
      { retries: 2, retryDelayMs: 10 },
    );
    expect(recovered).toEqual({ recovered: true, attempts: 2 });

    // Verify truncated gRPC frame throws DATA_LOSS
    const rawTruncServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        // Claims 20 bytes in 5-byte header, but only sends 3 payload bytes
        const truncated = new Uint8Array([0, 0, 0, 0, 20, 123, 34, 97]);
        return new Response(truncated, {
          status: 200,
          headers: {
            "content-type": "application/grpc+json",
            "grpc-status": "0",
            "grpc-message": "%E0%A4%A", // malformed percent encoding too!
          },
        });
      },
    });
    try {
      const truncClient = new GrpcClientProxy({
        url: `http://127.0.0.1:${rawTruncServer.port}`,
      });
      clients.push(truncClient);
      try {
        await truncClient.call("Any", "Trunc", {});
        throw new Error("Expected DATA_LOSS");
      } catch (err) {
        expect(err).toBeInstanceOf(GrpcException);
        expect((err as GrpcException).code).toBe(GrpcStatus.DATA_LOSS);
      }
    } finally {
      await rawTruncServer.stop(true);
    }
  });
});
