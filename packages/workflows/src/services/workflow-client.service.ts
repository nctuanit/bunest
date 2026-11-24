import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type Type,
} from "@bunest/core";
import type { ResultOutcome } from "../core/interfaces/result-waiter-options.interface";
import { ResultWaiter } from "../core/results/result-waiter";
import { systemClock } from "../core/time/clock";
import { parseDuration } from "../core/time/duration";
import {
  WorkflowFailedError,
  type WorkflowFailureStatus,
} from "../errors/workflow-failed.error";
import { WorkflowIdConflictError } from "../errors/workflow-id-conflict.error";
import { WorkflowNotFoundError } from "../errors/workflow-not-found.error";
import { WorkflowResultTimeoutError } from "../errors/workflow-result-timeout.error";
import { WorkflowStateError } from "../errors/workflow-state.error";
import type {
  WorkflowEvent,
  WorkflowEventBase,
} from "../events/workflow-events.interface";
import { WorkflowEvents } from "../events/workflow-events.service";
import type { SerializedWorkflowError } from "../interfaces/serialized-workflow-error.interface";
import type {
  SignalWorkflowOptions,
  StartWorkflowOptions,
  WorkflowCancelResult,
  WorkflowDeleteOptions,
  WorkflowListFilter,
  WorkflowPurgeOptions,
  WorkflowResultOptions,
  WorkflowRetryInstanceOptions,
  WorkflowSignalSendResult,
  WorkflowStartResult,
} from "../interfaces/workflow-client.interface";
import type { WorkflowClock } from "../interfaces/workflow-clock.interface";
import type {
  Journaled,
  WorkflowInput,
  WorkflowOutput,
} from "../interfaces/workflow-context.interface";
import type {
  WorkflowInstance,
  WorkflowJournalEntry,
  WorkflowStatus,
} from "../interfaces/workflow-instance.interface";
import type {
  WorkflowInstanceDetails,
  WorkflowPurgeResult,
} from "../interfaces/workflow-store.interface";
import type { WorkflowsModuleOptions } from "../interfaces/workflows-module-options.interface";
import { signalName, type WorkflowSignal } from "../signals/workflow.signal";
import type { EncodedWorkflowStore } from "../storage/encoded-workflow.store";
import { ENGINE_STORE, WorkflowStorage } from "../storage/workflow.storage";
import { assertSameInstance, newInstance } from "../utils/new-instance.util";
import { normalize } from "../utils/normalize.util";
import { runTimeoutMs } from "../utils/run-timeout.util";
import { stepSignalId, stepStartId } from "../utils/step-scope.util";
import {
  assertStorableJson,
  assertStorableText,
} from "../utils/storable-text.util";
import { CHILD_ENDED_SIGNAL } from "../workflows.constants";
import { WORKFLOWS_MODULE_OPTIONS } from "../workflows.module-definition";
import { WorkflowRegistry } from "./workflow-registry.service";
import { WorkflowSchedules } from "./workflow-schedules.service";
import { WorkflowWorker } from "./workflow-worker.service";

type EventBody = WorkflowEvent extends infer E
  ? E extends WorkflowEventBase
    ? Omit<E, keyof WorkflowEventBase>
    : never
  : never;

const FINISHED: WorkflowStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "compensation_failed",
];
const FAILURES: Record<string, WorkflowFailureStatus> = {
  "workflow-failed": "failed",
  "workflow-cancelled": "cancelled",
  "workflow-compensation-failed": "compensation_failed",
};
const DEFAULT_PURGE: WorkflowStatus[] = ["completed", "failed", "cancelled"];
const ALL: WorkflowStatus[] = [
  "pending",
  "running",
  "suspended",
  "compensating",
  ...FINISHED,
];

/** Starts, signals, inspects and cancels workflow instances. Works with or without a local worker. */
@Injectable()
export class WorkflowClient implements BeforeApplicationShutdown {
  private readonly clock: WorkflowClock;
  private readonly results: ResultWaiter;

