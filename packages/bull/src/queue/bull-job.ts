import type { Job as CoreJob } from "@bunest/queues";
import type {
  BullJobLike,
  BullJobOptions,
  BullJobStatus,
} from "./bull-queue.types";

export interface BullJobHost {
  readonly name: string;
  _emitJobProgress(job: BullJob<any>, progress: any): void;
  _removeJob(job: BullJob<any>): Promise<void>;
  _retryJob(job: BullJob<any>): Promise<void>;
  _promoteJob(job: BullJob<any>): Promise<void>;
  _addJobLog(jobId: string, row: string): number;
  _waitForJobFinished(job: BullJob<any>): Promise<any>;
  _isQueuePaused(): boolean;
}

/**
 * Bull v4-compatible `Job` facade wrapping a `@bunest/queues` `Job`.
 */
export class BullJob<T = any> implements BullJobLike<T> {
  public id: string | number;
  public name: string;
  public data: T;
  public opts: BullJobOptions;
  public attemptsMade: number;
  public timestamp: number;
  public processedOn?: number;
  public finishedOn?: number;
  public returnvalue?: any;
  public failedReason?: string;
  public stacktrace: string[];

  private _progress: any = 0;
  private _state: BullJobStatus;
  private _discarded = false;

  constructor(
    public readonly queue: BullJobHost,
    coreJob: CoreJob<T, any>,
    opts: BullJobOptions = {},
  ) {
    this.id = coreJob.id;
    this.name = coreJob.name;
    this.data = coreJob.data;
    this.opts = { ...opts };
    this.attemptsMade = coreJob.attemptsMade;
    this.timestamp = coreJob.createdAt;
    this.processedOn = coreJob.startedAt;
    this.finishedOn = coreJob.finishedAt;
    this.returnvalue = coreJob.returnValue;
    this.failedReason = coreJob.failedReason;
    this.stacktrace = [...coreJob.stacktrace];
    this._state = this.mapCoreStatus(coreJob.status);
  }

  private mapCoreStatus(status: CoreJob["status"]): BullJobStatus {
    switch (status) {
      case "waiting":
        return this.queue._isQueuePaused() ? "paused" : "waiting";
      case "delayed":
        return "delayed";
      case "active":
        return "active";
      case "completed":
        return "completed";
      case "failed":
      case "dead-letter":
        return "failed";
      default:
        return "waiting";
    }
  }

  _syncFromCore(coreJob: CoreJob<T, any>, overrideState?: BullJobStatus): void {
    this.attemptsMade = coreJob.attemptsMade;
    this.processedOn = coreJob.startedAt;
    this.finishedOn = coreJob.finishedAt;
    this.returnvalue = coreJob.returnValue;
    this.failedReason = coreJob.failedReason;
    this.stacktrace = [...coreJob.stacktrace];
    this._state = overrideState ?? this.mapCoreStatus(coreJob.status);
  }

  _setState(state: BullJobStatus): void {
    this._state = state;
  }

  _isDiscarded(): boolean {
    return this._discarded;
  }

  progress(): any;
  progress(value: any): Promise<void>;
  progress(value?: any): any | Promise<void> {
    if (arguments.length === 0) {
      return this._progress;
    }
    this._progress = value;
    this.queue._emitJobProgress(this, value);
    return Promise.resolve();
  }

  async log(row: string): Promise<number> {
    return this.queue._addJobLog(String(this.id), row);
  }

  async update(data: T): Promise<void> {
    this.data = data;
  }

  async remove(): Promise<void> {
    await this.queue._removeJob(this);
  }

  async retry(): Promise<void> {
    await this.queue._retryJob(this);
  }

  async discard(): Promise<void> {
    this._discarded = true;
  }

  async promote(): Promise<void> {
    await this.queue._promoteJob(this);
  }

  async getState(): Promise<BullJobStatus> {
    return this._state;
  }

  async isCompleted(): Promise<boolean> {
    return this._state === "completed";
  }

  async isFailed(): Promise<boolean> {
    return this._state === "failed";
  }

  async isDelayed(): Promise<boolean> {
    return this._state === "delayed";
  }

  async isActive(): Promise<boolean> {
    return this._state === "active";
  }

  async isWaiting(): Promise<boolean> {
    return this._state === "waiting";
  }

  async isPaused(): Promise<boolean> {
    return this._state === "paused";
  }

  async isStuck(): Promise<boolean> {
    return this._state === "stuck";
  }

  finished(): Promise<any> {
    return this.queue._waitForJobFinished(this);
  }

  toJSON(): Record<string, any> {
    return {
      id: this.id,
      name: this.name,
      data: this.data,
      opts: this.opts,
      progress: this._progress,
      delay: this.opts.delay ?? 0,
      timestamp: this.timestamp,
      attemptsMade: this.attemptsMade,
      failedReason: this.failedReason,
      stacktrace: this.stacktrace,
      returnvalue: this.returnvalue,
      finishedOn: this.finishedOn,
      processedOn: this.processedOn,
    };
  }
}
