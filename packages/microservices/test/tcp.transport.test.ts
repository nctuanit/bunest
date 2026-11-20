import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import {
  Catch,
  Controller,
  Inject,
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
} from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  ClientsModule,
  Ctx,
  EventPattern,
  FrameDecoder,
  MICROSERVICE_SERVER,
  MessagePattern,
  MicroserviceModule,
  Payload,
  RpcException,
  RpcTimeoutException,
  TcpClientProxy,
  TcpServer,
  Transport,
  encodeFrame,
  type ClientProxy,
  type RpcContext,
} from "../src/index";

describe("FrameDecoder (TCP Length-Prefixed JSON Framing)", () => {
  it("handles 1-byte fragmentation, coalesced frames, UTF-8 payloads, and maxFrameBytes", () => {
    const f1 = encodeFrame({ id: "1", text: "héllo 🚀" });
    const f2 = encodeFrame({ id: "2", nums: [1, 2, 3] });
    const combined = Buffer.concat([f1, f2]);

    // Push 1 byte at a time (extreme fragmentation)
    const decoder1 = new FrameDecoder();
    const out1: unknown[] = [];
    for (let i = 0; i < combined.length; i++) {
      out1.push(...decoder1.push(combined.subarray(i, i + 1)));
    }
    expect(out1).toEqual([
      { id: "1", text: "héllo 🚀" },
      { id: "2", nums: [1, 2, 3] },
    ]);

    // Push both frames coalesced in a single chunk
    const decoder2 = new FrameDecoder();
    expect(decoder2.push(combined)).toEqual([
      { id: "1", text: "héllo 🚀" },
      { id: "2", nums: [1, 2, 3] },
    ]);

    // Reject oversized frame cleanly
    const strictDecoder = new FrameDecoder(1024);
    const huge = encodeFrame({ data: "x".repeat(2048) });
    expect(() => strictDecoder.push(huge)).toThrow(/exceeds limit/);
  });
});

