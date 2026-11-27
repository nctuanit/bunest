import { describe, expect, it } from "bun:test";
import {
  BunestFactory,
  ClsModule,
  ClsService,
  Controller,
  Module,
  diagnosticsChannel,
  registerAmbientTraceparentProvider,
} from "@bunest/core";
import {
  CircuitOpenError,
  ClientProxy,
  Ctx,
  EventPattern,
  InMemoryBroker,
  InMemoryClientProxy,
  InMemoryServer,
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  Payload,
  RPC_CLIENT_CHANNEL,
  RPC_SERVER_CHANNEL,
  RpcException,
  TcpClientProxy,
  TcpServer,
  Transport,
  type CircuitBreakerState,
  type MicroserviceDeadLetterContext,
  type RpcContext,
  type RpcDiagnosticEvent,
} from "../src";

class FlakyMockClient extends ClientProxy {
  public readonly transport = Transport.IN_MEMORY;
  public sendAttempts = 0;
  public attemptTimestamps: number[] = [];

  constructor(
    private readonly handler: (
      pattern: string,
      data: unknown,
      attempt: number,
      metadata?: Record<string, unknown>,
    ) => Promise<unknown>,
    options?: ConstructorParameters<typeof ClientProxy>[1],
  ) {
    super(5000, options);
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  protected override async sendOnce<TRes = any, TReq = any>(
    pattern: string,
    data: TReq,
    _timeoutMs: number,
    _signal?: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<TRes> {
    this.sendAttempts++;
    this.attemptTimestamps.push(performance.now());
    return (await this.handler(
      pattern,
      data,
      this.sendAttempts,
      metadata,
    )) as TRes;
  }

  protected override async dispatchEvent(): Promise<void> {}
}

describe("Microservices Wave 2 — Resilience, CLS/Traceparent Propagation, Diagnostics & DLQ", () => {
  describe("1. Resilient ClientProxy — Exponential Backoff + Jitter Retry", () => {
    it("retries transient failures with capped exponential backoff (jitter: false) and succeeds", async () => {
      const client = new FlakyMockClient(
        async (_pattern, _data, attempt) => {
          if (attempt < 4) {
            throw new Error(`transient network error #${attempt}`);
          }
          return { recoveredOn: attempt };
        },
        {
          retry: {
            attempts: 4,
            backoffMs: 15,
            maxBackoffMs: 35,
            jitter: false,
          },
        },
      );

      const res = await client.send<{ recoveredOn: number }>("jobs.run", {});
      expect(res.recoveredOn).toBe(4);
      expect(client.sendAttempts).toBe(4);

      // Verify exponential progression: gap1 >= ~10ms (15ms), gap2 >= ~20ms (30ms), gap3 capped at 35ms
      const t = client.attemptTimestamps;
      expect(t).toHaveLength(4);
      const gap1 = t[1]! - t[0]!;
      const gap2 = t[2]! - t[1]!;
      const gap3 = t[3]! - t[2]!;
      expect(gap1).toBeGreaterThanOrEqual(8);
      expect(gap2).toBeGreaterThanOrEqual(gap1 * 1.2);
      expect(gap3).toBeLessThan(120);
    });

    it("supports jitter: true and custom retryOn predicate", async () => {
      const nonRetryableErr = new Error("DO_NOT_RETRY");
      const retryableErr = new Error("RETRY_ME");

      const client = new FlakyMockClient(
        async (pattern, _data, attempt) => {
          if (pattern === "retryable") {
            if (attempt < 3) throw retryableErr;
            return "ok-jitter";
          }
          throw nonRetryableErr;
        },
        {
          retry: {
            attempts: 4,
            backoffMs: 10,
            maxBackoffMs: 40,
            jitter: true,
            retryOn: (err) => err instanceof Error && err.message === "RETRY_ME",
          },
        },
      );

      expect(await client.send("retryable", {})).toBe("ok-jitter");
      expect(client.sendAttempts).toBe(3);

      client.sendAttempts = 0;
      await expect(client.send("fatal", {})).rejects.toThrow("DO_NOT_RETRY");
      expect(client.sendAttempts).toBe(1);
    });

    it("keeps legacy send(..., { retries, retryDelayMs }) and non-retryable RpcException 100% backward compatible", async () => {
      const client = new FlakyMockClient(async (pattern, _data, attempt) => {
        if (pattern === "biz-error") {
          throw new RpcException({ status: 400, message: "Invalid payload" });
        }
        if (attempt < 3) throw new Error("socket reset");
        return "legacy-ok";
      });

      expect(
        await client.send("transient", {}, { retries: 2, retryDelayMs: 5 }),
      ).toBe("legacy-ok");
      expect(client.sendAttempts).toBe(3);

      client.sendAttempts = 0;
      await expect(
        client.send("biz-error", {}, { retries: 3, retryDelayMs: 5 }),
      ).rejects.toBeInstanceOf(RpcException);
      expect(client.sendAttempts).toBe(1);
    });
  });

  describe("2. Resilient ClientProxy — Circuit Breaker State Machine", () => {
    it("transitions closed -> open -> half-open -> open (on probe fail) -> half-open -> closed (on probe success)", async () => {
      let shouldFail = true;
      const transitions: Array<[CircuitBreakerState, CircuitBreakerState]> = [];

      const client = new FlakyMockClient(
        async () => {
          if (shouldFail) {
            throw new Error("downstream unavailable");
          }
          return { healthy: true };
        },
        {
          circuitBreaker: {
            failureThreshold: 2,
            resetTimeoutMs: 45,
            halfOpenMaxCalls: 1,
            onStateChange: (from, to) => transitions.push([from, to]),
          },
        },
      );

      expect(client.getCircuitBreakerState()).toBe("closed");

      // Failure 1 -> stays closed
      await expect(client.send("payments.charge", {})).rejects.toThrow(
        "downstream unavailable",
      );
      expect(client.getCircuitBreakerState()).toBe("closed");

      // Failure 2 -> opens circuit
      await expect(client.send("payments.charge", {})).rejects.toThrow(
        "downstream unavailable",
      );
      expect(client.getCircuitBreakerState()).toBe("open");
      expect(client.sendAttempts).toBe(2);

      // Call while open -> fast-fails with CircuitOpenError (which is also RpcException!) without calling transport
      let caughtOpen: unknown;
      try {
        await client.send("payments.charge", {});
      } catch (err) {
        caughtOpen = err;
      }
      expect(caughtOpen).toBeInstanceOf(CircuitOpenError);
      expect(caughtOpen).toBeInstanceOf(RpcException);
      expect(client.sendAttempts).toBe(2);

      // Wait for resetTimeoutMs -> enters half-open
      await Bun.sleep(55);
      expect(client.getCircuitBreakerState()).toBe("half-open");

      // Failing probe re-opens the circuit
      await expect(client.send("payments.charge", {})).rejects.toThrow(
        "downstream unavailable",
      );
      expect(client.getCircuitBreakerState()).toBe("open");
      expect(client.sendAttempts).toBe(3);

      // Wait again -> recover service -> successful probe closes circuit
      await Bun.sleep(55);
      shouldFail = false;
      const result = await client.send<{ healthy: boolean }>(
        "payments.charge",
        {},
      );
      expect(result.healthy).toBe(true);
      expect(client.getCircuitBreakerState()).toBe("closed");
      expect(transitions).toEqual([
        ["closed", "open"],
        ["open", "half-open"],
        ["half-open", "open"],
        ["open", "half-open"],
        ["half-open", "closed"],
      ]);
    });

    it("rejects excess concurrent half-open probe calls with CircuitOpenError", async () => {
      let releaseProbe!: () => void;
      let mode: "fail" | "hang" = "fail";

      const client = new FlakyMockClient(
        async () => {
          if (mode === "fail") throw new Error("boom");
          await new Promise<void>((resolve) => {
            releaseProbe = resolve;
          });
          return "probe-ok";
        },
        {
          circuitBreaker: {
            failureThreshold: 1,
            resetTimeoutMs: 30,
            halfOpenMaxCalls: 1,
          },
        },
      );

      await expect(client.send("svc.op", {})).rejects.toThrow("boom");
      expect(client.getCircuitBreakerState()).toBe("open");

      await Bun.sleep(40);
      mode = "hang";

      const probe1 = client.send("svc.op", {});
      // While probe1 is in-flight, a second call must be rejected with CircuitOpenError
      await expect(client.send("svc.op", {})).rejects.toBeInstanceOf(
        CircuitOpenError,
      );

      releaseProbe();
      expect(await probe1).toBe("probe-ok");
      expect(client.getCircuitBreakerState()).toBe("closed");
    });

    it("does not trip circuit breaker on non-retryable business RpcException by default", async () => {
      const client = new FlakyMockClient(
        async () => {
          throw new RpcException({ status: 404, message: "Not found" });
        },
        {
          circuitBreaker: {
            failureThreshold: 1,
            resetTimeoutMs: 1000,
          },
        },
      );

      await expect(client.send("users.find", {})).rejects.toBeInstanceOf(
        RpcException,
      );
      expect(client.getCircuitBreakerState()).toBe("closed");
    });
  });

  describe("3. Cross-Transport CLS + W3C traceparent Propagation & diagnosticsChannel Emission", () => {
    it("propagates CLS keys, ambient W3C traceparent, and user metadata over TCP and emits bunest:rpc:client & bunest:rpc:server diagnostics", async () => {
      const cls = new ClsService();
      const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
      const disposeTp = registerAmbientTraceparentProvider(() => traceparent);

      const clientEvents: RpcDiagnosticEvent[] = [];
      const serverEvents: RpcDiagnosticEvent[] = [];
      const clientListener = (msg: unknown) =>
        clientEvents.push(msg as RpcDiagnosticEvent);
      const serverListener = (msg: unknown) =>
        serverEvents.push(msg as RpcDiagnosticEvent);

      diagnosticsChannel(RPC_CLIENT_CHANNEL).subscribe(clientListener);
      diagnosticsChannel(RPC_SERVER_CHANNEL).subscribe(serverListener);

      let eventObservedCls: Record<string, unknown> | undefined;
      let eventObservedMeta: Readonly<Record<string, unknown>> | undefined;

      @Controller()
      class OrdersRpcController {
        constructor(private readonly injectedCls: ClsService) {}

        @MessagePattern("orders.create")
        createOrder(
          @Payload() payload: { sku: string },
          @Ctx() ctx: RpcContext,
        ) {
          return {
            sku: payload.sku,
            tenantId: this.injectedCls.get("tenantId"),
            userId: this.injectedCls.get("userId"),
            correlationId: this.injectedCls.get("correlationId"),
            requestId: this.injectedCls.get("requestId"),
            traceparent: this.injectedCls.get("traceparent"),
            customMeta: ctx.metadata?.["x-custom"],
          };
        }

        @EventPattern("orders.audited")
        onAudited(@Payload() _payload: unknown, @Ctx() ctx: RpcContext) {
          eventObservedCls = {
            tenantId: this.injectedCls.get("tenantId"),
            userId: this.injectedCls.get("userId"),
            traceparent: this.injectedCls.get("traceparent"),
          };
          eventObservedMeta = ctx.metadata;
        }
      }

      const server = new TcpServer({ host: "127.0.0.1", port: 0 });

      @Module({
        imports: [
          ClsModule.forRoot({ global: true }),
          MicroserviceModule.forRoot({ server }),
        ],
        controllers: [OrdersRpcController],
      })
      class RpcAppModule {}

      const app = await BunestFactory.create(RpcAppModule, { logger: false });
      const host = app.get(MicroserviceHost);
      await host.listen();
      const client = new TcpClientProxy({
        host: "127.0.0.1",
        port: server.port!,
      });

      try {
        await client.connect();

        const response = await cls.run(
          async () =>
            await client.send<Record<string, unknown>>(
              "orders.create",
              { sku: "WIDGET-1" },
              { metadata: { "x-custom": "preserve-me" } },
            ),
          {
            tenantId: "tenant-tcp",
            userId: "user-99",
            correlationId: "corr-tcp-1",
            requestId: "req-tcp-77",
          },
        );

        expect(response).toEqual({
          sku: "WIDGET-1",
          tenantId: "tenant-tcp",
          userId: "user-99",
          correlationId: "corr-tcp-1",
          requestId: "req-tcp-77",
          traceparent,
          customMeta: "preserve-me",
        });

        await cls.run(
          async () => {
            await client.emit(
              "orders.audited",
              { id: "ord-1" },
              { metadata: { "x-origin": "checkout" } },
            );
          },
          {
            tenantId: "tenant-evt",
            userId: "user-evt",
          },
        );

        // Give TCP frame brief tick to arrive & finish event handler
        await Bun.sleep(40);
        expect(eventObservedCls).toEqual({
          tenantId: "tenant-evt",
          userId: "user-evt",
          traceparent,
        });
        expect(eventObservedMeta?.["x-origin"]).toBe("checkout");

        // Verify diagnosticsChannel("bunest:rpc:client") & ("bunest:rpc:server") events
        expect(
          clientEvents.some(
            (e) =>
              e.phase === "end" &&
              e.kind === "request" &&
              e.pattern === "orders.create" &&
              e.transport === "TCP" &&
              e.traceparent === traceparent &&
              typeof e.durationMs === "number",
          ),
        ).toBe(true);
        expect(
          serverEvents.some(
            (e) =>
              e.phase === "end" &&
              e.kind === "request" &&
              e.pattern === "orders.create" &&
              e.transport === "TCP" &&
              e.traceparent === traceparent &&
              typeof e.durationMs === "number",
          ),
        ).toBe(true);
        expect(
          serverEvents.some(
            (e) =>
              e.phase === "end" &&
              e.kind === "event" &&
              e.pattern === "orders.audited" &&
              e.traceparent === traceparent,
          ),
        ).toBe(true);
      } finally {
        diagnosticsChannel(RPC_CLIENT_CHANNEL).unsubscribe(clientListener);
        diagnosticsChannel(RPC_SERVER_CHANNEL).unsubscribe(serverListener);
        disposeTp();
        await client.close();
        await app.close();
      }
    });

    it("preserves CloudEvents traceparent compatibility over TCP wireFormat: cloudevents", async () => {
      const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";
      const disposeTp = registerAmbientTraceparentProvider(() => traceparent);
      const server = new TcpServer({
        host: "127.0.0.1",
        port: 0,
        wireFormat: "cloudevents",
      });

      let receivedTraceparent: unknown;
      server.addMessageHandler("ce.ping", (_data, ctx) => {
        receivedTraceparent = ctx.metadata?.traceparent;
        return { pong: true };
      });
      await server.listen();

      const client = new TcpClientProxy({
        host: "127.0.0.1",
        port: server.port!,
        wireFormat: "cloudevents",
      });

      try {
        const res = await client.send<{ pong: boolean }>("ce.ping", { hi: 1 });
        expect(res.pong).toBe(true);
        expect(receivedTraceparent).toBe(traceparent);
      } finally {
        disposeTp();
        await client.close();
        await server.close();
      }
    });
  });

  describe("4. Poison-Message Dead-Letter Handler for @EventPattern()", () => {
    it("invokes deadLetterHandler with pattern, data, metadata, error, transport, timestamp and survives throwing DLQ handlers", async () => {
      const deadLetters: MicroserviceDeadLetterContext[] = [];
      let healthyEventsHandled = 0;
      let shouldThrowInDlq = false;

      const broker = new InMemoryBroker();

      @Controller()
      class EventsController {
        @EventPattern("invoice.poison")
        handlePoison(@Payload() payload: { id: string }) {
          throw new Error(`poison payload ${payload.id}`);
        }

        @EventPattern("invoice.ok")
        handleHealthy() {
          healthyEventsHandled++;
        }
      }

      @Module({
        imports: [
          MicroserviceModule.forRoot({
            transport: Transport.IN_MEMORY,
            options: { channel: "dlq-test", broker },
          }),
        ],
        controllers: [EventsController],
      })
      class DlqApp {}

      const app = await BunestFactory.create(DlqApp, { logger: false });
      const host = app.get(MicroserviceHost);
      host.setDeadLetterHandler(async (ctx) => {
        deadLetters.push(ctx);
        if (shouldThrowInDlq) {
          throw new Error("DLQ storage temporarily unreachable");
        }
      });
      await host.listen();

      const client = new InMemoryClientProxy({ channel: "dlq-test", broker });

      try {
        await client.emit(
          "invoice.poison",
          { id: "inv-1" },
          { metadata: { "x-tenant-id": "t-dlq" } },
        );

        expect(deadLetters).toHaveLength(1);
        expect(deadLetters[0]?.pattern).toBe("invoice.poison");
        expect(deadLetters[0]?.data).toEqual({ id: "inv-1" });
        expect(deadLetters[0]?.metadata?.["x-tenant-id"]).toBe("t-dlq");
        expect(deadLetters[0]?.error).toBeInstanceOf(Error);
        expect((deadLetters[0]?.error as Error).message).toBe(
          "poison payload inv-1",
        );
        expect(deadLetters[0]?.transport).toBe(Transport.IN_MEMORY);
        expect(typeof deadLetters[0]?.timestamp).toBe("string");

        // Even when deadLetterHandler itself throws, the server loop stays alive!
        shouldThrowInDlq = true;
        await client.emit("invoice.poison", { id: "inv-2" });
        expect(deadLetters).toHaveLength(2);

        await client.emit("invoice.ok", { id: "inv-3" });
        expect(healthyEventsHandled).toBe(1);
      } finally {
        await client.close();
        await app.close();
      }
    });

    it("supports deadLetterHandler option directly on server constructor", async () => {
      const captured: MicroserviceDeadLetterContext[] = [];
      const broker = new InMemoryBroker();
      const server = new InMemoryServer({
        channel: "dlq-opt",
        broker,
        deadLetterHandler: (ctx) => {
          captured.push(ctx);
        },
      });
      server.addEventHandler("bad.event", () => {
        throw new Error("boom-event");
      });
      await server.listen();

      const client = new InMemoryClientProxy({ channel: "dlq-opt", broker });
      try {
        await client.emit("bad.event", { n: 42 });
        expect(captured).toHaveLength(1);
        expect(captured[0]?.pattern).toBe("bad.event");
        expect(captured[0]?.data).toEqual({ n: 42 });
        expect((captured[0]?.error as Error).message).toBe("boom-event");
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
