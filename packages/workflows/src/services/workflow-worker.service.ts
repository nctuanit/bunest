import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from "@bunest/common";
import type {
  LeasedRun,
  LeaseRequest,
} from "../core/interfaces/leased-worker-options.interface";
import type { ScheduleProduction } from "../core/interfaces/scheduler-options.interface";
import { resolveRetry } from "../core/retries/retry";
import { systemClock } from "../core/time/clock";
import { LeasedWorker } from "../core/workers/leased-worker";
import { isWorkflowInterrupt } from "../errors/workflow-interrupt.error";
import { WorkflowNonDeterminismError } from "../errors/workflow-non-determinism.error";
import type {
  WorkflowEvent,
  WorkflowEventBase,
} from "../events/workflow-events.interface";
import { WorkflowEvents } from "../events/workflow-events.service";
import type { SerializedWorkflowError } from "../interfaces/serialized-workflow-error.interface";
import type { WorkflowClock } from "../interfaces/workflow-clock.interface";
import type {
  WorkflowInstance,
  WorkflowStatus,
  WorkflowWait,
} from "../interfaces/workflow-instance.interface";
import type {
  WorkflowInstanceDetails,
  WorkflowRelease,
  WorkflowWrite,
} from "../interfaces/workflow-store.interface";
import type { WorkflowsModuleOptions } from "../interfaces/workflows-module-options.interface";
import type { EncodedWorkflowStore } from "../storage/encoded-workflow.store";
import { ENGINE_STORE, WorkflowStorage } from "../storage/workflow.storage";
import { resolveJournalLimits } from "../utils/journal-limits.util";
import { assertSameInstance } from "../utils/new-instance.util";
import { normalize } from "../utils/normalize.util";
import { serializeError } from "../utils/serialize-error.util";
import { assertStorableJson } from "../utils/storable-text.util";
import { CHILD_ENDED_SIGNAL } from "../workflows.constants";
import { WORKFLOWS_MODULE_OPTIONS } from "../workflows.module-definition";
import {
  uniqueEntries,
  WorkflowExecution,
  type ClaimedWorkflowInstance,
  type ExecutionDeps,
  type RunOutcome,
} from "./workflow-execution.service";
import { WorkflowRegistry } from "./workflow-registry.service";
import { WorkflowScheduler } from "./workflow-scheduler.service";

interface ClaimedItem {
  instance: ClaimedWorkflowInstance;
  signalCursor: number;
  exec?: WorkflowExecution;
}

type EventBody =
  WorkflowEvent extends infer E
    ? E extends WorkflowEventBase
      ? Omit<E, keyof WorkflowEventBase>
      : never
    : never;

const FAILED: Record<"claim" | "produce" | "execute", string> = {
  claim: "Claiming workflow instances failed.",
  produce: "Starting the schedules' occurrences failed.",
  execute: "Executing a workflow instance failed.",
};

const RUNNABLE: WorkflowStatus[] = [
  "pending",
  "running",
  "suspended",
  "compensating",
];
const CHILDREN_PAGE = 500;

/**
 * Claims due instances under a lease, executes them and records the outcome.
 */
@Injectable()
export class WorkflowWorker
  implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown
{
  readonly id: string;
  private readonly logger = new Logger("Workflows");
  private readonly clock: WorkflowClock;
  private readonly deps: ExecutionDeps;
  private readonly enabled: boolean;
  private readonly leased: LeasedWorker<ClaimedItem>;

