import type { Duration } from "../core/time/duration";
import type {
  WorkflowInstance,
  WorkflowStatus,
} from "./workflow-instance.interface";

export interface StartWorkflowOptions {
  /** Instance id; default a random UUID. */
  id?: string;
  /** Pin a version (a positive integer). */
  version?: number;
  /** How long the instance may run, overriding the workflow's `@Workflow(name, { timeout })`. */
  timeout?: Duration;
  /** The key the workflow's per-key concurrency limit counts the instance under. */
  concurrencyKey?: string;
  /** The key the workflow's per-key rate limit counts the instance under. */
  rateLimitKey?: string;
  /** Lower runs first: an integer from 1 to 2,097,151. */
  priority?: number;
  /** Your ORM's transaction handle. */
  transaction?: unknown;
}

export interface SignalWorkflowOptions {
  /** Correlation key: only waits with the same key take the signal. */
  key?: string;
  /** Deduplication id, unique per signal name. */
  id?: string;
  /** Your ORM's transaction handle. */
  transaction?: unknown;
}

/** What `result()` and `startAndWait()` take. */
export interface WorkflowResultOptions {
  /** How long to wait. Past it, the call rejects with `WorkflowResultTimeoutError`. */
  timeout?: Duration;
  /** Stops waiting once aborted (a client that went away), rejecting with the signal's reason. */
  signal?: AbortSignal;
}

/** What `signal()` returns. */
export interface WorkflowSignalSendResult {
  /** The stored signal's id: the new one, or with `created: false` the one stored earlier with the same `id`. */
  signalId: number;
  /** Instances parked on a matching wait that this call woke. */
  woken: number;
  /** `false` if a signal with the same name and `id` was stored earlier: nothing was written. */
  created: boolean;
}

/** What `start()` returns: safe to send to a client (no input, no lease details). */
export interface WorkflowStartResult {
  id: string;
  workflow: string;
  version: number;
  /** False if an instance with this id already existed. */
  created: boolean;
  status: WorkflowStatus;
}

export interface WorkflowCancelResult extends WorkflowInstance {
  /**
   * True if this call requested the cancellation.
   */
  accepted: boolean;
}

export interface WorkflowListFilter {
  status?: WorkflowStatus | WorkflowStatus[];
  /** Workflow name. */
  workflow?: string;
  /** With `workflow`: only instances on this version (to see whether an old version has drained). */
  version?: number;
  /** Only the children this instance started with `ctx.startChild()`. */
  parentId?: string;
  /** Only the instances this schedule started. */
  scheduleId?: string;
  /** Default 100. */
  limit?: number;
  offset?: number;
}

/** What `purge()` takes. */
export interface WorkflowPurgeOptions {
  /** How long finished instances are kept, such as `'30d'`. */
  olderThan: Duration;
  /** The finished statuses to purge. Default `completed`, `failed` and `cancelled`. */
  status?: WorkflowStatus | WorkflowStatus[];
  /** Instances, and signals, deleted per statement. Default 500. */
  batchSize?: number;
}

/** What `retry()` takes. */
export interface WorkflowRetryInstanceOptions {
  /** A new run timeout, counted from now; `false` removes it. */
  timeout?: Duration | false;
}

/** What `delete()` takes. */
export interface WorkflowDeleteOptions {
  /** Delete an unfinished instance too, without running its compensations. Default `false`. */
  force?: boolean;
}
