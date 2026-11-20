import { Injectable, Module } from "@bunest/common";
import {
  AggregateRoot,
  CqrsModule,
  EventBus,
  EventPublisher,
  EventsHandler,
  UnhandledExceptionBus,
  type IEvent,
  type IEventHandler,
  type IEventPublisher,
  type UnhandledExceptionInfo,
} from "@bunest/cqrs";
import { Test } from "@bunest/testing";
import { describe, expect, it } from "bun:test";
import { InMemoryScheduleStore } from "../src/core/index";
import {
  SignalOn,
  StartOn,
  WorkflowsCqrsModule,
  type WorkflowDispatcherContext,
} from "../src/cqrs/index";
import {
  InMemoryWorkflowStore,
  Workflow,
  WorkflowClient,
  WorkflowSignal,
  WorkflowStorage,
  WorkflowWorker,
  WorkflowsModule,
  type NewWorkflowInstance,
  type NewWorkflowSignal,
  type WorkflowContext,
  type WorkflowInstance,
  type WorkflowRunner,
  type WorkflowSignalResult,
  type WorkflowStore,
} from "../src/index";
import {
  scheduleStoreContract,
  workflowStoreContract,
} from "../src/testing/index";

// ============================================================================
// 1. Contract Suites: workflowStoreContract & scheduleStoreContract
// ============================================================================

describe("testing/workflowStoreContract (InMemoryWorkflowStore, concurrent: true)", () => {
  let disposed = 0;
  const cases = workflowStoreContract(() => new InMemoryWorkflowStore(), {
    concurrent: true,
    dispose: () => {
      disposed++;
    },
  });

  for (const contractCase of cases) {
    it(contractCase.name, async () => {
      await contractCase.run();
    });
  }

  it("invoked dispose() for every executed case", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(disposed).toBe(cases.length);
  });
});

describe("testing/workflowStoreContract (transaction contract cases)", () => {
  /**
   * Minimal transactional wrapper around InMemoryWorkflowStore that buffers
   * createInTransaction / signalInTransaction writes on a staged store and
   * commits them atomically only when the transaction callback resolves.
   */
  class TransactionalInMemoryStore implements WorkflowStore {
    private inner = new InMemoryWorkflowStore();
    private activeTx: {
      staged: InMemoryWorkflowStore;
      creates: NewWorkflowInstance[];
      signals: NewWorkflowSignal[];
    } | null = null;

    async runTransaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      const staged = this.cloneInner();
      const txToken = Symbol("tx");
      this.activeTx = { staged, creates: [], signals: [] };
      try {
        const result = await work(txToken);
        this.inner = staged;
        return result;
      } finally {
        this.activeTx = null;
      }
    }

    private cloneInner(): InMemoryWorkflowStore {
      const clone = new InMemoryWorkflowStore();
      const src = this.inner as unknown as {
        rows: Map<string, unknown>;
        signalLog: unknown[];
        windows: Map<string, unknown>;
      };
      const dst = clone as unknown as {
        rows: Map<string, unknown>;
        signalLog: unknown[];
        windows: Map<string, unknown>;
      };
      for (const [k, v] of src.rows.entries()) {
        dst.rows.set(k, structuredClone(v));
      }
      dst.signalLog.push(...structuredClone(src.signalLog));
      for (const [k, v] of src.windows.entries()) {
        dst.windows.set(k, structuredClone(v));
      }
      return clone;
    }

    create(instance: NewWorkflowInstance) {
      return this.inner.create(instance);
    }
    createInTransaction(_tx: unknown, instance: NewWorkflowInstance) {
      return (this.activeTx?.staged ?? this.inner).create(instance);
    }
    get(id: string, options?: { journal?: boolean }) {
      return this.inner.get(id, options);
    }
    list(query: Parameters<WorkflowStore["list"]>[0]) {
      return this.inner.list(query);
    }
    requestCancel(
      id: string,
      request: Parameters<WorkflowStore["requestCancel"]>[1],
    ) {
      return this.inner.requestCancel(id, request);
    }
    reopen(id: string, reopen: Parameters<WorkflowStore["reopen"]>[1]) {
      return this.inner.reopen(id, reopen);
    }
    delete(id: string, statuses: Parameters<WorkflowStore["delete"]>[1]) {
      return this.inner.delete(id, statuses);
    }
    signal(signal: NewWorkflowSignal) {
      return this.inner.signal(signal);
    }
    signalInTransaction(_tx: unknown, signal: NewWorkflowSignal) {
      return (this.activeTx?.staged ?? this.inner).signal(signal);
    }
    signals(query: Parameters<WorkflowStore["signals"]>[0]) {
      return this.inner.signals(query);
    }
    purge(query: Parameters<WorkflowStore["purge"]>[0]) {
      return this.inner.purge(query);
    }
    saveSchedule(schedule: Parameters<WorkflowStore["saveSchedule"]>[0]) {
      return this.inner.saveSchedule(schedule);
    }
    getSchedule(id: string) {
      return this.inner.getSchedule(id);
    }
    listSchedules(query: Parameters<WorkflowStore["listSchedules"]>[0]) {
      return this.inner.listSchedules(query);
    }
    deleteSchedule(id: string, revision?: number) {
      return this.inner.deleteSchedule(id, revision);
    }
    claimSchedules(request: Parameters<WorkflowStore["claimSchedules"]>[0]) {
      return this.inner.claimSchedules(request);
    }
    writeSchedule(
      id: string,
      token: string,
      write: Parameters<WorkflowStore["writeSchedule"]>[2],
    ) {
      return this.inner.writeSchedule(id, token, write);
    }
    claim(request: Parameters<WorkflowStore["claim"]>[0]) {
      return this.inner.claim(request);
    }
    renew(id: string, token: string, leaseUntil: number) {
      return this.inner.renew(id, token, leaseUntil);
    }
    write(
      id: string,
      token: string,
      write: Parameters<WorkflowStore["write"]>[2],
    ) {
      return this.inner.write(id, token, write);
    }
  }

  let currentStore: TransactionalInMemoryStore;
  const txCases = workflowStoreContract(
    () => {
      currentStore = new TransactionalInMemoryStore();
      return currentStore;
    },
    {
      transaction: (work) => currentStore.runTransaction(work),
    },
  ).filter((c) => c.name.includes("InTransaction"));

  it("includes both transactional contract cases", () => {
    expect(txCases).toHaveLength(2);
  });

  for (const contractCase of txCases) {
    it(contractCase.name, async () => {
      await contractCase.run();
    });
  }
});