  constructor(
    private readonly storage: WorkflowStorage,
    @Inject(WORKFLOWS_MODULE_OPTIONS)
    options: WorkflowsModuleOptions,
    private readonly registry: WorkflowRegistry,
    private readonly worker: WorkflowWorker,
    private readonly events: WorkflowEvents,
    readonly schedules: WorkflowSchedules,
  ) {
    this.clock = options.clock ?? systemClock;
    this.results = new ResultWaiter({
      read: (id) => this.outcomeOf(id),
      timeoutError: (id, timeoutMs) =>
        new WorkflowResultTimeoutError(id, timeoutMs),
      closedError: (id) =>
        new Error(
          `The application shut down while waiting for the result of instance "${id}".`,
        ),
    });
    this.events.events$.subscribe((event) => {
      if (isEnded(event)) {
        this.results.settle(event.id, () => outcome(event));
      }
    });
  }

  private get store(): EncodedWorkflowStore {
    return this.storage[ENGINE_STORE];
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.results.close();
  }

  async start<W>(
    workflow: Type<W> | string,
    input: WorkflowInput<W>,
    options: StartWorkflowOptions = {},
  ): Promise<WorkflowStartResult> {
    const resolved = this.registry.resolve(workflow, options.version);
    const derived =
      options.id === undefined ? stepStartId(resolved.name) : undefined;
    const id = options.id ?? derived ?? crypto.randomUUID();
    const data = newInstance(resolved, id, input, {
      caller: "start()",
      now: this.clock.now(),
      text: this.store.textCheck,
      timeout: options.timeout,
      concurrencyKey: options.concurrencyKey,
      rateLimitKey: options.rateLimitKey,
      priority: options.priority,
    });
    const { instance, created } = await (options.transaction === undefined
      ? this.store.create(data)
      : this.storeMethod("createInTransaction", "start")(
          options.transaction,
          data,
        ));
    if (!created) {
      assertSameInstance(instance, data, {
        input: derived === undefined,
        parent: false,
      });
    } else {
      this.worker.kick();
    }
    return {
      id: data.id,
      workflow: data.workflow,
      version: instance.version,
      created,
      status: instance.status,
    };
  }

  getStatus(
    id: string,
    options: { journal: true; children?: boolean },
  ): Promise<
    (WorkflowInstanceDetails & { journal: WorkflowJournalEntry[] }) | null
  >;
  getStatus(
    id: string,
    options?: { journal?: boolean; children?: boolean },
  ): Promise<WorkflowInstanceDetails | null>;
  async getStatus(
    id: string,
    options: { journal?: boolean; children?: boolean } = {},
  ): Promise<WorkflowInstanceDetails | null> {
    const details = await this.store.get(id, {
      journal: options.journal === true,
    });
    if (!details) {
      return null;
    }
    if (!options.journal) {
      delete details.journal;
    }
    if (options.children) {
      details.children = [];
      for (let offset = 0; ; offset += 500) {
        const page = await this.store.inner.list({
          parentId: id,
          limit: 500,
          offset,
        });
        details.children.push(
          ...(await Promise.all(
            page.map((child) => this.store.readableInstance(child)),
          )),
        );
        if (page.length < 500) {
          break;
        }
      }
    }
    return details;
  }

  async result<O = unknown>(
    id: string,
    options: WorkflowResultOptions = {},
  ): Promise<Journaled<O>> {
    return (await this.results.wait(id, options)) as Journaled<O>;
  }

  private async outcomeOf(id: string): Promise<ResultOutcome<unknown> | null> {
    const instance = await this.store.get(id);
    if (!instance) {
      return {
        error: new WorkflowNotFoundError(
          `No workflow instance with id "${id}".`,
        ),
      };
    }
    if (instance.status === "completed") {
      return { value: instance.output };
    }
    return FINISHED.includes(instance.status)
      ? { error: failure(instance) }
      : null;
  }

