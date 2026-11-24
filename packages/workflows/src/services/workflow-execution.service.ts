import { ContextStorage, Logger, type Type } from "@bunest/core";

const nextMacrotask = () => Bun.sleep(0);
const randomUUID = () => crypto.randomUUID();
import type { LeasedRun } from "../core/interfaces/leased-worker-options.interface";
import type { ResolvedRetry } from "../core/interfaces/retry-settings.interface";
import { nextRetry, resolveRetry } from "../core/retries/retry";
import { parseDuration, type Duration } from "../core/time/duration";
import { canonical } from "../core/utils/canonical.util";
import { setTimer } from "../core/utils/timer.util";
import { ChildWorkflowFailedError } from "../errors/child-workflow-failed.error";
import { NonRetryableStepError } from "../errors/non-retryable-step.error";
import { StepFailedError } from "../errors/step-failed.error";
import { StepTimeoutError } from "../errors/step-timeout.error";
import { WorkflowDefinitionError } from "../errors/workflow-definition.error";
import {
  WorkflowFailedError,
  type WorkflowFailureStatus,
} from "../errors/workflow-failed.error";
import { WorkflowIdConflictError } from "../errors/workflow-id-conflict.error";
import {
  isWorkflowInterrupt,
  WorkflowInterrupt,
  type InterruptReason,
} from "../errors/workflow-interrupt.error";
import { WorkflowNonDeterminismError } from "../errors/workflow-non-determinism.error";
import type {
  WorkflowEvent,
  WorkflowEventBase,
} from "../events/workflow-events.interface";
import type { WorkflowEvents } from "../events/workflow-events.service";
import type { SerializedWorkflowError } from "../interfaces/serialized-workflow-error.interface";
import type { WorkflowClock } from "../interfaces/workflow-clock.interface";
import type {
  ChildWorkflowHandle,
  Journaled,
  SignalWaitOptions,
  StartChildWorkflowOptions,
  WaitForSignalOptions,
  WorkflowAnyResult,
  WorkflowCompensationContext,
  WorkflowCondition,
  WorkflowContext,
  WorkflowInput,
  WorkflowOutput,
  WorkflowStepContext,
  WorkflowStepOptions,
} from "../interfaces/workflow-context.interface";
import type { WorkflowMetadata } from "../interfaces/workflow-decorator-options.interface";
import type {
  WorkflowInstance,
  WorkflowJournalEntry,
  WorkflowParentClose,
  WorkflowStatus,
  WorkflowWait,
} from "../interfaces/workflow-instance.interface";
import type { WorkflowRetryOptions } from "../interfaces/workflow-retry-options.interface";
import type {
  NewWorkflowInstance,
  WorkflowKeyKind,
  WorkflowSignalRecord,
} from "../interfaces/workflow-store.interface";
import type { WorkflowJournalLimits } from "../interfaces/workflows-module-options.interface";
import { signalName, type WorkflowSignal } from "../signals/workflow.signal";
import type { WorkflowInstanceStore } from "../storage/encoded-workflow.store";
import { entryBytes } from "../utils/journal-limits.util";
import { newInstance } from "../utils/new-instance.util";
import { normalize } from "../utils/normalize.util";
import { serializeError } from "../utils/serialize-error.util";
import { runInStepScope } from "../utils/step-scope.util";
import {
  assertStorableJson,
  assertStorableText,
  unstorableJson,
  type TextChecks,
} from "../utils/storable-text.util";
import { CHILD_ENDED_SIGNAL } from "../workflows.constants";

/** An instance under a worker's lease. */
export interface ClaimedWorkflowInstance extends WorkflowInstance {
  leaseToken: string;
}

/** One entry per name, as the store expects: the last version of each, in the order the names first appear. */
export function uniqueEntries<T extends { name: string }>(entries: T[]): T[] {
  const latest = new Map<string, T>();
  for (const entry of entries) {
    latest.set(entry.name, entry);
  }
  return [...latest.values()];
}

export interface ExecutionDeps {
  store: WorkflowInstanceStore;
  /** What the store can't keep of a text at a place (`EncodedWorkflowStore.textCheck`), refused where the run makes it. */
  textCheck: TextChecks;
  /** The workflow `ctx.startChild()` starts: its name, version and run timeout (`WorkflowRegistry.resolve()`). */
  resolve(workflow: Type<unknown> | string, version?: number): WorkflowMetadata;
  /**
   * Creates a child, or finds the one an interrupted execution created, and throws
   * `WorkflowIdConflictError` if the id holds another instance.
   */
  createChild(instance: NewWorkflowInstance): Promise<WorkflowInstance>;
  clock: WorkflowClock;
  events: WorkflowEvents;
  defaultRetry: ResolvedRetry;
  journalLimits: Required<WorkflowJournalLimits>;
}

export type RunOutcome =
  { ok: true; value: unknown } | { ok: false; error: unknown };

export type CompensationOutcome =
  | { state: "done"; count: number }
  | { state: "suspended"; wakeAt: number | null }
  | { state: "failed"; error: SerializedWorkflowError }
  | { state: "interrupted" }
  | { state: "terminated" };

type EventBody = WorkflowEvent extends infer E
  ? E extends WorkflowEventBase
    ? Omit<E, keyof WorkflowEventBase>
    : never
  : never;

/**
 * What `ctx.signalWait()` and `ctx.timer()` make for `ctx.waitForAny()`.
 */
export class Condition {
  readonly wait: WorkflowWait | null;
  readonly match: ((payload: any) => boolean) | undefined;
  readonly timer: Duration | { until: Date | number } | undefined;
  readonly settle: (payload: unknown) => unknown;

  private constructor(
    wait: WorkflowWait | null,
    match: ((payload: any) => boolean) | undefined,
    timer: Duration | { until: Date | number } | undefined,
    settle: (payload: unknown) => unknown,
  ) {
    this.wait = wait;
    this.match = match;
    this.timer = timer;
    this.settle = settle;
  }

  static signal(
    wait: WorkflowWait,
    match?: (payload: any) => boolean,
    settle: (payload: unknown) => unknown = (payload) => payload,
  ): Condition {
    return new Condition(wait, match, undefined, settle);
  }

  static timer(when: Duration | { until: Date | number }): Condition {
    wakeTime("timer", when, 0);
    return new Condition(null, undefined, when, () => null);
  }
}

/** What a child sends its parent when it ends (`CHILD_ENDED_SIGNAL`). */
export interface ChildEnded {
  status: WorkflowStatus;
  output?: unknown;
  error?: SerializedWorkflowError | null;
}

