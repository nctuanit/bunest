import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  ClientProxy,
  RpcException,
  RpcTimeoutException,
  Transport,
  type ClientStatus,
} from "../../../../../../packages/microservices/src";
import {
  createSandbox,
  createSpy,
  describeConformance,
  expectCalledOnce,
  expectCalledTimes,
  expectNotCalled,
  itAdapted,
} from "../../../../_helpers";

class TestClientProxy extends ClientProxy {
  public readonly transport = Transport.IN_MEMORY;
  public connectImpl: () => Promise<void> = async () => {};
  public closeImpl: () => Promise<void> = async () => {};
  public sendOnceImpl: (
    pattern: string,
    data: unknown,
    timeoutMs: number,
  ) => Promise<unknown> = async (_pattern, data) => data;
  public dispatchEventImpl: (pattern: string, data: unknown) => Promise<void> =
    async () => {};

  constructor(defaultTimeoutMs?: number) {
    super(defaultTimeoutMs);
  }

  public async connect(): Promise<void> {
    await this.connectImpl();
  }

  public async close(): Promise<void> {
    await this.closeImpl();
  }

  public triggerStatus(status: ClientStatus): void {
    this.emitStatus(status);
  }

  public getDefaultTimeoutMs(): number {
    return this.defaultTimeoutMs;
  }

  protected override async sendOnce<TRes = unknown, TReq = unknown>(
    pattern: string,
    data: TReq,
    timeoutMs: number,
  ): Promise<TRes> {
    return (await this.sendOnceImpl(pattern, data, timeoutMs)) as TRes;
  }

  protected override async dispatchEvent<TReq = unknown>(
    pattern: string,
    data: TReq,
  ): Promise<void> {
    await this.dispatchEventImpl(pattern, data);
  }
}