  constructor(
    private readonly storage: WorkflowStorage,
    @Inject(WORKFLOWS_MODULE_OPTIONS)
    options: WorkflowsModuleOptions,
    private readonly registry: WorkflowRegistry,
    private readonly events: WorkflowEvents,
    private readonly scheduler: WorkflowScheduler,
  ) {
    const worker =
      options.worker === false ? { enabled: false } : (options.worker ?? {});
    this.clock = options.clock ?? systemClock;
    this.enabled = worker.enabled ?? true;
    this.leased = new LeasedWorker<ClaimedItem>({
      name: "worker",
      owner: worker.id,
      concurrency: worker.concurrency,
      pollInterval: worker.pollInterval,
      leaseDuration: worker.leaseDuration,
      heartbeatInterval: worker.heartbeatInterval,
      shutdownTimeout: worker.shutdownTimeout,
      clock: this.clock,
      produceInterval: "1s",
      produce: async () =>
        this.produced(
          await this.scheduler.produce(this.id, this.leased.leaseMs),
        ),
      claim: (lease, limit) => this.claim(lease, limit),
      renew: (claimed, until) => this.renew(claimed, until),
      execute: (claimed, run) => this.execute(claimed, run),
      onError: (error, stage) => this.logger.error(FAILED[stage], error),
    });
    this.id = this.leased.owner;
    const self = this;
    this.deps = {
      get store() {
        return storage[ENGINE_STORE];
      },
      textCheck: (place) => storage[ENGINE_STORE].textCheck(place),
      resolve: (workflow, version) => registry.resolve(workflow, version),
      createChild: async (child) => {
        const { instance, created } = await storage[ENGINE_STORE].create(child);
        if (created) {
          self.kick();
        } else {
          assertSameInstance(instance, child, { input: true, parent: true });
        }
        return instance;
      },
      clock: this.clock,
      events,
      defaultRetry: resolveRetry(options.retry),
      journalLimits: resolveJournalLimits(options.journal),
    };
  }

  onApplicationBootstrap(): void {
    this.registry.keys();
    if (this.enabled) {
      this.leased.start();
    }
  }

  private get store(): EncodedWorkflowStore {
    return this.storage[ENGINE_STORE];
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.shutdown();
  }

  kick(): void {
    this.leased.kick();
  }

  noticeCancel(id: string, terminate = false): void {
    for (const { exec } of this.leased.running) {
      if (exec?.instance.id === id) {
        exec.cancelRequested = true;
        exec.terminateRequested ||= terminate;
      }
    }
    this.kick();
  }

  drain(options: { maxRounds?: number } = {}): Promise<number> {
    return this.leased.drain(options);
  }

  private produced(production: ScheduleProduction): number {
    for (const id of production.cancelled) {
      this.noticeCancel(id);
    }
    return production.started;
  }

  shutdown(): Promise<void> {
    return this.leased.shutdown();
  }

  private async claim(
    lease: LeaseRequest,
    limit: number,
  ): Promise<ClaimedItem[]> {
    const workflows = this.registry.versions();
    if (workflows.length === 0) {
      return [];
    }
    const { instances, lastSignalId } = await this.store.claim({
      owner: lease.owner,
      token: lease.token,
      now: lease.now,
      leaseUntil: lease.until,
      limit,
      workflows,
      limits: this.registry.limits(),
      rateLimits: this.registry.rateLimits(),
    });
    return instances.map((instance) => ({
      instance: { ...instance, leaseToken: lease.token },
      signalCursor: lastSignalId,
    }));
  }

  private async renew(claimed: ClaimedItem, until: number): Promise<boolean> {
    const { instance, exec } = claimed;
    const flags = await this.store.renew(
      instance.id,
      instance.leaseToken,
      until,
    );
    if (flags && exec) {
      exec.cancelRequested ||= flags.cancelRequested;
      exec.terminateRequested ||= flags.terminateRequested;
    }
    return flags !== null;
  }