/** `ChildWorkflowHandle`: waits for the child's end, once per execution, as `result()` or as a `waitForAny()` condition. */
export class ChildHandle<O = unknown> implements ChildWorkflowHandle<O> {
  readonly id: string;
  readonly workflow: string;
  readonly version: number;
  private readonly wait: (handle: ChildHandle<O>) => Promise<Journaled<O>>;
  readonly condition: Condition;
  private outcome?: { value: Journaled<O> } | { error: Error };
  private waiting?: Promise<Journaled<O>>;

  constructor(
    id: string,
    workflow: string,
    version: number,
    wait: (handle: ChildHandle<O>) => Promise<Journaled<O>>,
  ) {
    this.id = id;
    this.workflow = workflow;
    this.version = version;
    this.wait = wait;
    this.condition = Condition.signal(
      { signal: CHILD_ENDED_SIGNAL, key: id },
      undefined,
      (payload) => this.settle(payload),
    );
  }

  result(): Promise<Journaled<O>> {
    if (this.outcome) {
      return "error" in this.outcome
        ? Promise.reject(this.outcome.error)
        : Promise.resolve(this.outcome.value);
    }
    return (this.waiting ??= this.wait(this));
  }

  /** The child's output, from its journaled end, or its failure, thrown. Kept, so a later `result()` returns it. */
  settle(payload: unknown): Journaled<O> {
    const ended = payload as ChildEnded;
    if (ended.status === "completed") {
      const value = ended.output as Journaled<O>;
      this.outcome = { value };
      return value;
    }
    const error = new ChildWorkflowFailedError(
      this.workflow,
      this.id,
      ended.status as WorkflowFailureStatus,
      ended.error ?? { name: "Error", message: "Unknown failure." },
    );
    this.outcome = { error };
    throw error;
  }
}

interface RegisteredCompensation {
  step: string;
  completed: boolean;
  result?: unknown;
  fn: (result: any, ctx: WorkflowCompensationContext) => unknown;
  retry?: number | false | WorkflowRetryOptions;
}

interface StepPlan {
  policy: ResolvedRetry;
  timeoutMs: number | undefined;
  heartbeatTimeoutMs: number | undefined;
}

interface StepFrame {
  execution: WorkflowExecution;
  name: string;
  outer: StepFrame | undefined;
}

const COMPENSATE = "$compensate:";
const insideStep = new ContextStorage<StepFrame>();
const PARENT_CLOSE: readonly WorkflowParentClose[] = [
  "cancel",
  "terminate",
  "abandon",
];
const MAX_CUSTOM_STATUS_BYTES = 16_384;
const ADVICE =
  "A deployed change renamed, removed or reordered steps. Ship such changes as a new version " +
  "(@Workflow(name, { version })) and keep the old class registered until its instances finish.";

/**
 * One execution of a workflow instance: runs `run()` from the top against the
 * journal loaded at claim time.
 */
export class WorkflowExecution {
  private static readonly logger = new Logger("Workflows");

  readonly instance: ClaimedWorkflowInstance;
  readonly signalCursor: number;
  private readonly deps: ExecutionDeps;
  private readonly lease: LeasedRun;
  readonly context: WorkflowContext;
  readonly journal: Map<string, WorkflowJournalEntry>;
  readonly abort = new AbortController();

  suspension: { wakeAt: number | null; waits: WorkflowWait[] } | null = null;
  fatal: Error | null = null;
  journalLimitError: SerializedWorkflowError | null = null;
  leaseLost = false;
  storeError: unknown = null;
  shuttingDown = false;
  cancelRequested = false;
  terminateRequested = false;
  readonly rollbacks: WorkflowJournalEntry[] = [];

