import type { SerializedWorkflowError } from "./serialized-workflow-error.interface";
import type { WorkflowRateWindow } from "./workflow-decorator-options.interface";
import type {
  WorkflowInstance,
  WorkflowJournalEntry,
  WorkflowParentClose,
  WorkflowStatus,
  WorkflowWait,
} from "./workflow-instance.interface";

/**
 * Where workflow instances, their journals, their waits and the signals sent to them live.
 */
export interface WorkflowStore {
  create(instance: NewWorkflowInstance): Promise<{
    instance: WorkflowInstance;
    created: boolean;
  }>;
  createInTransaction?(
    transaction: unknown,
    instance: NewWorkflowInstance,
  ): Promise<{
    instance: WorkflowInstance;
    created: boolean;
  }>;
  get(
    id: string,
    options?: { journal?: boolean },
  ): Promise<WorkflowInstanceDetails | null>;
  list(query: WorkflowListQuery): Promise<WorkflowInstance[]>;
  requestCancel(id: string, request: WorkflowCancelRequest): Promise<boolean>;
  reopen(id: string, reopen: WorkflowReopen): Promise<boolean>;
  delete(id: string, statuses: WorkflowStatus[]): Promise<boolean>;
  signal(signal: NewWorkflowSignal): Promise<WorkflowSignalResult>;
  signalInTransaction?(
    transaction: unknown,
    signal: NewWorkflowSignal,
  ): Promise<WorkflowSignalResult>;
  signals(query: WorkflowSignalQuery): Promise<WorkflowSignalRecord[]>;
  purge(query: WorkflowPurgeQuery): Promise<WorkflowPurgeResult>;
  saveSchedule(
    schedule: WorkflowScheduleSave,
  ): Promise<WorkflowScheduleRecord | null>;
  getSchedule(id: string): Promise<WorkflowScheduleRecord | null>;
  listSchedules(
    query: WorkflowScheduleQuery,
  ): Promise<WorkflowScheduleRecord[]>;
  deleteSchedule(id: string, revision?: number): Promise<boolean>;
  claimSchedules(
    request: WorkflowScheduleClaimRequest,
  ): Promise<WorkflowScheduleRecord[]>;
  writeSchedule(
    id: string,
    token: string,
    write: WorkflowScheduleWrite,
  ): Promise<boolean>;
  claim(request: WorkflowClaimRequest): Promise<WorkflowClaim>;
  renew(
    id: string,
    token: string,
    leaseUntil: number,
  ): Promise<{
    cancelRequested: boolean;
    terminateRequested: boolean;
  } | null>;
  write(id: string, token: string, write: WorkflowWrite): Promise<boolean>;
  checkKey?(kind: WorkflowKeyKind, value: string): void;
  unstorableText?(text: string, column: WorkflowTextColumn): string | undefined;
}

/** The ids, names and keys `WorkflowStore.checkKey()` checks. */
export type WorkflowKeyKind =
  | "instanceId"
  | "workflow"
  | "concurrencyKey"
  | "rateLimitKey"
  | "journalName"
  | "signal"
  | "signalKey";

/** Where `WorkflowStore.unstorableText()`'s text is stored: inside a JSON value, or in a text column of its own. */
export type WorkflowTextColumn = "json" | "text";

/** `WorkflowStore.get()`'s result, and `WorkflowClient.getStatus()`'s. */
export interface WorkflowInstanceDetails extends WorkflowInstance {
  /** Signals the instance waits for, if suspended in `waitForSignal()`. */
  waits: WorkflowWait[];
  /** `WorkflowClient.getStatus(id, { children: true })` only: the instances it started with `ctx.startChild()`, oldest first. */
  children?: WorkflowInstance[];
  /** With `{ journal: true }`: every step, sleep, wait and compensation, in first-write order. */
  journal?: WorkflowJournalEntry[];
}

export interface NewWorkflowInstance {
  id: string;
  workflow: string;
  version: number;
  input: unknown;
  /** For a child (`ctx.startChild()`): its parent's id, stored as `parentId`. Absent: `null`. */
  parentId?: string | null;
  /** For a child: stored as `parentClose`. Absent: `null`. */
  parentClose?: WorkflowParentClose | null;
  /** Stored as `concurrencyKey`: the key its workflow's per-key limit counts it under. Absent: `null`. */
  concurrencyKey?: string | null;
  /** Stored as `rateLimitKey`: the key its workflow's per-key rate limit counts it under. Absent: `null`. */
  rateLimitKey?: string | null;
  /** Stored as `priority`: lower is claimed first. Absent: `0`, which goes before every other priority. */
  priority?: number;
  /** For an instance a schedule started: the schedule's id, stored as `scheduleId`. Absent: `null`. */
  scheduleId?: string | null;
  /** For an instance a schedule started: the occurrence's time, stored as `scheduledAt`. Absent: `null`. */
  scheduledAt?: number | null;
  /** The instance's `deadline`: when its run timeout passes, or `null`. Stored as is. */
  deadline: number | null;
  now: number;
}