  private async execute(claimed: ClaimedItem, run: LeasedRun): Promise<void> {
    const { instance, signalCursor } = claimed;
    const definition = this.registry.get(instance.workflow, instance.version)!;
    try {
      const details = await this.claimed(instance, signalCursor);
      if (!details) {
        return;
      }
      const replayOnly =
        instance.status === "compensating" || instance.cancelRequested;
      const exec = new WorkflowExecution(
        instance,
        details.journal ?? [],
        signalCursor,
        this.deps,
        run,
        replayOnly,
      );
      claimed.exec = exec;
      if (instance.terminateRequested) {
        await this.terminate(exec, instance);
        return;
      }
      this.emit(
        instance,
        instance.runs === 1
          ? { type: "workflow-started" }
          : { type: "workflow-resumed", run: instance.runs },
      );
      const outcome = await exec.run(async () =>
        definition.instance.run(exec.context, instance.input),
      );
      await this.conclude(exec, instance, outcome);
    } catch (error) {
      this.logger.error(
        `Executing "${instance.id}" (${instance.workflow}@${instance.version}) failed; it is retried when its lease expires.`,
        error,
      );
    }
  }

  private async claimed(
    instance: ClaimedWorkflowInstance,
    signalCursor: number,
  ): Promise<WorkflowInstanceDetails | null> {
    let details: WorkflowInstanceDetails | null;
    try {
      details = await this.store.get(instance.id, { journal: true });
    } catch (error) {
      this.logger.error(
        `Instance "${instance.id}" can't be read, so it isn't run; it is claimed again later.`,
        error,
      );
      const lease = {
        now: this.clock.now(),
        leaseUntil: instance.leaseUntil!,
        signalCursor,
      };
      await this.storage[ENGINE_STORE]
        .handBack(instance.id, instance.leaseToken, lease)
        .catch(() => undefined);
      return null;
    }
    if (!details) {
      throw new Error(
        `The store has no instance "${instance.id}", which it just leased.`,
      );
    }
    return details;
  }

  private async conclude(
    exec: WorkflowExecution,
    instance: ClaimedWorkflowInstance,
    outcome: RunOutcome,
  ): Promise<void> {
    if (await this.interrupted(exec, instance, outcome.ok)) {
      return;
    }
    if (exec.fatal) {
      return this.finish(exec, instance, "failed", {
        error: serializeError(exec.fatal),
      });
    }
    if (instance.status === "compensating") {
      return this.compensate(
        exec,
        instance,
        instance.error ?? { name: "Error", message: "Unknown failure." },
        true,
      );
    }
    if (instance.cancelRequested) {
      return this.compensate(
        exec,
        instance,
        cancelled(instance.cancelReason),
        false,
      );
    }
    if (
      !outcome.ok &&
      isWorkflowInterrupt(outcome.error) &&
      outcome.error.reason === "cancel"
    ) {
      const current = await this.store.get(instance.id);
      if (current?.terminateRequested) {
        return this.finish(exec, instance, "cancelled", {
          error: terminated(current.cancelReason),
        });
      }
      return this.compensate(
        exec,
        instance,
        cancelled(current?.cancelReason ?? null),
        false,
      );
    }
    if (
      !outcome.ok &&
      isWorkflowInterrupt(outcome.error) &&
      outcome.error.reason === "timeout"
    ) {
      return this.compensate(exec, instance, timedOut(instance), false);
    }
    if (exec.journalLimitError) {
      return this.compensate(exec, instance, exec.journalLimitError, false);
    }
    if (exec.suspension) {
      const { waits } = exec.suspension;
      const wakeAt =
        instance.deadline === null
          ? exec.suspension.wakeAt
          : Math.min(
              exec.suspension.wakeAt ?? instance.deadline,
              instance.deadline,
            );
      const ok = await this.write(exec, instance, {
        entries: exec.drainBuffer(),
        status: "suspended",
        release: this.release(exec, wakeAt, waits),
      });
      if (ok) {
        this.emit(instance, { type: "workflow-suspended", wakeAt, waits });
      } else {
        this.leaseLostWarning(instance);
      }
      return;
    }
    if (outcome.ok) {
      const missing = exec.unvisited();
      if (missing.length) {
        const error = new WorkflowNonDeterminismError(
          `Instance "${instance.id}" of workflow "${instance.workflow}@${instance.version}" does not match its journal: ` +
            `${missing.map((n) => `"${n}"`).join(", ")} ${missing.length === 1 ? "was" : "were"} recorded by an earlier run but never reached. ` +
            "Ship step removals as a new workflow version.",
        );
        return this.finish(exec, instance, "failed", {
          error: serializeError(error),
        });
      }
      let output: unknown;
      try {
        output = normalize(outcome.value);
        assertStorableJson(
          "Workflow output",
          output,
          this.store.textCheck("payload"),
        );
      } catch (error) {
        return this.compensate(exec, instance, serializeError(error), false);
      }
      return this.finish(exec, instance, "completed", { output });
    }
    return this.compensate(
      exec,
      instance,
      serializeError(outcome.error),
      false,
    );
  }