describeConformance(
  "ClientProxy",
  {
    upstreamPath: "packages/microservices/test/client/client-proxy.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
    notes:
      "Ports ClientProxy send(), emit(), pre-request hook (setPreRequestHook), status transitions, retries, timeouts, pattern normalization, unwrap(), and onModuleDestroy() using Bunest native Promises instead of RxJS Observables.",
  },
  () => {
    const sandbox = createSandbox();
    let client: TestClientProxy;

    beforeEach(() => {
      client = new TestClientProxy();
    });

    afterEach(() => {
      sandbox.restore();
    });

    describe("constructor & defaultTimeoutMs", () => {
      it("should default defaultTimeoutMs to 5000", () => {
        expect(client.getDefaultTimeoutMs()).toBe(5000);
      });

      it("should clamp defaultTimeoutMs to at least 1ms and floor decimals", () => {
        expect(new TestClientProxy(0).getDefaultTimeoutMs()).toBe(1);
        expect(new TestClientProxy(-50).getDefaultTimeoutMs()).toBe(1);
        expect(new TestClientProxy(250.8).getDefaultTimeoutMs()).toBe(250);
      });
    });

    describe("send", () => {
      itAdapted(
        "ADR-008",
        "should return a Promise resolving with the response from sendOnce",
        async () => {
          client.sendOnceImpl = async () => "ok-reply";
          const resultPromise = client.send({ cmd: "ping" }, "payload");
          expect(resultPromise).toBeInstanceOf(Promise);
          expect(await resultPromise).toBe("ok-reply");
        },
        "Promise instead of RxJS Observable",
      );

      it("should normalize string, RegExp, and canonically sorted object patterns before calling sendOnce", async () => {
        const seenPatterns: string[] = [];
        client.sendOnceImpl = async (pattern, data) => {
          seenPatterns.push(pattern);
          return data;
        };

        await client.send("my-pattern", 1);
        await client.send({ b: 2, a: 1 }, 2);
        await client.send({ a: 1, b: 2 }, 3);
        await client.send(/^rpc\./i, 4);

        expect(seenPatterns).toEqual([
          "my-pattern",
          '{"a":1,"b":2}',
          '{"a":1,"b":2}',
          "/^rpc\\./i",
        ]);
      });

      it("should forward timeoutMs option or defaultTimeoutMs to sendOnce", async () => {
        const timeouts: number[] = [];
        client.sendOnceImpl = async (_pattern, _data, timeoutMs) => {
          timeouts.push(timeoutMs);
          return true;
        };

        await client.send("a", {});
        await client.send("b", {}, { timeoutMs: 1234.9 });
        await client.send("c", {}, { timeoutMs: 0 });

        expect(timeouts).toEqual([5000, 1234, 1]);
      });

      it("should reject with RpcTimeoutException when sendOnce exceeds timeoutMs", async () => {
        client.sendOnceImpl = async () => {
          await Bun.sleep(150);
          return "too-late";
        };

        let caught: unknown;
        try {
          await client.send("slow.op", {}, { timeoutMs: 20 });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(RpcTimeoutException);
        expect((caught as RpcTimeoutException).pattern).toBe("slow.op");
        expect((caught as RpcTimeoutException).timeoutMs).toBe(20);
      });

      it("should retry transient errors up to options.retries times and resolve on recovery", async () => {
        let attempts = 0;
        client.sendOnceImpl = async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error(`transient-${attempts}`);
          }
          return "recovered";
        };

        const res = await client.send(
          "flaky",
          {},
          { retries: 3, retryDelayMs: 5 },
        );
        expect(res).toBe("recovered");
        expect(attempts).toBe(3);
      });

      it("should retry on timeout and succeed if a subsequent attempt completes in time", async () => {
        let attempts = 0;
        client.sendOnceImpl = async () => {
          attempts++;
          if (attempts === 1) {
            await Bun.sleep(80);
            return "late";
          }
          return "fast-second-attempt";
        };

        const res = await client.send(
          "slow-then-fast",
          {},
          { timeoutMs: 20, retries: 1, retryDelayMs: 5 },
        );
        expect(res).toBe("fast-second-attempt");
        expect(attempts).toBe(2);
      });

      it("should throw the last error once all retries are exhausted", async () => {
        let attempts = 0;
        client.sendOnceImpl = async () => {
          attempts++;
          throw new Error(`fail-${attempts}`);
        };

        await expect(
          client.send("always-fails", {}, { retries: 2, retryDelayMs: 1 }),
        ).rejects.toThrow("fail-3");
        expect(attempts).toBe(3);
      });

      it("should NOT retry non-retryable application RpcException errors", async () => {
        let attempts = 0;
        client.sendOnceImpl = async () => {
          attempts++;
          throw new RpcException({ status: 400, message: "bad input" });
        };

        await expect(
          client.send("validate", {}, { retries: 3, retryDelayMs: 1 }),
        ).rejects.toBeInstanceOf(RpcException);
        expect(attempts).toBe(1);
      });

      it("should retry an RpcException explicitly marked with isRetryable: true", async () => {
        let attempts = 0;
        client.sendOnceImpl = async () => {
          attempts++;
          if (attempts === 1) {
            throw Object.assign(new RpcException("please retry"), {
              isRetryable: true,
            });
          }
          return "ok-after-retry";
        };

        const res = await client.send(
          "retryable-rpc",
          {},
          { retries: 2, retryDelayMs: 1 },
        );
        expect(res).toBe("ok-after-retry");
        expect(attempts).toBe(2);
      });

      it("should allow null and undefined data payloads cleanly", async () => {
        const seen: unknown[] = [];
        client.sendOnceImpl = async (_pattern, data) => {
          seen.push(data);
          return data;
        };

        expect(await client.send("p1", null)).toBeNull();
        expect(await client.send("p2", undefined)).toBeUndefined();
        expect(seen).toEqual([null, undefined]);
      });
    });

    describe("setPreRequestHook (setOnDispatchHook equivalent)", () => {
      const metadata = { traceId: "trace-1" };

      it("should let the hook inspect or attach metadata to an outgoing request", async () => {
        const sendSpy = createSpy(
          async (_pattern: string, data: unknown) => data,
        );
        client.sendOnceImpl = sendSpy;

        const returned = client.setPreRequestHook((ctx) => {
          expect(ctx.transport).toBe(Transport.IN_MEMORY);
          expect(ctx.pattern).toBe("pattern");
          (ctx.data as Record<string, unknown>).metadata = metadata;
        });
        expect(returned).toBe(client);

        const payload: Record<string, unknown> = { body: "data" };
        await client.send("pattern", payload);

        expectCalledOnce(sendSpy);
        expect(sendSpy.firstCall?.args[0]).toBe("pattern");
        expect(sendSpy.firstCall?.args[1]).toEqual({
          body: "data",
          metadata,
        });
      });

      it("should let an async hook run before an outgoing event", async () => {
        const order: string[] = [];
        const dispatchSpy = createSpy(
          async (_pattern: string, data: unknown) => {
            order.push("dispatch");
            expect(data).toEqual({ body: "data", metadata });
          },
        );
        client.dispatchEventImpl = dispatchSpy;

        client.setPreRequestHook(async (ctx) => {
          await Bun.sleep(5);
          order.push("hook");
          (ctx.data as Record<string, unknown>).metadata = metadata;
        });

        await client.emit("pattern", { body: "data" });

        expect(order).toEqual(["hook", "dispatch"]);
        expectCalledOnce(dispatchSpy);
      });

      it("should send the packet unchanged when no hook is set or after clearing hook with undefined", async () => {
        const dispatchSpy = createSpy(
          async (_pattern: string, _data: unknown) => {},
        );
        client.dispatchEventImpl = dispatchSpy;

        await client.emit("pattern", "data");
        expect(dispatchSpy.firstCall?.args).toEqual(["pattern", "data"]);

        const hookSpy = createSpy(() => {});
        client.setPreRequestHook(hookSpy);
        await client.emit("pattern", "data-2");
        expectCalledOnce(hookSpy);

        client.setPreRequestHook(undefined);
        await client.emit("pattern", "data-3");
        expectCalledOnce(hookSpy);
        expectCalledTimes(dispatchSpy, 3);
      });

      it("should abort send/emit without calling transport when preRequestHook throws", async () => {
        const sendSpy = createSpy(async () => "never");
        const dispatchSpy = createSpy(async () => {});
        client.sendOnceImpl = sendSpy;
        client.dispatchEventImpl = dispatchSpy;

        client.setPreRequestHook(() => {
          throw new RpcException("blocked by hook");
        });

        await expect(client.send("pattern", {})).rejects.toThrow(
          "blocked by hook",
        );
        await expect(client.emit("pattern", {})).rejects.toThrow(
          "blocked by hook",
        );
        expectNotCalled(sendSpy);
        expectNotCalled(dispatchSpy);
      });

      it("should run preRequestHook once per send() call even when send() retries", async () => {
        const hookSpy = createSpy(() => {});
        let attempts = 0;
        client.setPreRequestHook(hookSpy);
        client.sendOnceImpl = async () => {
          attempts++;
          if (attempts === 1) throw new Error("retryable");
          return "done";
        };

        expect(
          await client.send("pattern", {}, { retries: 1, retryDelayMs: 1 }),
        ).toBe("done");
        expectCalledOnce(hookSpy);
        expect(attempts).toBe(2);
      });
    });

    describe("emit", () => {
      itAdapted(
        "ADR-008",
        "should return a Promise<void> and call dispatchEvent with normalized pattern",
        async () => {
          const dispatchSpy = createSpy(
            async (_pattern: string, _data: unknown) => {},
          );
          client.dispatchEventImpl = dispatchSpy;

          const p = client.emit({ test: 3, a: 1 }, "test-data");
          expect(p).toBeInstanceOf(Promise);
          expect(await p).toBeUndefined();

          expectCalledOnce(dispatchSpy);
          expect(dispatchSpy.firstCall?.args).toEqual([
            '{"a":1,"test":3}',
            "test-data",
          ]);
        },
        "Promise instead of RxJS Observable",
      );

      it("should propagate errors thrown by dispatchEvent", async () => {
        client.dispatchEventImpl = async () => {
          throw new Error("dispatch failed");
        };

        await expect(client.emit("evt", {})).rejects.toThrow("dispatch failed");
      });
    });

    describe("status & onStatus", () => {
      itAdapted(
        "ADR-008",
        "should default to disconnected, notify listeners on transitions, deduplicate identical statuses, and support unsubscribe",
        () => {
          expect(client.status).toBe("disconnected");

          const seenA: ClientStatus[] = [];
          const seenB: ClientStatus[] = [];
          const unsubA = client.onStatus((s) => seenA.push(s));
          const unsubB = client.onStatus((s) => seenB.push(s));

          // Duplicate initial status should be ignored
          client.triggerStatus("disconnected");
          expect(seenA).toEqual([]);

          client.triggerStatus("connected");
          client.triggerStatus("connected"); // duplicate ignored
          client.triggerStatus("reconnecting");

          unsubA();
          client.triggerStatus("disconnected");
          unsubB();
          client.triggerStatus("connected");

          expect(seenA).toEqual(["connected", "reconnecting"]);
          expect(seenB).toEqual(["connected", "reconnecting", "disconnected"]);
          expect(client.status).toBe("connected");
        },
        "onStatus callback API instead of RxJS Observable status$",
      );
    });

    describe("unwrap & lifecycle", () => {
      it("unwrap() should return self by default", () => {
        expect(client.unwrap<TestClientProxy>()).toBe(client);
      });

      it("onModuleDestroy() should delegate to close()", async () => {
        const closeSpy = sandbox.spy(client, "close");
        await client.onModuleDestroy();
        expectCalledOnce(closeSpy);
      });
    });
  },
);