/** What `WorkflowStore.requestCancel()` receives. */
export interface WorkflowCancelRequest {
  reason: string | null;
  now: number;
  /** `WorkflowClient.terminate()`: stop without compensating. */
  terminate: boolean;
}

/** What `WorkflowStore.list()` receives: validated and defaulted by the engine. */
export interface WorkflowListQuery {
  /** Any of these statuses (never empty). */
  status?: WorkflowStatus[];
  workflow?: string;
  version?: number;
  /** Children of this instance. */
  parentId?: string;
  /** Instances this schedule started. */
  scheduleId?: string;
  limit: number;
  offset: number;
}

export interface NewWorkflowSignal {
  name: string;
  /** Correlation key; `null` for a signal sent without one. Matches waits with exactly this key. */
  key: string | null;
  /** The sender's id for this signal, unique per signal name. `null`: never deduplicated. */
  dedupeId: string | null;
  payload: unknown;
  now: number;
}

/** What `WorkflowStore.signal()` and `signalInTransaction()` return. */
export interface WorkflowSignalResult {
  id: number;
  woken: number;
  created: boolean;
  key: string | null;
}

/** What `WorkflowStore.reopen()` receives. */
export interface WorkflowReopen {
  expect: {
    status: WorkflowStatus;
    runs: number;
  };
  status: "pending" | "compensating";
  error: SerializedWorkflowError | null;
  deadline?: number | null;
  entries: WorkflowJournalEntry[];
  now: number;
}

/** What `WorkflowStore.purge()` receives. */
export interface WorkflowPurgeQuery {
  statuses: WorkflowStatus[];
  before: number;
  limit: number;
}

/** How many instances, signals and rate-limit windows a purge deleted. */
export interface WorkflowPurgeResult {
  instances: number;
  signals: number;
  rateLimits: number;
}

export interface WorkflowSignalQuery {
  name: string;
  key: string | null;
  afterId: number;
  upToId: number;
}

/** A signal as stored. */
export interface WorkflowSignalRecord {
  id: number;
  name: string;
  key: string | null;
  payload: unknown;
  createdAt: number;
}

export interface WorkflowClaimRequest {
  owner: string;
  token: string;
  now: number;
  leaseUntil: number;
  limit: number;
  workflows: Array<{
    name: string;
    version: number;
  }>;
  limits?: WorkflowConcurrencyLimit[];
  rateLimits?: WorkflowRateLimitRule[];
}

/** A workflow's rate limits, as a claim applies them: at most `max` claims per window of `duration` ms. */
export interface WorkflowRateLimitRule {
  workflow: string;
  limit: WorkflowRateWindow | null;
  perKey: WorkflowRateWindow | null;
}

/** A workflow's concurrency limits, as a claim applies them. */
export interface WorkflowConcurrencyLimit {
  workflow: string;
  limit: number | null;
  perKey: number | null;
}

export interface WorkflowClaim {
  instances: WorkflowInstance[];
  lastSignalId: number;
}

export interface WorkflowWrite {
  now: number;
  entries: WorkflowJournalEntry[];
  status?: WorkflowStatus;
  output?: unknown;
  error?: SerializedWorkflowError | null;
  customStatus?: unknown;
  signal?: NewWorkflowSignal;
  release?: WorkflowRelease;
}

export interface WorkflowRelease {
  wakeAt: number | null;
  waits: WorkflowWait[];
  signalCursor: number;
}

/** A schedule as stored: `WorkflowStore.getSchedule()`, `listSchedules()` and `claimSchedules()` return it. */
export interface WorkflowScheduleRecord {
  id: string;
  workflow: string;
  declared: boolean;
  spec: unknown;
  input: unknown;
  paused: boolean;
  wakeAt: number | null;
  state: unknown;
  revision: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

/** What `WorkflowStore.saveSchedule()` receives. */
export interface WorkflowScheduleSave {
  id: string;
  workflow: string;
  declared: boolean;
  spec: unknown;
  input: unknown;
  paused: boolean;
  wakeAt: number | null;
  state: unknown;
  expectRevision: number | null;
  releaseLease: boolean;
  now: number;
}

/** What `WorkflowStore.listSchedules()` receives. */
export interface WorkflowScheduleQuery {
  workflow?: string;
  declared?: boolean;
  limit: number;
  offset: number;
}

/** What `WorkflowStore.claimSchedules()` receives. */
export interface WorkflowScheduleClaimRequest {
  owner: string;
  token: string;
  now: number;
  leaseUntil: number;
  limit: number;
  workflows: string[];
}

/** What `WorkflowStore.writeSchedule()` receives. */
export interface WorkflowScheduleWrite {
  now: number;
  state: unknown;
  wakeAt: number | null;
  release: boolean;
}