describe("testing/scheduleStoreContract (InMemoryScheduleStore, concurrent: true)", () => {
  let disposed = 0;
  const cases = scheduleStoreContract(() => new InMemoryScheduleStore(), {
    concurrent: true,
    dispose: () => {
      disposed++;
    },
  });

  for (const contractCase of cases) {
    it(contractCase.name, async () => {
      await contractCase.run();
    });
  }

  it("invoked dispose() for every schedule contract case", () => {
    expect(cases).toHaveLength(5);
    expect(disposed).toBe(5);
  });
});

// ============================================================================
// 2. CQRS Integration: WorkflowsCqrsModule + @StartOn() + @SignalOn()
// ============================================================================

class OrderPlacedEvent implements IEvent {
  constructor(
    readonly orderId: string,
    readonly customerId: string,
    readonly amount: number,
    readonly urgent = false,
  ) {}
}

class OrderShippedEvent implements IEvent {
  constructor(
    readonly orderId: string,
    readonly deliveryId: string,
    readonly carrier: string,
  ) {}
}

class SimplePingEvent implements IEvent {
  constructor(readonly message: string) {}
}

class UnroutedAuditEvent implements IEvent {
  constructor(readonly note: string) {}
}

const shipmentDelivered = new WorkflowSignal<{
  carrier: string;
  deliveryId: string;
}>("shipment.delivered");

