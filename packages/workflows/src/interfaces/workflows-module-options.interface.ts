import type { ConfigurableModuleAsyncOptions, Type } from "@bunest/common";
import type { Duration } from "../core/time/duration";
import type { WorkflowClock } from "./workflow-clock.interface";
import type { WorkflowPayloadCodec } from "./workflow-payload-codec.interface";
import type { WorkflowRetryOptions } from "./workflow-retry-options.interface";

export interface WorkflowWorkerOptions {
  /** Run the background polling loop. Default true. */
  enabled?: boolean;
  /** Shown as `leaseOwner`. Default `hostname:pid:random`. */
  id?: string;
  /** Instances executed at once by this process. Default 10. */
  concurrency?: number;
  /** How often to look for due instances. Default 1s; local starts and signals wake the loop at once. */
  pollInterval?: Duration;
  /** How long a claim is valid without a heartbeat. Default 30s. */
  leaseDuration?: Duration;
  /** How often a running instance extends its lease. Default a third of `leaseDuration`. */
  heartbeatInterval?: Duration;
  /** How long shutdown waits for running executions before abandoning them. Default 10s. */
  shutdownTimeout?: Duration;
}

export interface WorkflowJournalLimits {
  /** Log a warning, and emit `journal-large`, once, when an instance's journal reaches this many entries. Default 1,000. */
  warnEntries?: number;
  /** The same, at this many bytes. Default 1,000,000 (1 MB). */
  warnBytes?: number;
  /** Fail the instance before it records a new entry once its journal holds this many. Default 10,000. */
  maxEntries?: number;
  /** The same, at this many bytes. Default 10,000,000 (10 MB). */
  maxBytes?: number;
}

/** What `forRoot()` takes, and what `forRootAsync()`'s factory returns. */
export interface WorkflowsModuleOptions {
  /** Default: the system clock. Pass a `ManualWorkflowClock` in tests. */
  clock?: WorkflowClock;
  /** `false` is shorthand for `{ enabled: false }`. */
  worker?: WorkflowWorkerOptions | false;
  /** How large a journal may grow before a warning, and before the instance fails. */
  journal?: WorkflowJournalLimits;
  /** Default step retry: 3 attempts, 1s doubling up to 5m, no jitter. */
  retry?: number | false | WorkflowRetryOptions;
  /** Allow running in-memory storage when `NODE_ENV=production`. */
  allowInMemoryStorage?: boolean;
  /** Encodes what workflows store for you before the store sees it. */
  codec?:
    | WorkflowPayloadCodec
    | Type<WorkflowPayloadCodec>
    | Array<WorkflowPayloadCodec | Type<WorkflowPayloadCodec>>;
}

/** Implemented by a `forRootAsync({ useClass })` class: Nest calls `createWorkflowsOptions()`. */
export interface WorkflowsOptionsFactory {
  createWorkflowsOptions():
    | WorkflowsModuleOptions
    | Promise<WorkflowsModuleOptions>;
}

/** What `forRootAsync()` takes: `imports`, `inject` and `useFactory`, `useClass` or `useExisting`, and `isGlobal`. */
export type WorkflowsModuleAsyncOptions = ConfigurableModuleAsyncOptions<
  WorkflowsModuleOptions,
  "createWorkflowsOptions"
> & {
  /** Default true. */
  isGlobal?: boolean;
};
