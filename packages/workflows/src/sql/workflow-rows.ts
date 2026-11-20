// What the first-party SQL stores share, free of either dialect: the columns they read, and how a row they read (every
// column cast to text) becomes an instance or a schedule. PostgresWorkflowStore and MySqlWorkflowStore name the same
// columns, and the kit's readers (`toText()`, `toInt()`, `toBool()`, `toJson()`) read both dialects' text.
import { toBool, toInt, toJson } from "@bunest/store-kit";
import type { SerializedWorkflowError } from "../interfaces/serialized-workflow-error.interface";
import type {
  WorkflowInstance,
  WorkflowParentClose,
  WorkflowStatus,
} from "../interfaces/workflow-instance.interface";
import type { WorkflowScheduleRecord } from "../interfaces/workflow-store.interface";

/** A row as the SQL stores read it: every column cast to text (see the kit's `columns()`). */
export type Row = Record<string, string | null>;

/** The statuses a claim takes: an instance that hasn't finished. */
export const RUNNABLE_STATUSES: readonly WorkflowStatus[] = [
  "pending",
  "running",
  "suspended",
  "compensating",
];

/** The statuses a cancel applies to (a terminate: `RUNNABLE_STATUSES`). */
export const CANCELLABLE_STATUSES: readonly WorkflowStatus[] = [
  "pending",
  "running",
  "suspended",
];

/** An instance's columns, as `toInstance()` reads them. */
export const INSTANCE_COLUMNS: readonly string[] = [
  "id",
  "workflow",
  "version",
  "parent_id",
  "parent_close",
  "concurrency_key",
  "rate_limit_key",
  "priority",
  "schedule_id",
  "scheduled_at",
  "status",
  "input",
  "output",
  "error",
  "wake_at",
  "lease_owner",
  "lease_until",
  "cancel_requested",
  "terminate_requested",
  "cancel_reason",
  "deadline",
  "custom_status",
  "signal_cursor",
  "runs",
  "created_at",
  "updated_at",
];

/** A schedule's columns, as `toSchedule()` reads them. */
export const SCHEDULE_COLUMNS: readonly string[] = [
  "id",
  "workflow",
  "declared",
  "spec",
  "input",
  "paused",
  "wake_at",
  "state",
  "revision",
  "lease_owner",
  "lease_until",
  "created_at",
  "updated_at",
];

/** The columns of a signal as `WorkflowStore.signals()` returns it. */
export const SIGNAL_COLUMNS: readonly string[] = [
  "id",
  "name",
  "key",
  "payload",
  "created_at",
];

export function toInstance(row: Row): WorkflowInstance {
  return {
    id: row.id as string,
    workflow: row.workflow as string,
    version: toInt(row.version) as number,
    parentId: row.parent_id ?? null,
    parentClose: (row.parent_close ?? null) as WorkflowParentClose | null,
    concurrencyKey: row.concurrency_key ?? null,
    rateLimitKey: row.rate_limit_key ?? null,
    priority: toInt(row.priority) as number,
    scheduleId: row.schedule_id ?? null,
    scheduledAt: toInt(row.scheduled_at),
    status: row.status as WorkflowStatus,
    input: toJson(row.input),
    output: toJson(row.output),
    error: toJson(row.error) as SerializedWorkflowError | null,
    wakeAt: toInt(row.wake_at),
    leaseOwner: row.lease_owner ?? null,
    leaseUntil: toInt(row.lease_until),
    cancelRequested: toBool(row.cancel_requested),
    terminateRequested: toBool(row.terminate_requested),
    cancelReason: row.cancel_reason ?? null,
    deadline: toInt(row.deadline),
    customStatus: toJson(row.custom_status),
    signalCursor: toInt(row.signal_cursor) as number,
    runs: toInt(row.runs) as number,
    createdAt: toInt(row.created_at) as number,
    updatedAt: toInt(row.updated_at) as number,
  };
}

export function toSchedule(row: Row): WorkflowScheduleRecord {
  return {
    id: row.id as string,
    workflow: row.workflow as string,
    declared: toBool(row.declared),
    spec: toJson(row.spec),
    input: toJson(row.input),
    paused: toBool(row.paused),
    wakeAt: toInt(row.wake_at),
    state: toJson(row.state),
    revision: toInt(row.revision) as number,
    leaseOwner: row.lease_owner ?? null,
    leaseUntil: toInt(row.lease_until),
    createdAt: toInt(row.created_at) as number,
    updatedAt: toInt(row.updated_at) as number,
  };
}