@Workflow("order-fulfilment", {
  concurrency: { limit: 2, key: (input: { customerId: string }) => input.customerId },
  rateLimit: { max: 10, duration: "1m", key: (input: { customerId: string }) => input.customerId },
})
@StartOn(OrderPlacedEvent, {
  id: (event) => `order-${event.orderId}`,
  input: (event) => ({
    orderId: event.orderId,
    customerId: event.customerId,
    amount: event.amount,
  }),
  priority: (event) => (event.urgent ? 1 : 5),
  concurrencyKey: (event) => `cust:${event.customerId}`,
  rateLimitKey: (event) => `rate:${event.customerId}`,
})
@SignalOn(OrderShippedEvent, {
  signal: shipmentDelivered,
  key: (event) => event.orderId,
  id: (event) => event.deliveryId,
  payload: (event) => ({
    carrier: event.carrier,
    deliveryId: event.deliveryId,
  }),
})
class OrderFulfilmentWorkflow
  implements
    WorkflowRunner<
      { orderId: string; customerId: string; amount: number },
      { orderId: string; carrier: string; deliveryId: string }
    >
{
  async run(
    ctx: WorkflowContext,
    input: { orderId: string; customerId: string; amount: number },
  ) {
    const shipment = await ctx.waitForSignal(
      "await-delivery",
      shipmentDelivered,
      { key: input.orderId },
    );
    return {
      orderId: input.orderId,
      carrier: shipment?.carrier ?? "none",
      deliveryId: shipment?.deliveryId ?? "none",
    };
  }
}

@Workflow("ping-echo")
@StartOn(SimplePingEvent, {
  id: (event) => `ping-${event.message}`,
})
class PingEchoWorkflow
  implements WorkflowRunner<SimplePingEvent, { echoed: string }>
{
  async run(ctx: WorkflowContext, input: SimplePingEvent) {
    const echoed = await ctx.step("echo", () => input.message.toUpperCase());
    return { echoed };
  }
}

