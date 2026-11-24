import { MemoryQueueDriver } from "./drivers/memory.driver";
import type {
  FlowJob,
  FlowJobNode,
  FlowNodeOpts,
  FlowOpts,
  Job,
  QueueDriver,
  RegisterFlowProducerOptions,
} from "./interfaces";
import { Queue } from "./queue";

export interface FlowProducerQueueResolver {
  get(name: string): Queue<any, any> | undefined;
  register?(queue: Queue<any, any>): void;
}

/**
 * Lightweight, zero-dependency Bun-native `FlowProducer` implementing BullMQ's
 * parent-child DAG job orchestration across queues.
 *
 * Leaf child jobs execute first on their target queues; once every child of a
 * parent node completes, the parent job is automatically enqueued with
 * `job.childrenValues` and `job.getChildrenValues()` populated from child return values.
 */
export class FlowProducer {
  public readonly opts: RegisterFlowProducerOptions;

  private readonly queueResolver?: FlowProducerQueueResolver;
  private readonly fallbackDriver?: QueueDriver;
  private readonly ownedQueues = new Map<string, Queue<any, any>>();
  private readonly nodesByKey = new Map<string, FlowJobNode>();
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  private readonly unbinders = new Set<() => void>();
  private closed = false;

  constructor(
    opts: RegisterFlowProducerOptions = {},
    queueResolver?: FlowProducerQueueResolver,
    fallbackDriver?: QueueDriver,
  ) {
    this.opts = opts;
    this.queueResolver = queueResolver;
    this.fallbackDriver = fallbackDriver;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  async waitUntilReady(): Promise<void> {
    return;
  }

  async add(flow: FlowJob, opts?: FlowOpts): Promise<FlowJobNode> {
    if (this.closed) {
      throw new Error("FlowProducer is closed and cannot accept flows.");
    }
    return await this.addNode(flow, opts);
  }

  async addBulk(
    flows: readonly FlowJob[],
    opts?: FlowOpts,
  ): Promise<FlowJobNode[]> {
    const results: FlowJobNode[] = [];
    for (const flow of flows) {
      results.push(await this.add(flow, opts));
    }
    return results;
  }

  async getFlow(opts: FlowNodeOpts): Promise<FlowJobNode | null> {
    const key = this.nodeKey(opts.queueName, opts.id);
    const cached = this.nodesByKey.get(key);
    if (!cached) {
      return null;
    }
    const maxDepth = opts.depth;
    if (maxDepth !== undefined && maxDepth <= 1) {
      return { job: cached.job };
    }
    return cached;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const unbind of this.unbinders) {
      unbind();
    }
    this.unbinders.clear();
    await Promise.all([...this.ownedQueues.values()].map((q) => q.close()));
    this.ownedQueues.clear();
    this.listeners.clear();
  }

  private resolveQueue(queueName: string): Queue<any, any> {
    const fromRegistry = this.queueResolver?.get(queueName);
    if (fromRegistry) {
      return fromRegistry;
    }
    let owned = this.ownedQueues.get(queueName);
    if (!owned) {
      owned = new Queue({
        name: queueName,
        driver: this.fallbackDriver ?? new MemoryQueueDriver(),
      });
      this.ownedQueues.set(queueName, owned);
      this.queueResolver?.register?.(owned);
    }
    return owned;
  }

  private nodeKey(queueName: string, jobId: string): string {
    return `${queueName}:${jobId}`;
  }