  async startAndWait<W>(
    workflow: Type<W> | string,
    input: WorkflowInput<W>,
    options: StartWorkflowOptions = {},
    wait: WorkflowResultOptions = {},
  ): Promise<Journaled<WorkflowOutput<W>>> {
    if (options.transaction !== undefined) {
      throw new TypeError(
        "startAndWait() can't take { transaction }: the instance only exists once your transaction commits. Call start() in it, and result() after the commit.",
      );
    }
    const { id } = await this.start(workflow, input, options);
    return this.result<WorkflowOutput<W>>(id, wait);
  }

  async list(filter: WorkflowListFilter = {}): Promise<WorkflowInstance[]> {
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new TypeError(
        `list(): limit (${limit}) and offset (${offset}) must be non-negative integers.`,
      );
    }
    const status =
      filter.status === undefined
        ? undefined
        : Array.isArray(filter.status)
          ? filter.status
          : [filter.status];
    if (status?.length === 0 || limit === 0) {
      return [];
    }
    const instances = await this.store.inner.list({
      limit,
      offset,
      ...(status ? { status } : {}),
      ...(filter.workflow !== undefined ? { workflow: filter.workflow } : {}),
      ...(filter.version !== undefined ? { version: filter.version } : {}),
      ...(filter.parentId !== undefined ? { parentId: filter.parentId } : {}),
      ...(filter.scheduleId !== undefined
        ? { scheduleId: filter.scheduleId }
        : {}),
    });
    return Promise.all(
      instances.map((instance) => this.store.readableInstance(instance)),
    );
  }

  cancel(id: string, reason?: string): Promise<WorkflowCancelResult> {
    return this.stop(id, reason, false);
  }

  terminate(id: string, reason?: string): Promise<WorkflowCancelResult> {
    return this.stop(id, reason, true);
  }

  private async stop(
    id: string,
    reason: string | undefined,
    terminate: boolean,
  ): Promise<WorkflowCancelResult> {
    assertStorableText("Reason", reason, this.store.textCheck("cancelReason"));
    const accepted = await this.store.requestCancel(id, {
      reason: reason ?? null,
      now: this.clock.now(),
      terminate,
    });
    const details = await this.store
      .get(id)
      .catch(() => this.store.inner.get(id));
    if (!details) {
      throw new WorkflowNotFoundError(`No workflow instance with id "${id}".`);
    }
    if (accepted) {
      this.worker.noticeCancel(id, terminate);
    }
    const { waits: _waits, journal: _journal, ...instance } = details;
    return { ...instance, accepted };
  }

  async signal<T>(
    signal: WorkflowSignal<T> | string,
    payload: NoInfer<T>,
    options: SignalWorkflowOptions = {},
  ): Promise<WorkflowSignalSendResult> {
    const name = signalName(signal);
    const key = options.key ?? null;
    if (
      options.id !== undefined &&
      (typeof options.id !== "string" || options.id.length === 0)
    ) {
      throw new TypeError(
        `Invalid signal id ${JSON.stringify(options.id)}. Use a non-empty string, such as the id of the event that causes it.`,
      );
    }
    const dedupeId = options.id ?? stepSignalId(name, key) ?? null;
    const keyCheck = this.store.textCheck("key");
    assertStorableText("A signal name", name, keyCheck);
    assertStorableText("A signal key", key, keyCheck);
    assertStorableText("A signal id", dedupeId, keyCheck);
    const json = normalize(payload);
    assertStorableJson("Signal payload", json, this.store.textCheck("payload"));
    const data = { name, key, dedupeId, payload: json, now: this.clock.now() };
    const result = await (options.transaction === undefined
      ? this.store.signal(data)
      : this.storeMethod("signalInTransaction", "signal")(
          options.transaction,
          data,
        ));
    if (!result.created && result.key !== key) {
      throw new WorkflowIdConflictError(
        `Signal id "${dedupeId}" of "${name}" was already used with ${describeKey(result.key)}, not ${describeKey(key)}.`,
      );
    }
    if (result.woken > 0) {
      this.worker.kick();
    }
    return {
      signalId: result.id,
      woken: result.woken,
      created: result.created,
    };
  }

  async retry(
    id: string,
    options: WorkflowRetryInstanceOptions = {},
  ): Promise<WorkflowInstance> {
    const details = await this.store.get(id, { journal: true });
    if (!details) {
      throw new WorkflowNotFoundError(`No workflow instance with id "${id}".`);
    }
    const { status, journal = [] } = details;
    const now = this.clock.now();
    const reset = (entry: WorkflowJournalEntry): WorkflowJournalEntry => ({
      ...entry,
      status: "pending",
      attempts: 0,
      wakeAt: null,
      updatedAt: now,
    });
    let entries: WorkflowJournalEntry[];
    let error: SerializedWorkflowError | null;
    if (status === "failed") {
      const undone = journal
        .filter(
          (entry) =>
            entry.kind === "compensation" && entry.status === "completed",
        )
        .map((entry) => `"${entry.name}"`);
      if (undone.length > 0) {
        throw new WorkflowStateError(
          `Instance "${id}" failed and its compensations ran (${undone.join(", ")}): its completed steps were undone, so ` +
            "resuming it would build on undone work. Start a new instance instead.",
        );
      }
      entries = journal
        .filter((entry) => entry.kind === "step" && entry.status === "failed")
        .map(reset);
      error = null;
    } else if (status === "compensation_failed") {
      entries = journal
        .filter(
          (entry) =>
            entry.kind === "compensation" && entry.status !== "completed",
        )
        .map(reset);
      const { compensation: _compensation, ...reason } = details.error ?? {
        name: "Error",
        message: "Unknown failure.",
      };
      error = reason;
    } else {
      throw new WorkflowStateError(
        `Instance "${id}" is ${status}: only failed and compensation_failed instances can be retried.` +
          (FINISHED.includes(status)
            ? ""
            : " cancel() stops one that is still running."),
      );
    }
    let deadline: number | null | undefined;
    if (options.timeout !== undefined) {
      deadline =
        options.timeout === false
          ? null
          : now + runTimeoutMs(options.timeout, "retry()");
    } else if (
      status === "failed" &&
      details.deadline !== null &&
      details.deadline <= now
    ) {
      throw new WorkflowStateError(
        `Instance "${id}" is past its run timeout, so it would time out again at once. Pass { timeout } with a new one, or false for none.`,
      );
    }
    const retries = journal.filter((entry) => entry.kind === "retry").length;
    entries.push({
      name: `$retry:${retries + 1}`,
      kind: "retry",
      status: "completed",
      attempts: 0,
      data: { from: status, error: details.error ?? null },
      updatedAt: now,
    });
    const accepted = await this.store.reopen(id, {
      expect: { status, runs: details.runs },
      status: status === "failed" ? "pending" : "compensating",
      error,
      ...(deadline !== undefined ? { deadline } : {}),
      entries,
      now,
    });
    if (!accepted) {
      throw new WorkflowStateError(
        `Instance "${id}" changed while it was being retried. Read it again, and retry if it still needs it.`,
      );
    }
    this.emit(details, {
      type: "workflow-retried",
      from: status,
      error: details.error ?? null,
    });
    this.worker.kick();
    const {
      waits: _waits,
      journal: _journal,
      ...instance
    } = (await this.store.get(id))!;
    return instance;
  }

  async delete(id: string, options: WorkflowDeleteOptions = {}): Promise<void> {
    const details = await this.store.inner.get(id);
    if (!details) {
      throw new WorkflowNotFoundError(`No workflow instance with id "${id}".`);
    }
    const deleted = await this.store.delete(id, options.force ? ALL : FINISHED);
    if (!deleted) {
      const current = await this.store.inner.get(id);
      if (!current) {
        throw new WorkflowNotFoundError(
          `No workflow instance with id "${id}".`,
        );
      }
      throw new WorkflowStateError(
        `Instance "${id}" is ${current.status}: delete() removes finished instances. cancel() it first, or pass ` +
          "{ force: true } to delete it without running its compensations.",
      );
    }
    this.emit(details, { type: "workflow-deleted", status: details.status });
    if (details.parentId !== null && !FINISHED.includes(details.status)) {
      const ended = {
        status: "cancelled",
        error: {
          name: "WorkflowDeletedError",
          message: `Child instance "${id}" was deleted before it ended.`,
        },
      };
      await this.store.signal({
        name: CHILD_ENDED_SIGNAL,
        key: id,
        dedupeId: id,
        payload: ended,
        now: this.clock.now(),
      });
      this.worker.kick();
    }
  }

  async purge(options: WorkflowPurgeOptions): Promise<WorkflowPurgeResult> {
    const olderThan = parseDuration(options.olderThan);
    const statuses =
      options.status === undefined
        ? DEFAULT_PURGE
        : Array.isArray(options.status)
          ? options.status
          : [options.status];
    const unfinished = statuses.filter((status) => !FINISHED.includes(status));
    if (statuses.length === 0 || unfinished.length > 0) {
      throw new TypeError(
        `purge(): status must list finished statuses (${FINISHED.join(", ")}), not ${unfinished.length ? unfinished.join(", ") : "none"}. ` +
          "Cancel an unfinished instance first.",
      );
    }
    const limit = options.batchSize ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError(
        `purge(): batchSize (${limit}) must be a positive integer.`,
      );
    }
    const before = this.clock.now() - olderThan;
    const total: WorkflowPurgeResult = {
      instances: 0,
      signals: 0,
      rateLimits: 0,
    };
    for (;;) {
      const batch = await this.store.purge({ statuses, before, limit });
      total.instances += batch.instances;
      total.signals += batch.signals;
      total.rateLimits += batch.rateLimits;
      if (
        batch.instances < limit &&
        batch.signals < limit &&
        batch.rateLimits < limit
      ) {
        return total;
      }
    }
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

  private storeMethod<M extends "createInTransaction" | "signalInTransaction">(
    method: M,
    caller: string,
  ): NonNullable<EncodedWorkflowStore[M]> {
    const store = this.store;
    const fn = store[method];
    if (typeof fn !== "function") {
      throw new TypeError(
        `${caller}() with { transaction } needs a WorkflowStore on your database that implements ${method}(); ` +
          `${this.storage.source.constructor.name} has none.`,
      );
    }
    return fn.bind(store) as NonNullable<EncodedWorkflowStore[M]>;
  }
}