describe("cqrs/WorkflowsCqrsModule end-to-end", () => {
  it("starts workflows via @StartOn(), signals via @SignalOn(), forwards to @EventsHandler(), and supports publishAll()", async () => {
    const handledEvents: IEvent[] = [];

    @EventsHandler(OrderPlacedEvent, OrderShippedEvent, UnroutedAuditEvent)
    class RecordingHandler implements IEventHandler<IEvent> {
      handle(event: IEvent) {
        handledEvents.push(event);
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({
          allowInMemoryStorage: true,
          worker: { pollInterval: 10 },
        }),
        WorkflowsCqrsModule,
      ],
      providers: [OrderFulfilmentWorkflow, PingEchoWorkflow, RecordingHandler],
    }).compile();

    await moduleRef.init();
    try {
      const eventBus = moduleRef.get(EventBus);
      const client = moduleRef.get(WorkflowClient);
      const worker = moduleRef.get(WorkflowWorker);

      // 1. Unrouted event goes directly through to handler without starting workflows
      const audit = new UnroutedAuditEvent("check-1");
      await eventBus.publish(audit);
      await Bun.sleep(10);
      expect(handledEvents).toContain(audit);

      // 2. @StartOn() starts workflow with id, mapped input, priority, concurrencyKey, rateLimitKey
      const placed = new OrderPlacedEvent("o-100", "c-42", 9900, true);
      await eventBus.publish(placed);

      // Instance already exists BEFORE publish() resolves
      const status = await client.getStatus("order-o-100");
      expect(status).not.toBeNull();
      expect(status!.workflow).toBe("order-fulfilment");
      expect(status!.input).toEqual({
        orderId: "o-100",
        customerId: "c-42",
        amount: 9900,
      });
      expect(status!.priority).toBe(1);
      expect(status!.concurrencyKey).toBe("cust:c-42");
      expect(status!.rateLimitKey).toBe("rate:c-42");

      // Idempotent duplicate publish of same event does not fail or create a second instance
      await eventBus.publish(placed);
      expect((await client.list({ workflow: "order-fulfilment" })).length).toBe(1);

      // Drain so the workflow parks on waitForSignal
      await worker.drain();
      expect((await client.getStatus("order-o-100"))!.status).toBe("suspended");

      // 3. @SignalOn() delivers signal with key, id (dedup), and mapped payload -> completes workflow
      const shipped = new OrderShippedEvent("o-100", "del-777", "DHL");
      await eventBus.publish(shipped);
      // Duplicate delivery with same dedupe id is ignored cleanly
      await eventBus.publish(shipped);

      await worker.drain();
      const result = await client.result<{
        orderId: string;
        carrier: string;
        deliveryId: string;
      }>("order-o-100");
      expect(result).toEqual({
        orderId: "o-100",
        carrier: "DHL",
        deliveryId: "del-777",
      });

      // Events also reached @EventsHandler()
      await Bun.sleep(10);
      expect(handledEvents).toContain(placed);
      expect(handledEvents).toContain(shipped);

      // 4. publishAll() with mixed routed (start + signal + default input) and unrouted events
      const order2 = new OrderPlacedEvent("o-200", "c-99", 500, false);
      const shipped2 = new OrderShippedEvent("o-200", "del-888", "UPS");
      const ping = new SimplePingEvent("hello");
      const audit2 = new UnroutedAuditEvent("batch");
      await eventBus.publishAll([order2, shipped2, ping, audit2]);

      await worker.drain();
      expect(
        await client.result<{
          orderId: string;
          carrier: string;
          deliveryId: string;
        }>("order-o-200"),
      ).toEqual({
        orderId: "o-200",
        carrier: "UPS",
        deliveryId: "del-888",
      });
      expect(await client.result<{ echoed: string }>("ping-hello")).toEqual({
        echoed: "HELLO",
      });
      expect((await client.getStatus("order-o-200"))!.priority).toBe(5);
      await Bun.sleep(10);
      expect(handledEvents).toContain(audit2);
    } finally {
      await moduleRef.close();
    }
  });

  it("passes dispatcherContext.transaction to createInTransaction() and signalInTransaction(), and does not forward when writes fail", async () => {
    const txToken = { txId: "tx-abc" };
    const seenCreates: Array<{ tx: unknown; id: string }> = [];
    const seenSignals: Array<{ tx: unknown; name: string; key: string | null }> =
      [];
    let failNextCreate = false;
    const baseStore = new InMemoryWorkflowStore();

    const spyStore: WorkflowStore = {
      create: (i) => baseStore.create(i),
      createInTransaction: async (tx, i) => {
        if (failNextCreate) {
          failNextCreate = false;
          throw new Error("tx write failed");
        }
        seenCreates.push({ tx, id: i.id });
        return baseStore.create(i);
      },
      get: (id, o) => baseStore.get(id, o),
      list: (q) => baseStore.list(q),
      requestCancel: (id, r) => baseStore.requestCancel(id, r),
      reopen: (id, r) => baseStore.reopen(id, r),
      delete: (id, s) => baseStore.delete(id, s),
      signal: (s) => baseStore.signal(s),
      signalInTransaction: async (tx, s) => {
        seenSignals.push({ tx, name: s.name, key: s.key });
        return baseStore.signal(s);
      },
      signals: (q) => baseStore.signals(q),
      purge: (q) => baseStore.purge(q),
      saveSchedule: (s) => baseStore.saveSchedule(s),
      getSchedule: (id) => baseStore.getSchedule(id),
      listSchedules: (q) => baseStore.listSchedules(q),
      deleteSchedule: (id, r) => baseStore.deleteSchedule(id, r),
      claimSchedules: (r) => baseStore.claimSchedules(r),
      writeSchedule: (id, t, w) => baseStore.writeSchedule(id, t, w),
      claim: (r) => baseStore.claim(r),
      renew: (id, t, l) => baseStore.renew(id, t, l),
      write: (id, t, w) => baseStore.write(id, t, w),
    };

    const forwarded: IEvent[] = [];
    const customPublisher: IEventPublisher = {
      publish(event) {
        forwarded.push(event);
      },
      publishAll(events) {
        forwarded.push(...events);
      },
    };

    @Module({})
    class StoreRegistrationModule {
      constructor(storage: WorkflowStorage) {
        storage.registerSource(spyStore);
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot({ eventPublisher: customPublisher }),
        WorkflowsModule.forRoot({ worker: false }),
        StoreRegistrationModule,
        WorkflowsCqrsModule,
      ],
      providers: [OrderFulfilmentWorkflow],
    }).compile();

    await moduleRef.init();
    try {
      const eventBus = moduleRef.get(EventBus);
      const ctx: WorkflowDispatcherContext = { transaction: txToken };

      await eventBus.publishAll(
        [
          new OrderPlacedEvent("tx-1", "cust-1", 100),
          new OrderShippedEvent("tx-1", "del-1", "FedEx"),
        ],
        ctx,
      );

      expect(seenCreates).toEqual([{ tx: txToken, id: "order-tx-1" }]);
      expect(seenSignals).toEqual([
        { tx: txToken, name: "shipment.delivered", key: "tx-1" },
      ]);
      expect(forwarded).toHaveLength(2);

      // When a write fails, publish() rejects and nothing is forwarded
      failNextCreate = true;
      await expect(
        eventBus.publish(new OrderPlacedEvent("tx-fail", "cust-1", 50), ctx),
      ).rejects.toThrow("tx write failed");
      expect(forwarded).toHaveLength(2);
    } finally {
      await moduleRef.close();
    }
  });

  it("supports AggregateRoot.commit({ transaction }) and reports untransacted commit() failures to UnhandledExceptionBus", async () => {
    class OrderAggregate extends AggregateRoot {
      place(orderId: string) {
        this.apply(new OrderPlacedEvent(orderId, "cust-agg", 42));
      }
    }

    const txSeen: unknown[] = [];
    let shouldFail = false;
    const baseStore = new InMemoryWorkflowStore();
    const spyStore: WorkflowStore = {
      create: async (i) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("store unavailable");
        }
        return baseStore.create(i);
      },
      createInTransaction: async (tx, i) => {
        txSeen.push(tx);
        return baseStore.create(i);
      },
      get: (id, o) => baseStore.get(id, o),
      list: (q) => baseStore.list(q),
      requestCancel: (id, r) => baseStore.requestCancel(id, r),
      reopen: (id, r) => baseStore.reopen(id, r),
      delete: (id, s) => baseStore.delete(id, s),
      signal: (s) => baseStore.signal(s),
      signalInTransaction: (_tx, s) => baseStore.signal(s),
      signals: (q) => baseStore.signals(q),
      purge: (q) => baseStore.purge(q),
      saveSchedule: (s) => baseStore.saveSchedule(s),
      getSchedule: (id) => baseStore.getSchedule(id),
      listSchedules: (q) => baseStore.listSchedules(q),
      deleteSchedule: (id, r) => baseStore.deleteSchedule(id, r),
      claimSchedules: (r) => baseStore.claimSchedules(r),
      writeSchedule: (id, t, w) => baseStore.writeSchedule(id, t, w),
      claim: (r) => baseStore.claim(r),
      renew: (id, t, l) => baseStore.renew(id, t, l),
      write: (id, t, w) => baseStore.write(id, t, w),
    };

    @Module({})
    class StoreReg {
      constructor(storage: WorkflowStorage) {
        storage.registerSource(spyStore);
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({ worker: false }),
        StoreReg,
        WorkflowsCqrsModule,
      ],
      providers: [OrderFulfilmentWorkflow],
    }).compile();

    await moduleRef.init();
    try {
      const publisher = moduleRef.get(EventPublisher);
      const unhandledBus = moduleRef.get(UnhandledExceptionBus);
      const client = moduleRef.get(WorkflowClient);

      const caught: UnhandledExceptionInfo<unknown>[] = [];
      unhandledBus.subscribe((info) => {
        caught.push(info);
      });

      // Transacted commit({ transaction })
      const agg1 = publisher.mergeObjectContext(new OrderAggregate());
      agg1.place("agg-1");
      const tx = { id: "db-tx-1" };
      await agg1.commit({ transaction: tx });
      expect(txSeen).toEqual([tx]);
      expect(await client.getStatus("order-agg-1")).not.toBeNull();

      // Untransacted commit() that fails -> reported to UnhandledExceptionBus
      shouldFail = true;
      const agg2 = publisher.mergeObjectContext(new OrderAggregate());
      agg2.place("agg-2");
      await expect(agg2.commit()).rejects.toThrow("store unavailable");
      await Bun.sleep(10);
      expect(caught).toHaveLength(1);
      expect((caught[0]!.exception as Error).message).toBe("store unavailable");
      expect((caught[0]!.cause as OrderPlacedEvent).orderId).toBe("agg-2");
    } finally {
      await moduleRef.close();
    }
  });

  it("starts only the highest registered workflow version, routes signals from all versions, and deduplicates shared signals", async () => {
    class MultiEvent implements IEvent {
      constructor(
        readonly key: string,
        readonly tag: string,
      ) {}
    }
    class SharedSignalEvent implements IEvent {
      constructor(
        readonly key: string,
        readonly value: string,
      ) {}
    }

    @Workflow("versioned-wf", { version: 1 })
    @StartOn(MultiEvent, { id: (e) => `v1-${e.key}` })
    @SignalOn(SharedSignalEvent, {
      signal: "shared.go",
      key: (e) => e.key,
      payload: (e) => ({ value: e.value }),
    })
    class VersionedV1 implements WorkflowRunner<MultiEvent, string> {
      async run(ctx: WorkflowContext, input: MultiEvent) {
        const sig = await ctx.waitForSignal<{ value: string }>(
          "wait",
          "shared.go",
          { key: input.key },
        );
        return `v1:${sig?.value}`;
      }
    }

    @Workflow("versioned-wf", { version: 2 })
    @StartOn(MultiEvent, { id: (e) => `v2-${e.key}` })
    @SignalOn(SharedSignalEvent, {
      signal: "shared.go",
      key: (e) => e.key,
      payload: (e) => ({ value: e.value }),
    })
    class VersionedV2 implements WorkflowRunner<MultiEvent, string> {
      async run(ctx: WorkflowContext, input: MultiEvent) {
        const sig = await ctx.waitForSignal<{ value: string }>(
          "wait",
          "shared.go",
          { key: input.key },
        );
        return `v2:${sig?.value}`;
      }
    }

    const baseStore = new InMemoryWorkflowStore();
    let signalCalls = 0;
    const countingStore: WorkflowStore = {
      ...baseStore,
      create: (i) => baseStore.create(i),
      get: (id, o) => baseStore.get(id, o),
      list: (q) => baseStore.list(q),
      requestCancel: (id, r) => baseStore.requestCancel(id, r),
      reopen: (id, r) => baseStore.reopen(id, r),
      delete: (id, s) => baseStore.delete(id, s),
      signal: (s) => {
        signalCalls++;
        return baseStore.signal(s);
      },
      signals: (q) => baseStore.signals(q),
      purge: (q) => baseStore.purge(q),
      saveSchedule: (s) => baseStore.saveSchedule(s),
      getSchedule: (id) => baseStore.getSchedule(id),
      listSchedules: (q) => baseStore.listSchedules(q),
      deleteSchedule: (id, r) => baseStore.deleteSchedule(id, r),
      claimSchedules: (r) => baseStore.claimSchedules(r),
      writeSchedule: (id, t, w) => baseStore.writeSchedule(id, t, w),
      claim: (r) => baseStore.claim(r),
      renew: (id, t, l) => baseStore.renew(id, t, l),
      write: (id, t, w) => baseStore.write(id, t, w),
    };

    @Module({})
    class CountingStoreModule {
      constructor(storage: WorkflowStorage) {
        storage.registerSource(countingStore);
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({ worker: { pollInterval: 10 } }),
        CountingStoreModule,
        WorkflowsCqrsModule,
      ],
      providers: [VersionedV1, VersionedV2],
    }).compile();

    await moduleRef.init();
    try {
      const eventBus = moduleRef.get(EventBus);
      const client = moduleRef.get(WorkflowClient);
      const worker = moduleRef.get(WorkflowWorker);

      // Start an older v1 instance explicitly, and let MultiEvent start v2 (latest only)
      await client.start("versioned-wf", new MultiEvent("k1", "old"), {
        id: "manual-v1",
        version: 1,
      });
      await eventBus.publish(new MultiEvent("k1", "latest"));

      expect(await client.getStatus("v1-k1")).toBeNull();
      const v2Status = await client.getStatus("v2-k1");
      expect(v2Status).not.toBeNull();
      expect(v2Status!.version).toBe(2);

      await worker.drain();

      // SharedSignalEvent is mapped on both v1 and v2 with agreeing payloads -> sent ONCE, wakes BOTH!
      await eventBus.publish(new SharedSignalEvent("k1", "done"));
      expect(signalCalls).toBe(1);

      await worker.drain();
      expect(await client.result("manual-v1")).toBe("v1:done");
      expect(await client.result("v2-k1")).toBe("v2:done");
    } finally {
      await moduleRef.close();
    }
  });

  it("throws when two @SignalOn() declarations disagree on payload or id for the same event, signal, and key", async () => {
    class ConflictEvent implements IEvent {
      constructor(readonly key: string) {}
    }

    @Workflow("conflict-a")
    @SignalOn(ConflictEvent, {
      signal: "conflict.sig",
      key: (e) => e.key,
      payload: () => ({ from: "a" }),
    })
    class ConflictA implements WorkflowRunner<unknown, void> {
      async run() {}
    }

    @Workflow("conflict-b")
    @SignalOn(ConflictEvent, {
      signal: "conflict.sig",
      key: (e) => e.key,
      payload: () => ({ from: "b" }),
    })
    class ConflictB implements WorkflowRunner<unknown, void> {
      async run() {}
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({ allowInMemoryStorage: true, worker: false }),
        WorkflowsCqrsModule,
      ],
      providers: [ConflictA, ConflictB],
    }).compile();

    await moduleRef.init();
    try {
      const eventBus = moduleRef.get(EventBus);
      await expect(eventBus.publish(new ConflictEvent("k1"))).rejects.toThrow(
        /maps to two different payloads for the signal "conflict\.sig"/,
      );
    } finally {
      await moduleRef.close();
    }
  });

  it("throws startup error when WorkflowsCqrsModule is omitted for a workflow with @StartOn() or @SignalOn()", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({ allowInMemoryStorage: true, worker: false }),
      ],
      providers: [PingEchoWorkflow],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(
      /WorkflowsCqrsModule is not imported/,
    );
    await moduleRef.close();
  });

  it("rejects @StartOn()/@SignalOn() on a non-@Workflow() provider", async () => {
    @Injectable()
    @SignalOn(SimplePingEvent, { signal: "orphan.sig" })
    class NotAWorkflow {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({ allowInMemoryStorage: true, worker: false }),
        WorkflowsCqrsModule,
      ],
      providers: [NotAWorkflow],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(
      /has @StartOn\(\) or @SignalOn\(\) but no @Workflow\(\)/,
    );
    await moduleRef.close();
  });

  it("rejects duplicate @StartOn() / @SignalOn() routes and start keys without per-key limits", async () => {
    @Workflow("dup-start")
    @StartOn(SimplePingEvent, { id: (e) => `a-${e.message}` })
    @StartOn(SimplePingEvent, { id: (e) => `b-${e.message}` })
    class DupStartWorkflow implements WorkflowRunner<SimplePingEvent, void> {
      async run() {}
    }

    const m1 = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({ allowInMemoryStorage: true, worker: false }),
        WorkflowsCqrsModule,
      ],
      providers: [DupStartWorkflow],
    }).compile();
    await expect(m1.init()).rejects.toThrow(/has @StartOn\(SimplePingEvent\) twice/);
    await m1.close();

    @Workflow("no-per-key")
    @StartOn(SimplePingEvent, {
      id: (e) => e.message,
      concurrencyKey: "fixed",
    })
    class NoPerKeyWorkflow implements WorkflowRunner<SimplePingEvent, void> {
      async run() {}
    }

    const m2 = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({ allowInMemoryStorage: true, worker: false }),
        WorkflowsCqrsModule,
      ],
      providers: [NoPerKeyWorkflow],
    }).compile();
    await expect(m2.init()).rejects.toThrow(
      /with a concurrencyKey, but workflow "no-per-key" has no concurrency limit per key/,
    );
    await m2.close();
  });

  it("throws in onApplicationBootstrap() if EventBus.publisher was replaced after WorkflowsCqrsModule installed", async () => {
    @Injectable()
    class PublisherHijacker {
      constructor(eventBus: EventBus) {
        eventBus.publisher = {
          publish() {},
        };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({ allowInMemoryStorage: true, worker: false }),
        WorkflowsCqrsModule,
      ],
      providers: [PingEchoWorkflow, PublisherHijacker],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(
      /EventBus\.publisher was replaced/,
    );
    await moduleRef.close();
  });

  it("validates @StartOn() and @SignalOn() decorator options and runtime mapper outputs", async () => {
    expect(() =>
      StartOn(null as unknown as new () => object, { id: () => "x" }),
    ).toThrow(TypeError);
    expect(() =>
      StartOn(SimplePingEvent, {
        id: "not-a-fn" as unknown as (e: SimplePingEvent) => string,
      }),
    ).toThrow(TypeError);
    expect(() =>
      StartOn(SimplePingEvent, { id: () => "x", priority: -1 }),
    ).toThrow(TypeError);
    expect(() =>
      StartOn(SimplePingEvent, { id: () => "x", concurrencyKey: "" }),
    ).toThrow(TypeError);
    expect(() =>
      StartOn(SimplePingEvent, { id: () => "x", rateLimitKey: "" }),
    ).toThrow(TypeError);
    expect(() =>
      SignalOn("bad" as unknown as new () => object, { signal: "ok" }),
    ).toThrow(TypeError);
    expect(() =>
      SignalOn(SimplePingEvent, { signal: "$reserved" }),
    ).toThrow(TypeError);
    expect(() =>
      SignalOn(SimplePingEvent, {
        signal: "ok",
        key: 123 as unknown as (e: SimplePingEvent) => string,
      }),
    ).toThrow(TypeError);

    // Runtime validation when mapper returns invalid priority / key / id
    @Workflow("bad-runtime-mapper")
    @StartOn(SimplePingEvent, {
      id: (e) => e.message,
      priority: () => 99_999_999,
    })
    @SignalOn(OrderShippedEvent, {
      signal: "sig.bad",
      id: () => "",
    })
    class BadRuntimeMapperWorkflow
      implements WorkflowRunner<SimplePingEvent, void>
    {
      async run() {}
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({ allowInMemoryStorage: true, worker: false }),
        WorkflowsCqrsModule,
      ],
      providers: [BadRuntimeMapperWorkflow],
    }).compile();

    await moduleRef.init();
    try {
      const eventBus = moduleRef.get(EventBus);
      await expect(eventBus.publish(new SimplePingEvent("p"))).rejects.toThrow(
        /invalid|`priority` returned/,
      );
      await expect(
        eventBus.publish(new OrderShippedEvent("o1", "d1", "UPS")),
      ).rejects.toThrow(/`id` returned an empty string/);
    } finally {
      await moduleRef.close();
    }
  });

  it("handles duplicate @SignalOn(), disagreeing signal ids, empty routes warning, and exact subpath exports", async () => {
    // 1. Duplicate @SignalOn() for same event + signal
    @Workflow("dup-signal")
    @SignalOn(SimplePingEvent, { signal: "ping.sig" })
    @SignalOn(SimplePingEvent, { signal: "ping.sig" })
    class DupSignalWorkflow implements WorkflowRunner<unknown, void> {
      async run() {}
    }

    const mDup = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({ allowInMemoryStorage: true, worker: false }),
        WorkflowsCqrsModule,
      ],
      providers: [DupSignalWorkflow],
    }).compile();
    await expect(mDup.init()).rejects.toThrow(
      /has @SignalOn\(SimplePingEvent\) for the signal "ping\.sig" twice/,
    );
    await mDup.close();

    // 2. Disagreeing signal ids across two workflows
    class IdConflictEvent implements IEvent {
      constructor(readonly key: string) {}
    }

    @Workflow("id-conflict-a")
    @SignalOn(IdConflictEvent, {
      signal: "id.sig",
      key: (e) => e.key,
      id: () => "id-a",
    })
    class IdConflictA implements WorkflowRunner<unknown, void> {
      async run() {}
    }

    @Workflow("id-conflict-b")
    @SignalOn(IdConflictEvent, {
      signal: "id.sig",
      key: (e) => e.key,
      id: () => "id-b",
    })
    class IdConflictB implements WorkflowRunner<unknown, void> {
      async run() {}
    }

    const mIdConflict = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({ allowInMemoryStorage: true, worker: false }),
        WorkflowsCqrsModule,
      ],
      providers: [IdConflictA, IdConflictB],
    }).compile();
    await mIdConflict.init();
    try {
      const eventBus = mIdConflict.get(EventBus);
      await expect(eventBus.publish(new IdConflictEvent("k1"))).rejects.toThrow(
        /maps to two different ids for the signal "id\.sig"/,
      );
    } finally {
      await mIdConflict.close();
    }

    // 3. WorkflowsCqrsModule with no mapped workflows initializes cleanly (logs warning)
    const mEmpty = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        WorkflowsModule.forRoot({ allowInMemoryStorage: true, worker: false }),
        WorkflowsCqrsModule,
      ],
    }).compile();
    await mEmpty.init();
    await mEmpty.close();

    // 4. Exact subpath runtime export keys
    const cqrsExports = await import("../src/cqrs/index");
    expect(Object.keys(cqrsExports).sort()).toEqual([
      "SignalOn",
      "StartOn",
      "WorkflowsCqrsModule",
    ]);

    const testingExports = await import("../src/testing/index");
    expect(Object.keys(testingExports).sort()).toEqual([
      "scheduleStoreContract",
      "workflowStoreContract",
    ]);
  });
});