  private emitError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    const set = this.listeners.get("error");
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(error);
      } catch {
        // Ignore error listener failure
      }
    }
  }

  private async addNode(flow: FlowJob, opts?: FlowOpts): Promise<FlowJobNode> {
    const queue = this.resolveQueue(flow.queueName);
    const mergedJobOpts = {
      ...opts?.queuesOptions?.[flow.queueName]?.defaultJobOptions,
      ...flow.opts,
    };

    const children = flow.children ?? [];
    if (children.length === 0) {
      const job = await queue.add(flow.name, flow.data, mergedJobOpts);
      const node: FlowJobNode = { job };
      this.nodesByKey.set(this.nodeKey(flow.queueName, job.id), node);
      return node;
    }

    // Create a stable parent jobId upfront so callers can inspect parentNode.job.id immediately
    const parentJobId =
      mergedJobOpts.jobId ??
      `${flow.queueName}:flow:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;

    const childNodes: FlowJobNode[] = [];
    const pendingChildren = new Set<string>();
    const childrenValues: Record<string, unknown> = {};
    const childUnbinders: Array<() => void> = [];

    const now = Date.now();
    const pendingParentJob: Job<any, any> = {
      id: parentJobId,
      queueName: flow.queueName,
      name: flow.name,
      data: flow.data,
      priority: mergedJobOpts.priority ?? 0,
      idempotencyKey: mergedJobOpts.idempotencyKey,
      maxAttempts: Math.max(1, Math.floor(mergedJobOpts.attempts ?? 1)),
      attemptsMade: 0,
      status: "waiting",
      backoff: mergedJobOpts.backoff,
      timeoutMs: mergedJobOpts.timeoutMs,
      removeOnComplete: Boolean(mergedJobOpts.removeOnComplete ?? false),
      createdAt: now,
      processAfter:
        now + Math.max(0, mergedJobOpts.delayMs ?? mergedJobOpts.delay ?? 0),
      stacktrace: [],
      childrenValues,
      getChildrenValues: async <T = unknown>() =>
        ({ ...childrenValues }) as Record<string, T>,
    };

    const parentNode: FlowJobNode = {
      job: pendingParentJob,
      children: childNodes,
    };
    this.nodesByKey.set(this.nodeKey(flow.queueName, parentJobId), parentNode);

    let registering = true;
    let parentDispatched = false;
    const cleanupChildListeners = () => {
      for (const unbind of childUnbinders.splice(0)) {
        unbind();
        this.unbinders.delete(unbind);
      }
    };

    const maybeEnqueueParent = async () => {
      if (
        registering ||
        parentDispatched ||
        pendingChildren.size > 0 ||
        this.closed
      ) {
        return;
      }
      parentDispatched = true;
      cleanupChildListeners();
      try {
        await queue.add(flow.name, flow.data, {
          ...mergedJobOpts,
          jobId: parentJobId,
          childrenValues: { ...childrenValues },
        });
      } catch (err) {
        this.emitError(err);
      }
    };

    // Pre-assign stable child job IDs, populate pendingChildren, and subscribe
    // completion listeners BEFORE enqueuing any child so fast children can never
    // race ahead of later sibling registrations or miss completion events.
    const preparedChildren = children.map((childFlow) => {
      const childJobId =
        childFlow.opts?.jobId ??
        `${childFlow.queueName}:flow:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
      const childKey = `${childFlow.prefix ?? this.opts.prefix ?? "bull"}:${childFlow.queueName}:${childJobId}`;
      const childQueue = this.resolveQueue(childFlow.queueName);
      pendingChildren.add(childKey);

      const onCompleted = (completedJob: Job<any, any>, result?: unknown) => {
        if (completedJob.id !== childJobId) {
          return;
        }
        if (!pendingChildren.has(childKey)) {
          return;
        }
        pendingChildren.delete(childKey);
        childrenValues[childKey] = result ?? completedJob.returnValue;
        void maybeEnqueueParent();
      };

      const unbind = childQueue.on("completed", onCompleted);
      childUnbinders.push(unbind);
      this.unbinders.add(unbind);

      return { childFlow, childJobId, childKey, childQueue };
    });

    try {
      for (const {
        childFlow,
        childJobId,
        childKey,
        childQueue,
      } of preparedChildren) {
        const childNode = await this.addNode(
          {
            ...childFlow,
            opts: { ...childFlow.opts, jobId: childJobId },
          },
          opts,
        );
        childNodes.push(childNode);

        // Fallback if child already existed and was completed prior to addNode()
        if (pendingChildren.has(childKey)) {
          const latest = await childQueue.getJob(childNode.job.id);
          if (latest && latest.status === "completed") {
            pendingChildren.delete(childKey);
            childrenValues[childKey] = latest.returnValue;
          }
        }
      }
    } catch (err) {
      cleanupChildListeners();
      throw err;
    }

    registering = false;
    if (pendingChildren.size === 0) {
      await maybeEnqueueParent();
    }

    return parentNode;
  }
}