describe("TcpServer & TcpClientProxy (Real Bun.listen / Bun.connect E2E)", () => {
  const servers: TcpServer[] = [];
  const clients: TcpClientProxy[] = [];

  afterEach(async () => {
    while (clients.length > 0) {
      await clients.pop()!.close();
    }
    while (servers.length > 0) {
      await servers.pop()!.close();
    }
  });

  it("handles RPC request-reply, large fragmented payloads, concurrent multiplexing, events, and RpcException", async () => {
    const server = new TcpServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    const receivedEvents: unknown[] = [];

    server.addMessageHandler({ cmd: "sum", v: 1 }, (data: unknown) => {
      const nums = data as number[];
      return nums.reduce((a, b) => a + b, 0);
    });

    server.addMessageHandler("echo-large", (data: unknown) => data);

    server.addMessageHandler(
      "delayed",
      async (data: unknown) => {
        const { id, ms } = data as { id: string; ms: number };
        await Bun.sleep(ms);
        return `done:${id}`;
      },
    );

    server.addMessageHandler("fail-rpc", () => {
      throw new RpcException({ status: 422, message: "Invalid input", field: "email" });
    });

    server.addEventHandler("user.created", (data) => {
      receivedEvents.push(data);
    });

    await server.listen();
    expect(server.port).toBeGreaterThan(0);

    const client = new TcpClientProxy({
      host: "127.0.0.1",
      port: server.port!,
    });
    clients.push(client);
    await client.connect();

    // Canonical object pattern matching regardless of key order
    const sum = await client.send<number>({ v: 1, cmd: "sum" }, [10, 20, 30]);
    expect(sum).toBe(60);

    // Large ~256 KB payload forcing TCP packet fragmentation
    const largePayload = {
      blob: "Bunest-TCP-Fragment-".repeat(13_000),
      checksum: 256_000,
    };
    const echoed = await client.send<typeof largePayload>("echo-large", largePayload);
    expect(echoed.blob.length).toBe(largePayload.blob.length);
    expect(echoed.checksum).toBe(256_000);

    // Concurrent multiplexed requests finishing out-of-order on single TCP socket
    const [rSlow, rFast, rMid] = await Promise.all([
      client.send<string>("delayed", { id: "slow", ms: 40 }),
      client.send<string>("delayed", { id: "fast", ms: 5 }),
      client.send<string>("delayed", { id: "mid", ms: 20 }),
    ]);
    expect([rSlow, rFast, rMid]).toEqual(["done:slow", "done:fast", "done:mid"]);

    // Fire-and-forget event
    await client.emit("user.created", { id: "u_1", email: "ada@bunest.dev" });
    await Bun.sleep(25);
    expect(receivedEvents).toEqual([{ id: "u_1", email: "ada@bunest.dev" }]);

    // Structured RpcException propagation
    try {
      await client.send("fail-rpc", {});
      throw new Error("Expected RpcException");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcException);
      expect((err as RpcException).getError()).toEqual({
        status: 422,
        message: "Invalid input",
        field: "email",
      });
    }
  });

  it("handles per-request timeout and retries on transient transport/handler faults", async () => {
    const server = new TcpServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);

    let attempts = 0;
    server.addMessageHandler("flaky-op", () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("transient-db-glitch");
      }
      return { ok: true, attempts };
    });

    server.addMessageHandler("hang", async () => {
      await Bun.sleep(200);
      return "never";
    });

    await server.listen();

    const client = new TcpClientProxy({
      host: "127.0.0.1",
      port: server.port!,
    });
    clients.push(client);

    // Retry succeeds on 2nd attempt
    const res = await client.send<{ ok: boolean; attempts: number }>(
      "flaky-op",
      {},
      { retries: 2, retryDelayMs: 10 },
    );
    expect(res).toEqual({ ok: true, attempts: 2 });

    // Timeout throws RpcTimeoutException
    await expect(
      client.send("hang", {}, { timeoutMs: 25 }),
    ).rejects.toBeInstanceOf(RpcTimeoutException);

    // Server restart -> client auto-reconnects on retry and succeeds
    const boundPort = server.port!;
    await server.close();
    const restartedServer = new TcpServer({ host: "127.0.0.1", port: boundPort });
    servers.push(restartedServer);
    restartedServer.addMessageHandler("ping-after-restart", () => "alive");
    await restartedServer.listen();

    const recovered = await client.send<string>(
      "ping-after-restart",
      {},
      { retries: 2, retryDelayMs: 15 },
    );
    expect(recovered).toBe("alive");
  });

  it("discovers @MessagePattern/@EventPattern via MicroserviceModule with Guards, Pipes, Interceptors, Filters & ClientsModule", async () => {
    const eventsSeen: Array<{ data: unknown; transport: Transport }> = [];

    @Injectable()
    class RpcAuthGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        expect(context.getType()).toBe("rpc");
        const data = context.switchToRpc().getData<{ token?: string }>();
        return data?.token === "secret";
      }
    }

    @Injectable()
    class TrimPipe implements PipeTransform {
      transform(value: unknown) {
        return typeof value === "string" ? value.trim().toUpperCase() : value;
      }
    }

    @Injectable()
    class WrapInterceptor implements BunestInterceptor {
      async intercept(_context: ExecutionContext, next: CallHandler) {
        const result = await next.handle();
        return { wrapped: result };
      }
    }

    @Catch(RpcException)
    class CustomRpcFilter implements ExceptionFilter<RpcException> {
      catch(exception: RpcException, _host: ArgumentsHost) {
        return { recoveredFrom: exception.message };
      }
    }

    @Controller()
    class MathRpcController {
      @UseGuards(RpcAuthGuard)
      @UseInterceptors(WrapInterceptor)
      @MessagePattern({ cmd: "greet" })
      greet(
        @Payload("name", TrimPipe) name: string,
        @Ctx() ctx: RpcContext,
      ) {
        return `HELLO ${name} via ${ctx.transport}`;
      }

      @UseFilters(CustomRpcFilter)
      @MessagePattern("filtered-err")
      triggerError() {
        throw new RpcException("handled-by-filter");
      }

      @MessagePattern("extract-prop")
      extractProp(@Payload("userId") userId: unknown) {
        return { userId: userId === undefined ? "__UNDEFINED__" : userId };
      }

      @EventPattern("audit.log")
      onAudit(@Payload() data: unknown, @Ctx() ctx: RpcContext) {
        eventsSeen.push({ data, transport: ctx.transport });
      }
    }

    const tcpServer = new TcpServer({ host: "127.0.0.1", port: 0 });
    const RPC_CLIENT = Symbol("RPC_CLIENT");

    @Injectable()
    class ClientConsumer {
      constructor(@Inject(RPC_CLIENT) public readonly client: ClientProxy) {}
    }

    const serverMod = await Test.createTestingModule({
      imports: [MicroserviceModule.forRoot({ server: tcpServer })],
      controllers: [MathRpcController],
      providers: [RpcAuthGuard, TrimPipe, WrapInterceptor, CustomRpcFilter],
    }).compile();
    await serverMod.init();

    const boundServer = serverMod.get<TcpServer>(MICROSERVICE_SERVER);
    expect(boundServer.port).toBeGreaterThan(0);

    const clientMod = await Test.createTestingModule({
      imports: [
        ClientsModule.registerAsync([
          {
            name: RPC_CLIENT,
            useFactory: () => ({
              transport: Transport.TCP,
              options: { host: "127.0.0.1", port: boundServer.port! },
            }),
          },
        ]),
      ],
      providers: [ClientConsumer],
    }).compile();
    await clientMod.init();

    const { client } = clientMod.get(ClientConsumer);

    // Guard passes + @Payload("name", TrimPipe) + @Ctx() + @UseInterceptors
    const greeting = await client.send<{ wrapped: string }>(
      { cmd: "greet" },
      { token: "secret", name: "  bunest  " },
    );
    expect(greeting).toEqual({ wrapped: "HELLO BUNEST via TCP" });

    // Guard blocks unauthorized call
    await expect(
      client.send({ cmd: "greet" }, { token: "wrong", name: "x" }),
    ).rejects.toBeInstanceOf(RpcException);

    // Filter catches RpcException and returns recovered payload
    const recovered = await client.send("filtered-err", {});
    expect(recovered).toEqual({ recoveredFrom: "handled-by-filter" });

    // @Payload("userId") returns undefined (NOT the whole primitive/null data) when payload isn't an object
    expect(await client.send("extract-prop", { userId: "u_9" })).toEqual({
      userId: "u_9",
    });
    expect(await client.send("extract-prop", "not-an-object")).toEqual({
      userId: "__UNDEFINED__",
    });
    expect(await client.send("extract-prop", null)).toEqual({
      userId: "__UNDEFINED__",
    });
    expect(await client.send("extract-prop", 42)).toEqual({
      userId: "__UNDEFINED__",
    });

    // Event pattern
    await client.emit("audit.log", { action: "login" });
    await Bun.sleep(25);
    expect(eventsSeen).toEqual([
      { data: { action: "login" }, transport: Transport.TCP },
    ]);

    // Graceful shutdown closes client sockets & stops TCP listener
    await clientMod.close();
    await serverMod.close();
    expect(boundServer.isListening).toBe(false);
  });
});