  private async compensate(
    exec: WorkflowExecution,
    instance: ClaimedWorkflowInstance,
    reason: SerializedWorkflowError,
    alreadyCompensating: boolean,
  ): Promise<void> {
    if (!alreadyCompensating) {
      const ok = await this.write(exec, instance, {
        entries: exec.drainBuffer(),
        status: "compensating",
        error: reason,
      });
      if (!ok) {
        return this.leaseLostWarning(instance);
      }
      this.emit(instance, { type: "workflow-compensating", error: reason });
    }
    await this.closeChildren(
      exec,
      instance,
      `its parent "${instance.id}" is compensating (${reason.name}: ${reason.message})`,
    );
    const result = await exec.compensate(reason);
    switch (result.state) {
      case "done":
        return this.finish(
          exec,
          instance,
          reason.name === "WorkflowCancelledError" ? "cancelled" : "failed",
          { error: reason },
        );
      case "failed":
        return this.finish(exec, instance, "compensation_failed", {
          error: { ...reason, compensation: result.error },
        });
      case "suspended": {
        const ok = await this.write(exec, instance, {
          entries: exec.drainBuffer(),
          status: "compensating",
          release: this.release(exec, result.wakeAt, []),
        });
        if (ok) {
          this.emit(instance, {
            type: "workflow-suspended",
            wakeAt: result.wakeAt,
            waits: [],
          });
        }
        return;
      }
      case "interrupted":
        await this.interrupted(exec, instance, false);
        return;
      case "terminated":
        return this.terminate(exec, instance);
    }
  }

  private async closeChildren(
    exec: WorkflowExecution,
    instance: ClaimedWorkflowInstance,
    reason: string,
  ): Promise<void> {
    if (!exec.hasChildren()) {
      return;
    }
    for (let offset = 0; ; offset += CHILDREN_PAGE) {
      const children = await this.storage[ENGINE_STORE].inner.list({
        parentId: instance.id,
        limit: CHILDREN_PAGE,
        offset,
      });
      for (const child of children) {
        if (
          !RUNNABLE.includes(child.status) ||
          child.parentClose === "abandon" ||
          child.parentClose === null
        ) {
          continue;
        }
        const terminate = child.parentClose === "terminate";
        const reasonText = `${terminate ? "Terminated" : "Cancelled"}: ${reason}.`;
        if (
          await this.store.requestCancel(child.id, {
            reason: reasonText,
            now: this.clock.now(),
            terminate,
          })
        ) {
          this.noticeCancel(child.id, terminate);
        }
      }
      if (children.length < CHILDREN_PAGE) {
        return;
      }
    }
  }

  private async terminate(
    exec: WorkflowExecution,
    instance: ClaimedWorkflowInstance,
  ): Promise<void> {
    const current = await this.store.get(instance.id);
    return this.finish(exec, instance, "cancelled", {
      error: terminated(current?.cancelReason ?? instance.cancelReason),
    });
  }