function isEnded(event: WorkflowEvent): boolean {
  return (
    event.type === "workflow-completed" ||
    event.type === "workflow-deleted" ||
    FAILURES[event.type] !== undefined
  );
}

function outcome(event: WorkflowEvent): ResultOutcome<unknown> {
  if (event.type === "workflow-completed") {
    return { value: event.output };
  }
  if (event.type === "workflow-deleted") {
    return {
      error: new WorkflowNotFoundError(
        `No workflow instance with id "${event.id}".`,
      ),
    };
  }
  const failEvent = event as Extract<
    WorkflowEvent,
    {
      type:
        | "workflow-failed"
        | "workflow-cancelled"
        | "workflow-compensation-failed";
    }
  >;
  return {
    error: failure({
      id: event.id,
      workflow: event.workflow,
      status: FAILURES[event.type]!,
      error: failEvent.error,
    }),
  };
}

function failure(instance: {
  id: string;
  workflow: string;
  status: WorkflowStatus;
  error?: SerializedWorkflowError | null;
}): WorkflowFailedError {
  const status = instance.status as WorkflowFailureStatus;
  const cause = instance.error ?? {
    name: "Error",
    message: "Unknown failure.",
  };
  return new WorkflowFailedError(
    `Instance "${instance.id}" of workflow "${instance.workflow}" ${status.replace("_", " ")}: ${cause.name}: ${cause.message}`,
    {
      instanceId: instance.id,
      status,
      cause,
    },
  );
}

function describeKey(key: string | null): string {
  return key === null ? "no key" : `key "${key}"`;
}
