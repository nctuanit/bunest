import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { channel } from "node:diagnostics_channel";
import { Injectable, Module } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  AesGcmPayloadCodec,
  ChildWorkflowFailedError,
  InMemoryWorkflowStore,
  ManualWorkflowClock,
  NonRetryableStepError,
  StepFailedError,
  Workflow,
  WorkflowClient,
  WorkflowDefinitionError,
  WorkflowEvents,
  WorkflowFailedError,
  WorkflowIdConflictError,
  WorkflowNonDeterminismError,
  WorkflowNotFoundError,
  WorkflowResultTimeoutError,
  WorkflowSchedules,
  WorkflowSignal,
  WorkflowsModule,
  WorkflowStateError,
  WorkflowStorage,
  WorkflowWorker,
  isWorkflowInterrupt,
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowRunner,
} from "../src/index";

describe("@bunest/workflows runtime engine", () => {
  it("executes steps, memoizes replay across restart, and provides deterministic helpers", async () => {
    const sharedStore = new InMemoryWorkflowStore();
    const clock = new ManualWorkflowClock(1_700_000_000_000);
    let stepCalls = 0;

    @Injectable()
    class SharedStoreRegistrar {
      constructor(storage: WorkflowStorage) {
        storage.registerSource(sharedStore);
      }
    }

    @Workflow("order-flow")
    class OrderWorkflow
      implements
        WorkflowRunner<
          { orderId: string },
          { total: number; ts: number; rand: number; uid: string }
        >
    {
      async run(ctx: WorkflowContext, input: { orderId: string }) {
        const ts = ctx.now();
        const rand = ctx.random();
        const uid = ctx.uuid();
        const first = await ctx.step("calc", () => {
          stepCalls++;
          return { amount: 42, orderId: input.orderId };
        });
        ctx.setStatus({ stage: "waiting", orderId: first.orderId });
        await ctx.sleep("cooldown", "10s");
        const second = await ctx.step("finalize", () => first.amount * 2);
        return { total: second, ts, rand, uid };
      }
    }

    // Boot process 1
    const mod1 = await Test.createTestingModule({
      imports: [WorkflowsModule.forRoot({ clock, worker: false })],
      providers: [SharedStoreRegistrar, OrderWorkflow],
    }).compile();
    await mod1.init();

    const client1 = mod1.get(WorkflowClient);
    const worker1 = mod1.get(WorkflowWorker);

    const started = await client1.start(
      OrderWorkflow,
      { orderId: "ord-1" },
      { id: "ord-1" },
    );
    expect(started.created).toBe(true);
    expect(started.status).toBe("pending");

    // Idempotent start returns existing instance
    const dup = await client1.start(
      OrderWorkflow,
      { orderId: "ord-1" },
      { id: "ord-1" },
    );
    expect(dup.created).toBe(false);
    expect(dup.id).toBe("ord-1");

    // Different input with same id conflicts
    await expect(
      client1.start(OrderWorkflow, { orderId: "ord-2" }, { id: "ord-1" }),
    ).rejects.toBeInstanceOf(WorkflowIdConflictError);

    // Run until sleep suspension
    await worker1.drain();
    expect(stepCalls).toBe(1);

    const suspended = await client1.getStatus("ord-1", { journal: true });
    expect(suspended?.status).toBe("suspended");
    expect(suspended?.customStatus).toEqual({
      stage: "waiting",
      orderId: "ord-1",
    });
    expect(suspended?.journal?.some((e) => e.name === "calc")).toBe(true);
    await mod1.close();

    // Advance clock past sleep and boot process 2 (simulated restart)
    clock.advance("15s");

    const mod2 = await Test.createTestingModule({
      imports: [WorkflowsModule.forRoot({ clock, worker: false })],
      providers: [SharedStoreRegistrar, OrderWorkflow],
    }).compile();
    await mod2.init();

    const client2 = mod2.get(WorkflowClient);
    const worker2 = mod2.get(WorkflowWorker);

    await worker2.drain();
    expect(stepCalls).toBe(1); // Memoized! Not re-executed

    const output = await client2.result<{
      total: number;
      ts: number;
      rand: number;
      uid: string;
    }>("ord-1");
    expect(output.total).toBe(84);
    expect(output.ts).toBe(1_700_000_000_000);
    expect(typeof output.rand).toBe("number");
    expect(output.uid.length).toBeGreaterThan(10);

    const listed = await client2.list({
      workflow: "order-flow",
      status: "completed",
    });
    expect(listed.length).toBe(1);
    expect(listed[0]?.id).toBe("ord-1");

    await client2.delete("ord-1");
    expect(await client2.getStatus("ord-1")).toBeNull();
    await mod2.close();
  });

  it("handles signals, correlation keys, filters, timeouts, deduplication, and waitForAny", async () => {
    const clock = new ManualWorkflowClock(1_700_000_000_000);
    const approved = new WorkflowSignal<{ by: string; ok: boolean }>(
      "order.approved",
    );
    const rejected = new WorkflowSignal<{ reason: string }>("order.rejected");

    @Workflow("approval-flow")
    class ApprovalWorkflow
      implements WorkflowRunner<{ key: string }, { outcome: string; detail: unknown }>
    {
      async run(ctx: WorkflowContext, input: { key: string }) {
        const res = await ctx.waitForAny("decision", {
          approved: ctx.signalWait(approved, {
            key: input.key,
            match: (p) => p.ok,
          }),
          rejected: ctx.signalWait(rejected, { key: input.key }),
          timeout: ctx.timer("1h"),
        });
        if (res.key === "approved") {
          return { outcome: "approved", detail: res.value.by };
        }
        if (res.key === "rejected") {
          return { outcome: "rejected", detail: res.value.reason };
        }
        return { outcome: "timed-out", detail: null };
      }
    }

    const mod = await Test.createTestingModule({
      imports: [WorkflowsModule.forRoot({ clock, worker: false })],
      providers: [ApprovalWorkflow],
    }).compile();
    await mod.init();

    const client = mod.get(WorkflowClient);
    const worker = mod.get(WorkflowWorker);

    await client.start(ApprovalWorkflow, { key: "k1" }, { id: "wf-1" });
    await client.start(ApprovalWorkflow, { key: "k2" }, { id: "wf-2" });
    await worker.drain();

    // Non-matching payload (ok: false) should not satisfy match filter
    const s0 = await client.signal(
      approved,
      { by: "bot", ok: false },
      { key: "k1", id: "sig-1" },
    );
    expect(s0.created).toBe(true);
    await worker.drain();
    expect((await client.getStatus("wf-1"))?.status).toBe("suspended");

    // Duplicate signal id with same key is idempotent
    const s0Dup = await client.signal(
      approved,
      { by: "bot", ok: true },
      { key: "k1", id: "sig-1" },
    );
    expect(s0Dup.created).toBe(false);
    expect(s0Dup.signalId).toBe(s0.signalId);

    // Duplicate signal id with different key throws WorkflowIdConflictError
    await expect(
      client.signal(approved, { by: "bot", ok: true }, { key: "k2", id: "sig-1" }),
    ).rejects.toBeInstanceOf(WorkflowIdConflictError);

    // Matching approval wakes wf-1
    const s1 = await client.signal(
      approved,
      { by: "alice", ok: true },
      { key: "k1" },
    );
    expect(s1.woken).toBe(1);
    await worker.drain();
    expect(await client.result("wf-1")).toEqual({
      outcome: "approved",
      detail: "alice",
    });

    // Advance past 1h timer for wf-2
    clock.advance("2h");
    await worker.drain();
    expect(await client.result("wf-2")).toEqual({
      outcome: "timed-out",
      detail: null,
    });

    await mod.close();
  });

  it("runs saga compensations in reverse order, respects ctx.commit(), and supports cancel & terminate", async () => {
    const clock = new ManualWorkflowClock(1_700_000_000_000);
    const log: string[] = [];

    @Workflow("saga-flow")
    class SagaWorkflow
      implements WorkflowRunner<{ failAt?: string; withCommit?: boolean }, string>
    {
      async run(
        ctx: WorkflowContext,
        input: { failAt?: string; withCommit?: boolean },
      ) {
        await ctx.step("reserve-stock", () => "stock-1", {
          compensate: (id) => {
            log.push(`undo-stock:${id}`);
          },
        });
        if (input.withCommit) {
          ctx.commit("point-of-no-return");
        }
        await ctx.step("charge-card", () => "charge-1", {
          compensate: (id) => {
            log.push(`undo-charge:${id}`);
          },
        });
        if (input.failAt === "after-charge") {
          ctx.fail("shipment unavailable");
        }
        await ctx.sleep("ship-wait", "10m");
        return "shipped";
      }
    }

    const mod = await Test.createTestingModule({
      imports: [WorkflowsModule.forRoot({ clock, worker: false })],
      providers: [SagaWorkflow],
    }).compile();
    await mod.init();

    const client = mod.get(WorkflowClient);
    const worker = mod.get(WorkflowWorker);

    // 1. Failure runs compensations in reverse order
    await client.start(SagaWorkflow, { failAt: "after-charge" }, { id: "s1" });
    await worker.drain();
    expect(log).toEqual(["undo-charge:charge-1", "undo-stock:stock-1"]);
    await expect(client.result("s1")).rejects.toBeInstanceOf(WorkflowFailedError);

    // 2. ctx.commit() discards earlier compensations
    log.length = 0;
    await client.start(
      SagaWorkflow,
      { failAt: "after-charge", withCommit: true },
      { id: "s2" },
    );
    await worker.drain();
    expect(log).toEqual(["undo-charge:charge-1"]);

    // 3. cancel() runs compensations
    log.length = 0;
    await client.start(SagaWorkflow, {}, { id: "s3" });
    await worker.drain();
    const cancelled = await client.cancel("s3", "user cancelled");
    expect(cancelled.accepted).toBe(true);
    await worker.drain();
    expect((await client.getStatus("s3"))?.status).toBe("cancelled");
    expect(log).toEqual(["undo-charge:charge-1", "undo-stock:stock-1"]);

    // 4. terminate() skips compensations
    log.length = 0;
    await client.start(SagaWorkflow, {}, { id: "s4" });
    await worker.drain();
    const terminated = await client.terminate("s4", "kill switch");
    expect(terminated.accepted).toBe(true);
    await worker.drain();
    const s4 = await client.getStatus("s4");
    expect(s4?.status).toBe("cancelled");
    expect(s4?.error?.name).toBe("WorkflowTerminatedError");
    expect(log).toEqual([]);

    await mod.close();
  });

  it("supports step retries, heartbeat progress, NonRetryableStepError, and operator retry()", async () => {
    const clock = new ManualWorkflowClock(1_700_000_000_000);
    let flakyAttempts = 0;
    let shouldFail = true;

    @Workflow("retry-flow")
    class RetryWorkflow implements WorkflowRunner<void, { progressSeen: number; attempts: number }> {
      async run(ctx: WorkflowContext) {
        return ctx.step<
          { progressSeen: number; attempts: number },
          { done: number }
        >(
          "flaky",
          async (stepCtx) => {
            flakyAttempts++;
            const prev = stepCtx.progress?.done ?? 0;
            await stepCtx.heartbeat({ done: prev + 10 });
            if (shouldFail) {
              throw new Error(`boom-${stepCtx.attempt}`);
            }
            return { progressSeen: prev, attempts: stepCtx.attempt };
          },
          { retry: { attempts: 2, backoff: { delay: "5s", factor: 2 } } },
        );
      }
    }

    @Workflow("non-retry-flow")
    class NonRetryWorkflow implements WorkflowRunner<void, string> {
      async run(ctx: WorkflowContext) {
        try {
          await ctx.step("bad", () => {
            throw new NonRetryableStepError("declined");
          });
          return "ok";
        } catch (err) {
          if (err instanceof StepFailedError) {
            return `caught:${err.attempts}:${err.cause.message}`;
          }
          throw err;
        }
      }
    }

    const mod = await Test.createTestingModule({
      imports: [WorkflowsModule.forRoot({ clock, worker: false })],
      providers: [RetryWorkflow, NonRetryWorkflow],
    }).compile();
    await mod.init();

    const client = mod.get(WorkflowClient);
    const worker = mod.get(WorkflowWorker);

    // NonRetryableStepError gives up immediately on attempt 1 and is catchable as StepFailedError
    await client.start(NonRetryWorkflow, undefined, { id: "nr-1" });
    await worker.drain();
    expect(await client.result("nr-1")).toBe("caught:1:declined");

    // RetryWorkflow: attempt 1 fails, parks 5s, attempt 2 fails -> workflow fails
    await client.start(RetryWorkflow, undefined, { id: "rf-1" });
    await worker.drain();
    expect(flakyAttempts).toBe(1);
    expect((await client.getStatus("rf-1"))?.status).toBe("suspended");

    clock.advance("6s");
    await worker.drain();
    expect(flakyAttempts).toBe(2);
    expect((await client.getStatus("rf-1"))?.status).toBe("failed");

    // Operator fixes root cause and retries instance
    shouldFail = false;
    const reopened = await client.retry("rf-1");
    expect(reopened.status).toBe("pending");
    await worker.drain();
    const res = await client.result<{ progressSeen: number; attempts: number }>(
      "rf-1",
    );
    expect(res.attempts).toBe(1);

    // Cannot retry completed workflow
    await expect(client.retry("rf-1")).rejects.toBeInstanceOf(
      WorkflowStateError,
    );

    await mod.close();
  });

  it("supports child workflows, parentClose policies, and ChildWorkflowFailedError", async () => {
    const clock = new ManualWorkflowClock(1_700_000_000_000);

    @Workflow("child-wf")
    class ChildWorkflow
      implements WorkflowRunner<{ value: number; fail?: boolean; hang?: boolean }, number>
    {
      async run(
        ctx: WorkflowContext,
        input: { value: number; fail?: boolean; hang?: boolean },
      ) {
        if (input.hang) {
          await ctx.sleep("forever", "1d");
        }
        if (input.fail) {
          ctx.fail("child exploded");
        }
        return ctx.step("double", () => input.value * 2);
      }
    }

    @Workflow("parent-wf")
    class ParentWorkflow
      implements WorkflowRunner<{ mode: "ok" | "fail" | "cancel-child" }, unknown>
    {
      async run(
        ctx: WorkflowContext,
        input: { mode: "ok" | "fail" | "cancel-child" },
      ) {
        if (input.mode === "ok") {
          const val = await ctx.executeChild(ChildWorkflow, { value: 21 });
          return { childResult: val };
        }
        if (input.mode === "fail") {
          try {
            await ctx.executeChild(ChildWorkflow, { value: 1, fail: true });
            return "unexpected";
          } catch (err) {
            if (isWorkflowInterrupt(err)) throw err;
            if (err instanceof ChildWorkflowFailedError) {
              return { caught: err.status, workflow: err.workflow };
            }
            throw err;
          }
        }
        await ctx.startChild(
          ChildWorkflow,
          { value: 1, hang: true },
          { id: "hanging-child", parentClose: "cancel" },
        );
        return "parent-done";
      }
    }

    const mod = await Test.createTestingModule({
      imports: [WorkflowsModule.forRoot({ clock, worker: false })],
      providers: [ChildWorkflow, ParentWorkflow],
    }).compile();
    await mod.init();

    const client = mod.get(WorkflowClient);
    const worker = mod.get(WorkflowWorker);

    await client.start(ParentWorkflow, { mode: "ok" }, { id: "p1" });
    await worker.drain();
    expect(await client.result("p1")).toEqual({ childResult: 42 });
    const p1Status = await client.getStatus("p1", { children: true });
    expect(p1Status?.children?.length).toBe(1);

    await client.start(ParentWorkflow, { mode: "fail" }, { id: "p2" });
    await worker.drain();
    expect(await client.result("p2")).toEqual({
      caught: "failed",
      workflow: "child-wf",
    });

    await client.start(ParentWorkflow, { mode: "cancel-child" }, { id: "p3" });
    await worker.drain();
    expect(await client.result("p3")).toBe("parent-done");
    expect((await client.getStatus("hanging-child"))?.status).toBe("cancelled");

    await mod.close();
  });

  it("encrypts payloads at rest with AesGcmPayloadCodec and supports key rotation", async () => {
    const rawStore = new InMemoryWorkflowStore();
    const clock = new ManualWorkflowClock(1_700_000_000_000);
    const key1 = Buffer.alloc(32, 1);
    const key2 = Buffer.alloc(32, 2);
    const codec1 = new AesGcmPayloadCodec({ keys: { k1: key1 }, current: "k1" });
    const codec2 = new AesGcmPayloadCodec({
      keys: { k1: key1, k2: key2 },
      current: "k2",
    });

    @Injectable()
    class RawStoreRegistrar {
      constructor(storage: WorkflowStorage) {
        storage.registerSource(rawStore);
      }
    }

    @Workflow("secret-wf")
    class SecretWorkflow implements WorkflowRunner<{ ssn: string }, { masked: string }> {
      async run(ctx: WorkflowContext, input: { ssn: string }) {
        const res = await ctx.step("mask", () => `***-${input.ssn.slice(-4)}`);
        return { masked: res };
      }
    }

    const mod1 = await Test.createTestingModule({
      imports: [
        WorkflowsModule.forRoot({ clock, worker: false, codec: codec1 }),
      ],
      providers: [RawStoreRegistrar, SecretWorkflow],
    }).compile();
    await mod1.init();

    const client1 = mod1.get(WorkflowClient);
    const worker1 = mod1.get(WorkflowWorker);

    await client1.start(SecretWorkflow, { ssn: "123-45-6789" }, { id: "sec-1" });
    await worker1.drain();

    // Raw store holds encrypted ciphertext, NOT plaintext
    const raw = await rawStore.get("sec-1", { journal: true });
    expect(JSON.stringify(raw?.input)).not.toContain("123-45-6789");
    expect(JSON.stringify(raw?.output)).not.toContain("6789");
    await mod1.close();

    // Rotate to codec2 with keys { k1, k2 }, current: "k2"
    const mod2 = await Test.createTestingModule({
      imports: [
        WorkflowsModule.forRoot({
          clock,
          worker: false,
          codec: codec2,
        }),
      ],
      providers: [RawStoreRegistrar, SecretWorkflow],
    }).compile();
    await mod2.init();

    const client2 = mod2.get(WorkflowClient);
    const decoded = await client2.getStatus("sec-1", { journal: true });
    expect(decoded?.input).toEqual({ ssn: "123-45-6789" });
    expect(decoded?.output).toEqual({ masked: "***-6789" });
    await mod2.close();
  });

  it("emits zero-RxJS WorkflowEvents (subscribe + AsyncIterable + diagnostics_channel) and enforces schedules, limits & errors", async () => {
    const clock = new ManualWorkflowClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const collected: WorkflowEvent[] = [];
    const diagEvents: unknown[] = [];
    const dc = channel("nestjs:workflows:workflow-completed");
    const onDiag = (msg: unknown) => diagEvents.push(msg);
    dc.subscribe(onDiag);

    @Workflow("sched-wf", {
      concurrency: { limit: 1, key: (i: { tenant: string }) => i.tenant },
      rateLimit: { max: 10, duration: "1m" },
      schedules: [
        {
          id: "every-minute",
          every: "1m",
          input: ({ at }) => ({ tenant: "t1", at }),
        },
      ],
    })
    class ScheduledWorkflow
      implements WorkflowRunner<{ tenant: string; at?: number }, string>
    {
      async run(ctx: WorkflowContext, input: { tenant: string }) {
        return ctx.step("work", () => `ok:${input.tenant}:${ctx.schedule?.id ?? "manual"}`);
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        WorkflowsModule.forRootAsync({
          useFactory: () => ({ clock, worker: false }),
        }),
      ],
      providers: [ScheduledWorkflow],
    }).compile();
    await mod.init();

    const client = mod.get(WorkflowClient);
    const schedules = mod.get(WorkflowSchedules);
    const worker = mod.get(WorkflowWorker);
    const events = mod.get(WorkflowEvents);

    const sub = events.events$.subscribe((ev) => collected.push(ev));

    // Also test AsyncIterable iteration on WorkflowEvents.events$
    const asyncCollected: WorkflowEvent[] = [];
    const iter = events.events$[Symbol.asyncIterator]();
    const iterTask = (async () => {
      const next = await iter.next();
      if (!next.done) asyncCollected.push(next.value);
      await iter.return?.();
    })();

    // Declared schedule synced at bootstrap
    const declared = await schedules.get("every-minute");
    expect(declared?.declared).toBe(true);
    expect(declared?.workflow).toBe("sched-wf");

    // Programmatic schedule upsert/preview/pause/resume/trigger/remove
    const upserted = await schedules.upsert("custom-hourly", {
      workflow: ScheduledWorkflow,
      cron: "0 * * * *",
      input: { tenant: "t2" },
    });
    expect(upserted.id).toBe("custom-hourly");
    const preview = await schedules.preview("custom-hourly", { count: 3 });
    expect(preview.length).toBe(3);

    const paused = await schedules.pause("custom-hourly");
    expect(paused.paused).toBe(true);
    const resumed = await schedules.resume("custom-hourly");
    expect(resumed.paused).toBe(false);

    const triggered = await schedules.trigger("custom-hourly");
    expect(triggered.created).toBe(true);
    await worker.drain();
    await iterTask;

    expect(await client.result(triggered.id)).toBe("ok:t2:custom-hourly");
    expect(collected.some((e) => e.type === "workflow-completed")).toBe(true);
    expect(asyncCollected.length).toBe(1);
    expect(diagEvents.length).toBeGreaterThanOrEqual(1);

    expect(await schedules.remove("custom-hourly")).toBe(true);
    await expect(schedules.remove("every-minute")).rejects.toBeInstanceOf(
      WorkflowStateError,
    );

    // Purge old completed instances
    clock.advance("2d");
    const purged = await client.purge({ olderThan: "1d" });
    expect(purged.instances).toBeGreaterThanOrEqual(1);

    // Unknown id error checks
    await expect(client.cancel("does-not-exist")).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    await expect(
      client.result("does-not-exist", { timeout: "5ms" }),
    ).rejects.toThrow();

    sub.unsubscribe();
    dc.unsubscribe(onDiag);
    await mod.close();
  });

  it("detects WorkflowDefinitionError, WorkflowNonDeterminismError, and WorkflowResultTimeoutError", async () => {
    const clock = new ManualWorkflowClock(1_700_000_000_000);
    const sharedStore = new InMemoryWorkflowStore();
    let v1Code = true;

    @Injectable()
    class StoreReg {
      constructor(storage: WorkflowStorage) {
        storage.registerSource(sharedStore);
      }
    }

    @Workflow("bad-wf")
    class BadWorkflow implements WorkflowRunner<{ mode: string }, string> {
      async run(ctx: WorkflowContext, input: { mode: string }) {
        if (input.mode === "dup") {
          await ctx.step("same", () => 1);
          await ctx.step("same", () => 2);
        }
        if (input.mode === "nested") {
          await ctx.step("outer", async () => {
            return ctx.step("inner", () => 1);
          });
        }
        if (input.mode === "nondet") {
          if (v1Code) {
            await ctx.step("step-a", () => 1);
            await ctx.sleep("wait", "10s");
          } else {
            await ctx.step("step-b", () => 2);
          }
        }
        if (input.mode === "hang") {
          await ctx.sleep("long", "1h");
        }
        return "done";
      }
    }

    const mod = await Test.createTestingModule({
      imports: [WorkflowsModule.forRoot({ clock, worker: false })],
      providers: [StoreReg, BadWorkflow],
    }).compile();
    await mod.init();

    const client = mod.get(WorkflowClient);
    const worker = mod.get(WorkflowWorker);

    // Duplicate step name -> WorkflowDefinitionError
    await client.start(BadWorkflow, { mode: "dup" }, { id: "bad-dup" });
    await worker.drain();
    const dupStatus = await client.getStatus("bad-dup");
    expect(dupStatus?.status).toBe("failed");
    expect(dupStatus?.error?.name).toBe("WorkflowDefinitionError");

    // Calling ctx inside step -> WorkflowDefinitionError
    await client.start(BadWorkflow, { mode: "nested" }, { id: "bad-nested" });
    await worker.drain();
    const nestedStatus = await client.getStatus("bad-nested");
    expect(nestedStatus?.status).toBe("failed");
    expect(nestedStatus?.error?.name).toBe("WorkflowDefinitionError");

    // Non-determinism across replay -> WorkflowNonDeterminismError
    await client.start(BadWorkflow, { mode: "nondet" }, { id: "bad-nondet" });
    await worker.drain();
    v1Code = false;
    clock.advance("20s");
    await worker.drain();
    const nondetStatus = await client.getStatus("bad-nondet");
    expect(nondetStatus?.status).toBe("failed");
    expect(nondetStatus?.error?.name).toBe("WorkflowNonDeterminismError");

    // WorkflowResultTimeoutError
    await client.start(BadWorkflow, { mode: "hang" }, { id: "hang-1" });
    await worker.drain();
    await expect(
      client.result("hang-1", { timeout: "20ms" }),
    ).rejects.toBeInstanceOf(WorkflowResultTimeoutError);

    // Verify error class hierarchy
    expect(new WorkflowNonDeterminismError("x")).toBeInstanceOf(
      WorkflowDefinitionError,
    );

    await mod.close();
  });
});