  private mode: "run" | "replay" | "compensate" | "closed";
  private userSettled = false;
  private buffer: WorkflowJournalEntry[] = [];
  private frontier?: Promise<void>;
  private readonly visited = new Set<string>();
  private readonly compensations: RegisteredCompensation[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private readonly consumed = new Set<number>();
  private writes: Promise<void> = Promise.resolve();
  private readonly counters = { now: 0, random: 0, uuid: 0 };
  private readonly childCounters = new Map<string, number>();
  private stoppedBy: WorkflowInterrupt | null = null;
  private readonly entrySizes = new Map<string, number>();
  private journalBytes = 0;
  private journalLarge: boolean;
  private customStatus: unknown;
  private storedStatus: string;

  constructor(
    instance: ClaimedWorkflowInstance,
    journal: WorkflowJournalEntry[],
    signalCursor: number,
    deps: ExecutionDeps,
    lease: LeasedRun,
    replayOnly: boolean,
  ) {
    this.instance = instance;
    this.signalCursor = signalCursor;
    this.deps = deps;
    this.lease = lease;

    const stop = () =>
      lease.leaseLost ? this.loseLease() : this.requestShutdown();
    if (lease.signal.aborted) {
      stop();
    } else {
      lease.signal.addEventListener("abort", stop, { once: true });
    }

    this.mode = replayOnly ? "replay" : "run";
    this.journal = new Map(journal.map((entry) => [entry.name, entry]));
    for (const entry of journal) {
      this.measure(entry);
    }
    this.journalLarge = this.pastWarning();
    this.customStatus = instance.customStatus ?? null;
    this.storedStatus = canonical(this.customStatus);

    for (const entry of journal) {
      const signalId = (entry.result as { signalId?: unknown } | undefined)
        ?.signalId;
      if (
        (entry.kind === "signal" || entry.kind === "any") &&
        typeof signalId === "number"
      ) {
        this.consumed.add(signalId);
      }
    }

    this.context = {
      workflowId: instance.id,
      workflowName: instance.workflow,
      version: instance.version,
      schedule:
        instance.scheduleId === null
          ? null
          : { id: instance.scheduleId, at: instance.scheduledAt! },
      step: <T, P = unknown>(
        name: string,
        fn: (ctx: WorkflowStepContext<P>) => T | Promise<T>,
        options?: WorkflowStepOptions<T>,
      ) => this.track(this.step(name, fn, options)),
      sleep: (name: string, duration: Duration | { until: Date | number }) =>
        this.track(this.sleep(name, duration)),
      waitForSignal: <T>(
        name: string,
        signal: WorkflowSignal<T> | string,
        options: WaitForSignalOptions<T> = {},
      ) =>
        this.track(
          this.receive(
            name,
            { signal: signalName(signal), key: options.key ?? null },
            options,
            false,
          ) as Promise<Journaled<T> | null>,
        ),
      startChild: <W>(
        workflow: Type<W> | string,
        input: WorkflowInput<W>,
        options?: StartChildWorkflowOptions,
      ) =>
        this.track(
          this.startChild(workflow, input, options) as Promise<
            ChildWorkflowHandle<WorkflowOutput<W>>
          >,
        ),
      executeChild: <W>(
        workflow: Type<W> | string,
        input: WorkflowInput<W>,
        options?: StartChildWorkflowOptions,
      ) =>
        this.track(
          this.startChild(workflow, input, options).then((handle) =>
            handle.result(),
          ) as Promise<Journaled<WorkflowOutput<W>>>,
        ),
      waitForAny: <C extends Record<string, WorkflowCondition<unknown>>>(
        name: string,
        conditions: C,
      ) =>
        this.track(
          this.waitForAny(name, conditions) as Promise<WorkflowAnyResult<C>>,
        ),
      signalWait: <T>(
        signal: WorkflowSignal<T> | string,
        options: SignalWaitOptions<T> = {},
      ) =>
        Condition.signal(
          { signal: signalName(signal), key: options.key ?? null },
          options.match,
        ) as unknown as WorkflowCondition<Journaled<T>>,
      timer: (when: Duration | { until: Date | number }) =>
        Condition.timer(when) as unknown as WorkflowCondition<null>,
      now: () => this.helper("now", () => this.deps.clock.now()),
      random: () => this.helper("random", () => Math.random()),
      uuid: () => this.helper("uuid", () => randomUUID()),
      commit: (name: string) => this.commit(name),
      setStatus: (status: unknown) => this.setStatus(status),
      fail: (message: string): never => {
        this.assertNotInStep(
          "fail()",
          "Throw a NonRetryableStepError from the step instead.",
        );
        throw new WorkflowFailedError(message);
      },
    };
  }

  /** Runs the user's `run()` and waits for every step it started. */
  async run(fn: () => Promise<unknown>): Promise<RunOutcome> {
    let outcome: RunOutcome;
    try {
      outcome = { ok: true, value: await fn() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    this.userSettled = true;
    while (this.inflight.size) {
      await Promise.all(this.inflight);
    }
    this.mode = "closed";
    return this.stoppedBy ? { ok: false, error: this.stoppedBy } : outcome;
  }

  unvisited(): string[] {
    return [...this.journal.values()]
      .filter(
        (entry) =>
          entry.kind !== "compensation" &&
          entry.kind !== "retry" &&
          !this.visited.has(entry.name),
      )
      .map((entry) => entry.name);
  }

  drainBuffer(): WorkflowJournalEntry[] {
    const now = this.deps.clock.now();
    return this.buffer.splice(0).map((entry) => ({ ...entry, updatedAt: now }));
  }

  requestShutdown(): void {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.abort.abort(new WorkflowInterrupt("shutdown"));
  }

  get detached(): boolean {
    return this.lease.detached;
  }

  async renew(): Promise<void> {
    if (this.detached || this.leaseLost) {
      return;
    }
    await this.lease.renew();
  }

  async compensate(
    reason: SerializedWorkflowError,
  ): Promise<CompensationOutcome> {
    this.mode = "compensate";
    this.suspension = null;
    let count = 0;
    for (const compensation of [...this.compensations].reverse()) {
      if (!compensation.completed) {
        continue;
      }
      if (this.terminateRequested) {
        return { state: "terminated" };
      }
      const name = `${COMPENSATE}${compensation.step}`;
      const entry = this.journal.get(name);
      if (entry?.status === "completed") {
        continue;
      }
      if (entry?.status === "failed") {
        return { state: "failed", error: entry.error! };
      }
      try {
        this.checkKey("journalName", name);
        const attempt = await this.attempt(
          name,
          "compensation",
          async (ctx) => {
            await compensation.fn(compensation.result, { ...ctx, reason });
          },
          this.plan(name, { retry: compensation.retry }),
          entry,
        );
        count++;
        this.emit({
          type: "step-compensated",
          step: compensation.step,
          attempt: attempt.attempt,
        });
      } catch (error) {
        if (error instanceof StepFailedError) {
          return {
            state: "failed",
            error: { ...error.cause, message: `${error.message}` },
          };
        }
        if (this.fatal) {
          return { state: "failed", error: serializeError(this.fatal) };
        }
        if (isWorkflowInterrupt(error)) {
          return error.reason === "suspend"
            ? { state: "suspended", wakeAt: this.suspension!.wakeAt }
            : { state: "interrupted" };
        }
        return { state: "failed", error: serializeError(error) };
      }
    }
    return { state: "done", count };
  }

  private async step<T, P = unknown>(
    name: string,
    fn: (ctx: WorkflowStepContext<P>) => T | Promise<T>,
    options: WorkflowStepOptions<T> = {},
  ): Promise<Journaled<T>> {
    this.assertNotInStep(`step("${name}")`);
    this.visit(name, "step");
    const entry = this.journal.get(name);
    if (entry?.status === "completed") {
      this.reserveCompensation(name, options)?.arm(entry.result);
      return entry.result as Journaled<T>;
    }
    if (entry?.status === "failed") {
      throw new StepFailedError(name, entry.attempts, entry.error!);
    }
    if (this.mode !== "run") {
      throw this.interrupt("halt");
    }
    this.assertCanStart();
    if (options.compensate) {
      this.checkKey("journalName", `${COMPENSATE}${name}`);
    }
    const plan = this.plan(name, options);
    const compensation = this.reserveCompensation(name, options);
    await this.reachFrontier(name);
    this.assertCanStart();
    const { value } = await this.attempt(
      name,
      "step",
      fn as (ctx: WorkflowStepContext) => unknown,
      plan,
      entry,
    );
    compensation?.arm(value);
    return value as Journaled<T>;
  }

  private async sleep(
    name: string,
    duration: Duration | { until: Date | number },
  ): Promise<void> {
    this.assertNotInStep(`sleep("${name}")`);
    this.visit(name, "sleep");
    const entry = unlessCancelled(this.journal.get(name));
    if (entry?.status === "completed") {
      return;
    }
    if (this.mode !== "run") {
      throw this.interrupt("halt");
    }
    this.assertAlive();
    const now = this.deps.clock.now();
    const wakeAt = entry?.wakeAt ?? wakeTime(name, duration, now);
    if (now >= wakeAt) {
      this.stage({
        name,
        kind: "sleep",
        status: "completed",
        attempts: 0,
        wakeAt,
      });
      return;
    }
    if (!entry) {
      this.stage({
        name,
        kind: "sleep",
        status: "pending",
        attempts: 0,
        wakeAt,
      });
    }
    throw this.suspendUntil(wakeAt);
  }

  private async receive<T>(
    name: string,
    wait: WorkflowWait,
    options: WaitForSignalOptions<T>,
    internal: boolean,
  ): Promise<unknown> {
    this.assertNotInStep(
      internal ? "startChild() handle result()" : `waitForSignal("${name}")`,
    );
    this.visit(name, "signal", internal);
    const entry = unlessCancelled(this.journal.get(name));
    if (entry?.status === "completed") {
      return (entry.result as { payload: unknown }).payload;
    }
    if (this.mode !== "run") {
      throw this.interrupt("halt");
    }
    this.assertAlive();
    this.checkWait(wait);
    const deadline = entry
      ? (entry.wakeAt ?? null)
      : options.timeout !== undefined
        ? this.deps.clock.now() + parseDuration(options.timeout)
        : null;
    if (!entry) {
      this.stage({
        name,
        kind: "signal",
        status: "pending",
        attempts: 0,
        wakeAt: deadline,
        data: wait,
      });
    }
    const candidates = await this.signalsFor(wait);
    this.assertAlive();
    const candidate = this.take(
      candidates,
      deadline,
      options.match as ((payload: unknown) => boolean) | undefined,
    );
    if (candidate) {
      await this.write([
        {
          name,
          kind: "signal",
          status: "completed",
          attempts: 0,
          wakeAt: deadline,
          data: wait,
          result: { signalId: candidate.id, payload: candidate.payload },
        },
      ]);
      if (!internal) {
        this.emit({
          type: "signal-received",
          wait: name,
          signal: wait.signal,
          signalId: candidate.id,
        });
      }
      return candidate.payload;
    }
    if (deadline !== null && this.deps.clock.now() >= deadline) {
      await this.write([
        {
          name,
          kind: "signal",
          status: "completed",
          attempts: 0,
          wakeAt: deadline,
          data: wait,
          result: { signalId: null, payload: null },
        },
      ]);
      this.emit({
        type: "signal-timed-out",
        wait: name,
        signal: wait.signal,
      });
      return null;
    }
    throw this.suspendUntil(deadline, [wait]);
  }

  private async startChild(
    workflow: Type<unknown> | string,
    input: unknown,
    options: StartChildWorkflowOptions = {},
  ): Promise<ChildHandle> {
    this.assertNotInStep(
      "startChild()",
      "Start the child from run(), and pass it what the step returned.",
    );
    if (this.fatal) {
      throw this.fatal;
    }
    const parentClose = options.parentClose ?? "cancel";
    if (!PARENT_CLOSE.includes(parentClose)) {
      throw new TypeError(
        `Invalid parentClose ${JSON.stringify(parentClose)} for startChild(). Use 'cancel', 'terminate' or 'abandon'.`,
      );
    }
    const resolved = this.deps.resolve(workflow, options.version);
    const n = (this.childCounters.get(resolved.name) ?? 0) + 1;
    this.childCounters.set(resolved.name, n);
    const id = options.id ?? `${this.instance.id}/${resolved.name}#${n}`;
    const name = `$child:${id}`;
    if (this.mode === "run" && !this.journal.has(name)) {
      assertStorableText("A child's id", id, this.deps.textCheck("name"));
    }
    this.visit(name, "child", true);
    const request = {
      id,
      workflow: resolved.name,
      input: Buffer.from(
        new Bun.CryptoHasher("sha256")
          .update(canonical(normalize(input) ?? null))
          .digest(),
      ).toString("base64url"),
    };
    const entry = this.journal.get(name);
    if (entry && entry.status !== "pending") {
      const recorded = entry.data as { workflow: string; input: string };
      if (
        recorded.workflow !== request.workflow ||
        recorded.input !== request.input
      ) {
        throw this.setFatal(
          new WorkflowNonDeterminismError(
            `${this.describe()} does not match its journal: child "${id}" was started as "${recorded.workflow}"` +
              `${recorded.workflow === request.workflow ? " with another input" : ""}, but the code now starts "${request.workflow}". ` +
              "Children started from parallel branches need ids of their own ({ id }). " +
              ADVICE,
          ),
        );
      }
      if (entry.status === "failed") {
        throw new WorkflowIdConflictError(entry.error!.message);
      }
      return this.handle(
        entry.result as { id: string; workflow: string; version: number },
      );
    }
    if (this.mode !== "run") {
      throw this.interrupt("halt");
    }
    this.assertCanStart();
    const child = newInstance(resolved, id, input, {
      caller: "startChild()",
      now: this.deps.clock.now(),
      timeout: options.timeout,
      concurrencyKey: options.concurrencyKey,
      rateLimitKey: options.rateLimitKey,
      priority: options.priority ?? this.instance.priority,
      parentId: this.instance.id,
      parentClose,
      text: this.deps.textCheck,
    });
    this.checkKey("instanceId", child.id);
    this.checkKey("workflow", child.workflow);
    this.checkKey("concurrencyKey", child.concurrencyKey);
    this.checkKey("rateLimitKey", child.rateLimitKey);
    await this.reachFrontier(name);
    this.assertCanStart();
    if (!entry) {
      await this.write([
        {
          name,
          kind: "child",
          status: "pending",
          attempts: 0,
          data: request,
        },
      ]);
    }
    let created: WorkflowInstance;
    try {
      created = await this.deps.createChild(child);
    } catch (error) {
      if (!(error instanceof WorkflowIdConflictError)) {
        this.storeError = error;
        this.abort.abort(new WorkflowInterrupt("store-error"));
        throw this.interrupt("store-error");
      }
      await this.write([
        {
          name,
          kind: "child",
          status: "failed",
          attempts: 1,
          data: request,
          error: serializeError(error),
        },
      ]);
      throw error;
    }
    const started = {
      id: child.id,
      workflow: child.workflow,
      version: created.version,
    };
    await this.write([
      {
        name,
        kind: "child",
        status: "completed",
        attempts: 1,
        data: request,
        result: started,
      },
    ]);
    this.emit({
      type: "child-started",
      child: started.id,
      childWorkflow: started.workflow,
      childVersion: started.version,
    });
    return this.handle(started);
  }

  private handle(started: {
    id: string;
    workflow: string;
    version: number;
  }): ChildHandle {
    return new ChildHandle(
      started.id,
      started.workflow,
      started.version,
      (handle) =>
        this.track(
          this.receive(
            `$result:${handle.id}`,
            handle.condition.wait!,
            {},
            true,
          ).then((payload) => handle.settle(payload)),
        ),
    );
  }

  hasChildren(): boolean {
    return [...this.journal.values()].some((entry) => entry.kind === "child");
  }

  private async waitForAny(
    name: string,
    conditions: Record<string, WorkflowCondition<unknown>>,
  ): Promise<{ key: string; value: unknown }> {
    this.assertNotInStep(`waitForAny("${name}")`);
    const branches = conditionsOf(name, conditions);
    this.visit(name, "any");
    const entry = unlessCancelled(this.journal.get(name));
    if (entry?.status === "completed") {
      const won = entry.result as {
        key: string;
        signalId: number | null;
        payload: unknown;
      };
      const branch = branches.get(won.key);
      const type = won.signalId === null ? "timer" : "signal";
      if (!branch || (branch.wait === null) !== (type === "timer")) {
        throw this.setFatal(
          new WorkflowNonDeterminismError(
            `${this.describe()} does not match its journal: waitForAny("${name}") was won by its ${type} "${won.key}", which the code no ` +
              `longer has. ${ADVICE}`,
          ),
        );
      }
      return { key: won.key, value: branch.settle(won.payload) };
    }
    if (this.mode !== "run") {
      throw this.interrupt("halt");
    }
    this.assertAlive();
    const branchNames = this.deps.textCheck("payload");
    for (const [key, branch] of branches) {
      assertStorableText(
        `A waitForAny("${name}") branch's name`,
        key,
        branchNames,
      );
      if (branch.wait) {
        this.checkWait(branch.wait);
      }
    }
    const now = this.deps.clock.now();
    const reached = entry?.data as
      | { waits: Record<string, WorkflowWait>; timers: Record<string, number> }
      | undefined;
    const data: {
      waits: Record<string, WorkflowWait>;
      timers: Record<string, number>;
    } = { waits: {}, timers: {} };
    for (const [key, branch] of branches) {
      if (branch.wait) {
        data.waits[key] = branch.wait;
      } else {
        data.timers[key] =
          reached?.timers[key] ??
          wakeTime(`${name}: ${key}`, branch.timer!, now);
      }
    }
    const deadlines = Object.values(data.timers);
    const deadline = deadlines.length > 0 ? Math.min(...deadlines) : null;
    const pending: WorkflowJournalEntry = {
      name,
      kind: "any",
      status: "pending",
      attempts: 0,
      wakeAt: deadline,
      data,
    };
    if (!entry) {
      this.stage(pending);
    }
    const reads = [...branches].filter(([, branch]) => branch.wait !== null);
    const candidates = await Promise.all(
      reads.map(([, branch]) => this.signalsFor(branch.wait!)),
    );
    this.assertAlive();
    let winner:
      | { key: string; branch: Condition; signal: WorkflowSignalRecord }
      | undefined;
    for (const [i, [key, branch]] of reads.entries()) {
      const signal = this.peek(candidates[i]!, deadline, branch.match);
      if (signal && (!winner || signal.id < winner.signal.id)) {
        winner = { key, branch, signal };
      }
    }
    if (winner) {
      this.consumed.add(winner.signal.id);
      const outcome = {
        key: winner.key,
        signalId: winner.signal.id,
        payload: winner.signal.payload,
      };
      await this.write([{ ...pending, status: "completed", result: outcome }]);
      if (!winner.branch.wait!.signal.startsWith("$")) {
        this.emit({
          type: "signal-received",
          wait: name,
          signal: winner.branch.wait!.signal,
          signalId: winner.signal.id,
        });
      }
      return {
        key: winner.key,
        value: winner.branch.settle(winner.signal.payload),
      };
    }
    if (deadline !== null && this.deps.clock.now() >= deadline) {
      const key = Object.keys(data.timers).find(
        (timer) => data.timers[timer] === deadline,
      )!;
      await this.write([
        {
          ...pending,
          status: "completed",
          result: { key, signalId: null, payload: null },
        },
      ]);
      return { key, value: null };
    }
    throw this.suspendUntil(deadline, Object.values(data.waits));
  }

  private signalsFor(wait: WorkflowWait): Promise<WorkflowSignalRecord[]> {
    return this.deps.store.signals({
      name: wait.signal,
      key: wait.key,
      afterId: this.instance.signalCursor,
      upToId: this.signalCursor,
    });
  }

  private peek(
    candidates: WorkflowSignalRecord[],
    deadline: number | null,
    match?: (payload: unknown) => boolean,
  ): WorkflowSignalRecord | undefined {
    return candidates.find(
      (candidate) =>
        !this.consumed.has(candidate.id) &&
        (deadline === null || candidate.createdAt <= deadline) &&
        (!match || match(candidate.payload)),
    );
  }

  private take(
    candidates: WorkflowSignalRecord[],
    deadline: number | null,
    match?: (payload: unknown) => boolean,
  ): WorkflowSignalRecord | undefined {
    const candidate = this.peek(candidates, deadline, match);
    if (candidate) {
      this.consumed.add(candidate.id);
    }
    return candidate;
  }

  private commit(name: string): void {
    this.assertNotInStep(`commit("${name}")`);
    this.visit(name, "commit");
    const entry = this.journal.get(name);
    if (entry?.status !== "completed") {
      if (this.mode !== "run") {
        throw this.interrupt("halt");
      }
      this.assertCanStart();
      this.stage({ name, kind: "commit", status: "completed", attempts: 0 });
    }
    this.compensations.splice(0);
  }

  private setStatus(status: unknown): void {
    this.assertNotInStep(
      "setStatus()",
      "Set it from run(), before or after the step.",
    );
    if (this.fatal) {
      throw this.fatal;
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(status);
    } catch (error) {
      throw new TypeError(
        `ctx.setStatus() takes a JSON-serializable value: ${(error as Error).message}`,
      );
    }
    const bytes = Buffer.byteLength(json ?? "null", "utf8");
    if (bytes > MAX_CUSTOM_STATUS_BYTES) {
      throw new TypeError(
        `ctx.setStatus() got ${bytes} bytes of JSON, over the ${MAX_CUSTOM_STATUS_BYTES}-byte limit. Keep the status a summary; ` +
          "return large data from the workflow, or keep it in your own tables.",
      );
    }
    const parsed = json === undefined ? null : JSON.parse(json);
    assertStorableJson(
      "ctx.setStatus() value",
      parsed,
      this.deps.textCheck("payload"),
    );
    this.customStatus = parsed;
  }

  statusChange(): { customStatus?: unknown } {
    return canonical(this.customStatus) === this.storedStatus
      ? {}
      : { customStatus: this.customStatus };
  }

  statusWritten(change: { customStatus?: unknown }): void {
    if (!("customStatus" in change)) {
      return;
    }
    this.storedStatus = canonical(change.customStatus);
    this.emit({ type: "custom-status", status: change.customStatus });
  }

  abandoned(): WorkflowJournalEntry[] {
    return [...this.journal.values()]
      .filter(
        (entry) => entry.status === "pending" && entry.kind !== "compensation",
      )
      .map((entry) => ({ ...entry, status: "cancelled", wakeAt: null }));
  }

  private helper<T>(kind: "now" | "random" | "uuid", produce: () => T): T {
    this.assertNotInStep(
      `${kind}()`,
      "Inside a step, read the real value directly: the step result is journaled.",
    );
    const name = `$${kind}:${++this.counters[kind]}`;
    this.visit(name, kind);
    const entry = this.journal.get(name);
    if (entry?.status === "completed") {
      return entry.result as T;
    }
    if (this.mode !== "run") {
      throw this.interrupt("halt");
    }
    this.assertCanStart();
    const value = produce();
    this.stage({ name, kind, status: "completed", attempts: 0, result: value });
    return value;
  }

  private plan(
    name: string,
    options: Pick<
      WorkflowStepOptions<unknown>,
      "retry" | "timeout" | "heartbeatTimeout"
    >,
  ): StepPlan {
    try {
      return {
        policy: resolveRetry(options.retry, this.deps.defaultRetry),
        timeoutMs:
          options.timeout === undefined
            ? undefined
            : parseDuration(options.timeout),
        heartbeatTimeoutMs:
          options.heartbeatTimeout === undefined
            ? undefined
            : parseDuration(options.heartbeatTimeout),
      };
    } catch (error) {
      throw new TypeError(
        `Invalid options for "${name}": ${(error as Error).message}`,
      );
    }
  }

  private async attempt(
    name: string,
    kind: "step" | "compensation",
    fn: (ctx: WorkflowStepContext) => unknown,
    plan: StepPlan,
    entry: WorkflowJournalEntry | undefined,
  ): Promise<{ value: unknown; attempt: number }> {
    const { policy } = plan;
    const previous = entry?.status === "pending" ? entry.attempts : 0;
    if (entry?.status === "pending" && previous > 0) {
      if (entry.wakeAt != null && this.deps.clock.now() < entry.wakeAt) {
        throw this.suspendUntil(entry.wakeAt);
      }
      if (entry.wakeAt == null && previous >= policy.attempts) {
        throw await this.giveUp(entry, previous, {
          name: "StepInterruptedError",
          message:
            `Attempt ${previous} did not finish: the worker stopped, lost its lease, or could not write the ` +
            "result to the store (the worker logged it).",
        });
      }
    }
    const attempt = previous + 1;
    let current: WorkflowJournalEntry = {
      name,
      kind,
      status: "pending",
      attempts: attempt,
      wakeAt: null,
      progress: entry?.progress,
      error: entry?.error,
    };
    await this.write([current]);
    const startedAt = performance.now();
    let value: unknown;
    try {
      const raw = await this.invoke(
        name,
        fn,
        plan,
        attempt,
        current,
        (next) => {
          current = next;
        },
      );
      try {
        value = normalize(raw);
      } catch (error) {
        throw new NonRetryableStepError(
          `Result of "${name}" is not JSON-serializable: ${(error as Error).message}`,
        );
      }
      const unstorable = unstorableJson(
        `Result of "${name}"`,
        value,
        this.deps.textCheck("payload"),
      );
      if (unstorable) {
        throw new NonRetryableStepError(unstorable.message);
      }
    } catch (error) {
      if (this.abort.signal.aborted) {
        if (this.shuttingDown && !this.leaseLost && !this.storeError) {
          this.rollbacks.push({ ...current, attempts: attempt - 1 });
        }
        throw this.abortInterrupt();
      }
      if (this.fatal) {
        throw this.fatal;
      }
      if (isWorkflowInterrupt(error)) {
        throw error;
      }
      let serialized = serializeError(error);
      let retryAt: number | null = null;
      if (!(error instanceof NonRetryableStepError)) {
        const next = nextRetry(policy, attempt, error);
        if (next.retry) {
          retryAt = this.deps.clock.now() + next.delay;
        } else if (next.reason === "threw") {
          const thrown = serializeError(next.error);
          serialized = {
            ...thrown,
            message: `The retry options of "${name}" threw ${thrown.name}: ${thrown.message} (handling ${serialized.name}: ${serialized.message})`,
          };
        }
      }
      if (retryAt === null) {
        throw await this.giveUp(current, attempt, serialized);
      }
      await this.write([{ ...current, error: serialized, wakeAt: retryAt }]);
      this.emit({
        type: "step-failed",
        step: name,
        attempt,
        error: serialized,
        retryAt,
      });
      throw this.suspendUntil(retryAt);
    }
    await this.write([
      {
        ...current,
        status: "completed",
        result: value,
        error: undefined,
        progress: undefined,
      },
    ]);
    if (kind === "step") {
      this.emit({
        type: "step-completed",
        step: name,
        attempt,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    return { value, attempt };
  }

  private invoke(
    name: string,
    fn: (ctx: WorkflowStepContext) => unknown,
    { timeoutMs: overallMs, heartbeatTimeoutMs: idleMs }: StepPlan,
    attempt: number,
    entry: WorkflowJournalEntry,
    update: (entry: WorkflowJournalEntry) => void,
  ): Promise<unknown> {
    const controller = new AbortController();
    const forward = () => controller.abort(this.abort.signal.reason);
    if (this.abort.signal.aborted) {
      forward();
    } else {
      this.abort.signal.addEventListener("abort", forward, { once: true });
    }
    let expire!: (error: Error) => void;
    const watchdog = new Promise<never>((_, reject) => {
      expire = (error) => {
        controller.abort(error);
        reject(error);
      };
    });
    const overall =
      overallMs === undefined
        ? undefined
        : setTimer(
            () =>
              expire(
                new StepTimeoutError(
                  `Step "${name}" timed out after ${overallMs}ms.`,
                ),
              ),
            overallMs,
          ).unref();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idleMs === undefined) {
        return;
      }
      clearTimeout(idle);
      idle = setTimer(
        () =>
          expire(
            new StepTimeoutError(
              `Step "${name}" sent no heartbeat for ${idleMs}ms.`,
            ),
          ),
        idleMs,
      ).unref();
    };
    armIdle();
    let current = entry;
    let settled = false;
    const ctx: WorkflowStepContext = {
      idempotencyKey: `${this.instance.id}:${name}`,
      attempt,
      signal: controller.signal,
      progress: entry.progress,
      heartbeat: async (progress?: unknown) => {
        if (settled) {
          controller.signal.throwIfAborted();
          return;
        }
        armIdle();
        if (progress === undefined) {
          await this.renew();
          if (this.leaseLost) {
            throw this.interrupt("lease-lost");
          }
          return;
        }
        const json = normalize(progress);
        assertStorableJson(
          "Step progress",
          json,
          this.deps.textCheck("payload"),
        );
        current = { ...current, progress: json };
        update(current);
        await this.write([current]);
      },
    };
    const run = Promise.resolve().then(() =>
      runInStepScope(ctx.idempotencyKey, () =>
        insideStep.run(
          { execution: this, name, outer: insideStep.getStore() },
          () => fn(ctx),
        ),
      ),
    );
    return Promise.race([run, watchdog]).finally(() => {
      settled = true;
      clearTimeout(overall);
      clearTimeout(idle);
      this.abort.signal.removeEventListener("abort", forward);
    });
  }

  private async giveUp(
    entry: WorkflowJournalEntry,
    attempts: number,
    error: SerializedWorkflowError,
  ): Promise<StepFailedError> {
    await this.write([
      {
        ...entry,
        status: "failed",
        attempts,
        error,
        wakeAt: null,
        progress: undefined,
      },
    ]);
    if (entry.kind === "step") {
      this.emit({
        type: "step-failed",
        step: entry.name,
        attempt: attempts,
        error,
        retryAt: null,
      });
    }
    return new StepFailedError(entry.name, attempts, error);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(settled);
    void settled.then(() => this.inflight.delete(settled));
    return promise;
  }

  private assertNotInStep(
    call: string,
    advice = "Call ctx methods from run() and pass the values the step needs into it.",
  ): void {
    let frame = insideStep.getStore();
    while (frame && frame.execution !== this) {
      frame = frame.outer;
    }
    if (!frame) {
      return;
    }
    const step = frame.name;
    const where = step.startsWith(COMPENSATE)
      ? `the compensation of step "${step.slice(COMPENSATE.length)}"`
      : `step "${step}"`;
    throw this.setFatal(
      new WorkflowDefinitionError(
        `${this.describe()}: ${where} called ctx.${call}. A step's function runs once and replays return its ` +
          `result, so it can't use ctx. ${advice}`,
      ),
    );
  }

  private visit(
    name: string,
    kind: WorkflowJournalEntry["kind"],
    internal = false,
  ): void {
    if (this.fatal) {
      throw this.fatal;
    }
    const helper = kind === "now" || kind === "random" || kind === "uuid";
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      (!helper && !internal && name.startsWith("$"))
    ) {
      throw this.setFatal(
        new WorkflowDefinitionError(
          `Invalid ${kind} name "${name}". Names cannot be empty or start with "$".`,
        ),
      );
    }
    if (this.visited.has(name)) {
      throw this.setFatal(
        new WorkflowDefinitionError(
          `"${name}" is used twice in one run of workflow "${this.instance.workflow}@${this.instance.version}". ` +
            "Step, sleep and wait names must be unique per run; inside a loop, add the index (`remind-${i}`).",
        ),
      );
    }
    this.visited.add(name);
    const entry = this.journal.get(name);
    if (!entry && this.mode === "run") {
      this.assertJournalRoom(name);
      this.checkKey("journalName", name);
      assertStorableText(
        "A journal entry's name (a step's, a sleep's or a wait's)",
        name,
        this.deps.textCheck("name"),
      );
    }
    if (entry && entry.kind !== kind) {
      throw this.setFatal(
        new WorkflowNonDeterminismError(
          `${this.describe()} does not match its journal: "${name}" was recorded as a ${entry.kind}, but the code now calls it as a ${kind}. ${ADVICE}`,
        ),
      );
    }
  }

  private reachFrontier(step: string): Promise<void> {
    this.frontier ??= (async () => {
      await nextMacrotask();
      const missing = this.unvisited();
      if (missing.length) {
        throw this.setFatal(
          new WorkflowNonDeterminismError(
            `${this.describe()} does not match its journal: ${missing.map((n) => `"${n}"`).join(", ")} ` +
              `${missing.length === 1 ? "was" : "were"} recorded by an earlier run but not reached before the new step "${step}". ${ADVICE}`,
          ),
        );
      }
    })();
    return this.frontier;
  }

  private reserveCompensation<T>(
    step: string,
    options: WorkflowStepOptions<T>,
  ): { arm(result: unknown): void } | undefined {
    if (!options.compensate) {
      return undefined;
    }
    const compensation: RegisteredCompensation = {
      step,
      completed: false,
      fn: options.compensate,
      retry: options.compensateRetry ?? options.retry,
    };
    this.compensations.push(compensation);
    return {
      arm: (result) => {
        compensation.result = result;
        compensation.completed = true;
      },
    };
  }

  private assertAlive(): void {
    if (this.fatal) {
      throw this.fatal;
    }
    if (this.leaseLost) {
      throw this.interrupt("lease-lost");
    }
    if (this.storeError) {
      throw this.interrupt("store-error");
    }
    if (this.shuttingDown) {
      throw this.interrupt("shutdown");
    }
    if (this.cancelRequested) {
      throw this.interrupt("cancel");
    }
    if (this.pastDeadline()) {
      throw this.interrupt("timeout");
    }
  }

  pastDeadline(): boolean {
    return (
      this.instance.deadline !== null &&
      this.deps.clock.now() >= this.instance.deadline
    );
  }

  private assertCanStart(): void {
    this.assertAlive();
    if (this.suspension) {
      throw this.interrupt("suspend");
    }
    if (this.userSettled) {
      throw this.interrupt("halt");
    }
  }

  private suspendUntil(
    wakeAt: number | null,
    waits: WorkflowWait[] = [],
  ): WorkflowInterrupt {
    this.suspension ??= { wakeAt: null, waits: [] };
    if (wakeAt !== null) {
      this.suspension.wakeAt =
        this.suspension.wakeAt === null
          ? wakeAt
          : Math.min(this.suspension.wakeAt, wakeAt);
    }
    this.suspension.waits.push(...waits);
    return this.interrupt("suspend");
  }

  private stage(entry: WorkflowJournalEntry): void {
    this.record(entry);
    this.buffer.push(entry);
  }

  private record(entry: WorkflowJournalEntry): void {
    this.journal.set(entry.name, entry);
    this.measure(entry);
    if (this.journalLarge || !this.pastWarning()) {
      return;
    }
    this.journalLarge = true;
    const { warnEntries, warnBytes } = this.deps.journalLimits;
    WorkflowExecution.logger.warn(
      `${this.describe()} has ${this.journal.size} journal entries (${this.journalBytes} bytes), past the warning line of ` +
        `${warnEntries} entries or ${warnBytes} bytes: every execution loads and replays all of it. Bound the loop that grows it, ` +
        "or continue in a new instance.",
    );
    this.emit({
      type: "journal-large",
      entries: this.journal.size,
      bytes: this.journalBytes,
    });
  }

  private measure(entry: WorkflowJournalEntry): void {
    const bytes = entryBytes(entry);
    this.journalBytes += bytes - (this.entrySizes.get(entry.name) ?? 0);
    this.entrySizes.set(entry.name, bytes);
  }

  private pastWarning(): boolean {
    const { warnEntries, warnBytes } = this.deps.journalLimits;
    return this.journal.size >= warnEntries || this.journalBytes >= warnBytes;
  }

  private assertJournalRoom(name: string): void {
    const { maxEntries, maxBytes } = this.deps.journalLimits;
    if (this.journal.size < maxEntries && this.journalBytes < maxBytes) {
      return;
    }
    this.journalLimitError ??= {
      name: "WorkflowJournalLimitError",
      message:
        `${this.describe()} reached its journal limit before "${name}": ${this.journal.size} entries, ${this.journalBytes} bytes ` +
        `(journal.maxEntries ${maxEntries}, journal.maxBytes ${maxBytes}). Continue a long loop in a new instance instead.`,
    };
    throw this.interrupt("journal-limit");
  }

  private checkKey(
    kind: WorkflowKeyKind,
    value: string | null | undefined,
  ): void {
    if (typeof value === "string") {
      this.deps.store.checkKey?.(kind, value);
    }
  }

  private checkWait(wait: WorkflowWait): void {
    this.checkKey("signal", wait.signal);
    this.checkKey("signalKey", wait.key);
    for (const check of [
      this.deps.textCheck("key"),
      this.deps.textCheck("payload"),
    ]) {
      assertStorableText("A wait's signal name", wait.signal, check);
      assertStorableText("A wait's signal key", wait.key, check);
    }
  }

  private async write(entries: WorkflowJournalEntry[]): Promise<void> {
    if (this.detached) {
      throw this.interrupt("shutdown");
    }
    for (const entry of entries) {
      this.record(entry);
    }
    const now = this.deps.clock.now();
    const batch = [...this.buffer.splice(0), ...entries].map((entry) => ({
      ...entry,
      updatedAt: now,
    }));
    const previous = this.writes;
    let done!: () => void;
    this.writes = new Promise<void>((resolve) => {
      done = resolve;
    });
    try {
      await previous;
      if (this.detached) {
        throw this.interrupt("shutdown");
      }
      let ok: boolean;
      const change = this.statusChange();
      try {
        ok = await this.deps.store.write(
          this.instance.id,
          this.instance.leaseToken,
          { now, entries: uniqueEntries(batch), ...change },
        );
      } catch (error) {
        this.storeError = error;
        this.abort.abort(new WorkflowInterrupt("store-error"));
        throw this.interrupt("store-error");
      }
      if (!ok) {
        this.loseLease();
        throw this.interrupt("lease-lost");
      }
      this.statusWritten(change);
    } finally {
      done();
    }
  }

  private loseLease(): void {
    if (this.leaseLost) {
      return;
    }
    this.leaseLost = true;
    this.abort.abort(new WorkflowInterrupt("lease-lost"));
    this.lease.loseLease();
  }

  private abortInterrupt(): WorkflowInterrupt {
    return this.interrupt(
      this.leaseLost
        ? "lease-lost"
        : this.storeError
          ? "store-error"
          : "shutdown",
    );
  }

  private interrupt(reason: InterruptReason): WorkflowInterrupt {
    const interrupt = new WorkflowInterrupt(reason);
    if (reason !== "suspend" && reason !== "halt") {
      this.stoppedBy ??= interrupt;
    }
    return interrupt;
  }

  private setFatal<T extends Error>(error: T): T {
    this.fatal ??= error;
    return this.fatal as T;
  }

  private describe(): string {
    return `Instance "${this.instance.id}" of workflow "${this.instance.workflow}@${this.instance.version}"`;
  }

  private emit(body: EventBody): void {
    this.deps.events.emit({
      id: this.instance.id,
      workflow: this.instance.workflow,
      version: this.instance.version,
      at: this.deps.clock.now(),
      ...body,
    } as WorkflowEvent);
  }
}

function unlessCancelled(
  entry: WorkflowJournalEntry | undefined,
): WorkflowJournalEntry | undefined {
  return entry?.status === "cancelled" ? undefined : entry;
}

function wakeTime(
  name: string,
  when: Duration | { until: Date | number },
  now: number,
): number {
  if (typeof when !== "object") {
    return now + parseDuration(when);
  }
  const until = when.until instanceof Date ? when.until.getTime() : when.until;
  if (typeof until !== "number" || !Number.isFinite(until)) {
    throw new TypeError(
      `Invalid deadline for sleep "${name}": ${String(when.until)}. Pass a valid Date or a timestamp in milliseconds.`,
    );
  }
  return until;
}

function conditionsOf(
  name: string,
  conditions: Record<string, WorkflowCondition<unknown>>,
): Map<string, Condition> {
  const entries =
    conditions !== null && typeof conditions === "object"
      ? Object.entries(conditions)
      : [];
  if (entries.length === 0) {
    throw new TypeError(
      `waitForAny("${name}") takes an object with at least one condition, such as { delivered: ctx.signalWait(shipmentDelivered) }.`,
    );
  }
  const branches = new Map<string, Condition>();
  for (const [key, condition] of entries) {
    const branch =
      condition instanceof ChildHandle ? condition.condition : condition;
    if (!(branch instanceof Condition)) {
      throw new TypeError(
        `waitForAny("${name}"): "${key}" is not a condition. Make each one with ctx.signalWait() or ctx.timer(), or pass a child's handle.`,
      );
    }
    branches.set(key, branch);
  }
  return branches;
}