  private async interrupted(
    exec: WorkflowExecution,
    instance: ClaimedWorkflowInstance,
    finished: boolean,
  ): Promise<boolean> {
    if (exec.leaseLost) {
      this.leaseLostWarning(instance);
      return true;
    }
    if (exec.storeError) {
      this.logger.error(
        `Store failed while executing "${instance.id}"; it is retried when its lease expires.`,
        exec.storeError,
      );
      return true;
    }
    if (exec.detached) {
      return true;
    }
    if (exec.shuttingDown && !finished) {
      await this.write(exec, instance, {
        entries: [...exec.drainBuffer(), ...exec.rollbacks],
        release: this.release(exec, this.clock.now(), []),
      });
      return true;
    }
    return false;
  }

  private async finish(
    exec: WorkflowExecution,
    instance: ClaimedWorkflowInstance,
    status: "completed" | "failed" | "cancelled" | "compensation_failed",
    result: { output?: unknown; error?: SerializedWorkflowError },
  ): Promise<void> {
    await this.closeChildren(
      exec,
      instance,
      `its parent "${instance.id}" ended as ${status}`,
    );
    const entries = exec.drainBuffer();
    if (status !== "completed") {
      entries.push(
        ...exec
          .abandoned()
          .map((entry) => ({ ...entry, updatedAt: this.clock.now() })),
      );
    }
    const ended = {
      status,
      output: result.output,
      error: result.error ?? null,
    };
    const ok = await this.write(exec, instance, {
      entries,
      status,
      output: result.output,
      error: result.error ?? null,
      release: this.release(exec, null, []),
      ...(instance.parentId === null
        ? {}
        : {
            signal: {
              name: CHILD_ENDED_SIGNAL,
              key: instance.id,
              dedupeId: instance.id,
              payload: ended,
              now: this.clock.now(),
            },
          }),
    });
    if (!ok) {
      return this.leaseLostWarning(instance);
    }
    if (status === "completed") {
      this.emit(instance, {
        type: "workflow-completed",
        output: result.output,
      });
    } else if (status === "cancelled") {
      this.emit(instance, {
        type: "workflow-cancelled",
        error: result.error!,
      });
    } else if (status === "failed") {
      this.emit(instance, { type: "workflow-failed", error: result.error! });
    } else {
      this.emit(instance, {
        type: "workflow-compensation-failed",
        error: result.error!,
      });
    }
  }

  private async write(
    exec: WorkflowExecution,
    instance: ClaimedWorkflowInstance,
    write: Omit<WorkflowWrite, "now">,
  ): Promise<boolean> {
    const change = exec.statusChange();
    const ok = await this.store.write(instance.id, instance.leaseToken, {
      ...write,
      ...change,
      entries: uniqueEntries(write.entries),
      now: this.clock.now(),
    });
    if (ok) {
      exec.statusWritten(change);
    }
    return ok;
  }

  private release(
    exec: WorkflowExecution,
    wakeAt: number | null,
    waits: WorkflowWait[],
  ): WorkflowRelease {
    return { wakeAt, waits, signalCursor: exec.signalCursor };
  }

  private leaseLostWarning(instance: WorkflowInstance): void {
    this.logger.warn(
      `Lost the lease on "${instance.id}" (${instance.workflow}); another worker took over. Nothing from this execution after that point was recorded.`,
    );
  }

  private emit(instance: WorkflowInstance, body: EventBody): void {
    this.events.emit({
      id: instance.id,
      workflow: instance.workflow,
      version: instance.version,
      at: this.clock.now(),
      ...body,
    } as WorkflowEvent);
  }
}

function cancelled(reason: string | null): SerializedWorkflowError {
  return { name: "WorkflowCancelledError", message: reason ?? "Cancelled." };
}

function terminated(reason: string | null): SerializedWorkflowError {
  return { name: "WorkflowTerminatedError", message: reason ?? "Terminated." };
}

function timedOut(instance: WorkflowInstance): SerializedWorkflowError {
  return {
    name: "WorkflowTimeoutError",
    message:
      `Instance "${instance.id}" of workflow "${instance.workflow}@${instance.version}" did not finish within its timeout ` +
      `(its deadline was ${new Date(instance.deadline!).toISOString()}).`,
  };
}
