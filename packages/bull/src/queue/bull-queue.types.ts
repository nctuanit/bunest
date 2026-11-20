import type { QueueDriver, RedisQueueClientLike } from "@bunest/queues";

export type BullJobStatus =
  | "completed"
  | "waiting"
  | "active"
  | "delayed"
  | "failed"
  | "paused"
  | "stuck";

export type JobStatusClean =
  | "completed"
  | "wait"
  | "active"
  | "delayed"
  | "failed"
  | "paused";

export interface JobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused?: number;
}

export interface BullBackoffOptions {
  type: "fixed" | "exponential" | string;
  delay?: number;
}

export interface BullKeepJobsOptions {
  age?: number;
  count?: number;
}

export interface BullJobOptions {
  priority?: number;
  delay?: number;
  attempts?: number;
  repeat?: {
    cron?: string;
    tz?: string;
    startDate?: Date | string | number;
    endDate?: Date | string | number;
    limit?: number;
    every?: number;
    count?: number;
    jobId?: string | number;
  };
  backoff?: number | BullBackoffOptions;
  lifo?: boolean;
  timeout?: number;
  jobId?: string | number;
  removeOnComplete?: boolean | number | BullKeepJobsOptions;
  removeOnFail?: boolean | number | BullKeepJobsOptions;
  stackTraceLimit?: number;
}

export interface BullRateLimiter {
  max: number;
  duration: number;
  bounceBack?: boolean;
  groupKey?: string;
}

export interface BullAdvancedSettings {
  lockDuration?: number;
  lockRenewTime?: number;
  stalledInterval?: number;
  maxStalledCount?: number;
  guardInterval?: number;
  retryProcessDelay?: number;
  backoffStrategies?: Record<
    string,
    (attemptsMade: number, err: Error) => number
  >;
  drainDelay?: number;
}

export interface BullMetricsOptions {
  maxDataPoints?: number;
}

export interface BullRedisOptions {
  host?: string;
  port?: number;
  password?: string;
  username?: string;
  db?: number;
  tls?: Record<string, unknown>;
  keyPrefix?: string;
  maxRetriesPerRequest?: number | null;
  enableReadyCheck?: boolean;
  [key: string]: any;
}

export type BullClientType = "client" | "subscriber" | "bclient";

export interface BullQueueOptions {
  /**
   * Redis connection options or connection string.
   */
  redis?: BullRedisOptions | string;
  /**
   * Custom Redis client factory (compatible with Bull v4 `createClient` and Bunest `RedisQueueClientLike`).
   */
  createClient?: (
    type: BullClientType,
    redisOpts?: BullRedisOptions,
  ) => RedisQueueClientLike | any;
  /**
   * Prefix for all queue keys.
   * @default "bull"
   */
  prefix?: string;
  /**
   * Advanced queue settings.
   */
  settings?: BullAdvancedSettings;
  /**
   * Rate limiter configuration.
   */
  limiter?: BullRateLimiter;
  /**
   * Default job options applied to every added job.
   */
  defaultJobOptions?: BullJobOptions;
  /**
   * Metrics collection options.
   */
  metrics?: BullMetricsOptions;
  /**
   * Optional Bunest `QueueDriver` override (defaults to `MemoryQueueDriver`, or `RedisQueueDriver` when a Redis client is provided).
   */
  driver?: QueueDriver;
}

export type DoneCallback = (error?: Error | null, value?: any) => void;

export interface BullJobLike<T = any> {
  id: string | number;
  name: string;
  data: T;
  opts: BullJobOptions;
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  returnvalue?: any;
  failedReason?: string;
  stacktrace: string[];
  progress(): any;
  progress(value: any): Promise<void>;
  log(row: string): Promise<number>;
  update(data: T): Promise<void>;
  remove(): Promise<void>;
  retry(): Promise<void>;
  discard(): Promise<void>;
  promote(): Promise<void>;
  getState(): Promise<BullJobStatus>;
  isCompleted(): Promise<boolean>;
  isFailed(): Promise<boolean>;
  isDelayed(): Promise<boolean>;
  isActive(): Promise<boolean>;
  isWaiting(): Promise<boolean>;
  isPaused(): Promise<boolean>;
  isStuck(): Promise<boolean>;
  finished(): Promise<any>;
  toJSON(): Record<string, any>;
}

export type BullQueueProcessorCallback<T = any> = (
  job: BullJobLike<T>,
  done?: DoneCallback,
) => Promise<any> | void;

export type BullQueueSeparateProcessor = string;
