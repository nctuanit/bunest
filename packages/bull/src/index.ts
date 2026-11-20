import "reflect-metadata";

// Constants & Shared Tokens
export {
  BULL_MODULE_ON_QUEUE_EVENT,
  BULL_MODULE_QUEUE,
  BULL_MODULE_QUEUE_PROCESS,
  JOB_REF,
  NO_QUEUE_FOUND,
} from "./bull.constants";

// Module, Explorer, Metadata Accessor & Providers
export { BullMetadataAccessor } from "./bull-metadata.accessor";
export { BullExplorer } from "./bull.explorer";
export { BullModule } from "./bull.module";
export {
  createQueueOptionProviders,
  createQueueProviders,
} from "./bull.providers";

// Errors
export { MissingBullSharedConfigurationError } from "./errors/missing-shared-bull-config.error";

// Types
export type {
  BullQueueEvent,
  BullQueueEventOptions,
  BullQueueProcessor,
  BullQueueProcessorCallback,
  BullQueueSeparateProcessor,
  QueueEventDecoratorOptions,
  RequireOnlyOne,
} from "./bull.types";

// Decorators
export {
  InjectQueue,
  OnGlobalQueueActive,
  OnGlobalQueueCleaned,
  OnGlobalQueueCompleted,
  OnGlobalQueueDrained,
  OnGlobalQueueError,
  OnGlobalQueueFailed,
  OnGlobalQueuePaused,
  OnGlobalQueueProgress,
  OnGlobalQueueRemoved,
  OnGlobalQueueResumed,
  OnGlobalQueueStalled,
  OnGlobalQueueWaiting,
  OnQueueActive,
  OnQueueCleaned,
  OnQueueCompleted,
  OnQueueDrained,
  OnQueueError,
  OnQueueEvent,
  OnQueueFailed,
  OnQueuePaused,
  OnQueueProgress,
  OnQueueRemoved,
  OnQueueResumed,
  OnQueueStalled,
  OnQueueWaiting,
  Process,
  Processor,
  type ProcessOptions,
  type ProcessorOptions,
} from "./decorators/index";

// Enums
export { BullQueueEvents, BullQueueGlobalEvents } from "./enums/index";

// Interfaces
export type {
  BullModuleAsyncOptions,
  BullModuleOptions,
  BullOptionsFactory,
  BullQueueAdvancedProcessor,
  BullQueueAdvancedSeparateProcessor,
  BullRootModuleOptions,
  SharedBullAsyncConfiguration,
  SharedBullConfigurationFactory,
} from "./interfaces/index";

// Utils
export {
  BULL_CONFIG_DEFAULT_TOKEN,
  getQueueOptionsToken,
  getQueueToken,
  getSharedConfigToken,
} from "./utils/index";

// Native Bull v4-compatible Queue & Job classes backed by @bunest/queues
export { BullJob } from "./queue/bull-job";
export { BullQueue } from "./queue/bull-queue";
export type {
  BullAdvancedSettings,
  BullBackoffOptions,
  BullClientType,
  BullJobLike,
  BullJobOptions,
  BullJobStatus,
  BullKeepJobsOptions,
  BullMetricsOptions,
  BullQueueOptions,
  BullRateLimiter,
  BullRedisOptions,
  DoneCallback,
  JobCounts,
  JobStatusClean,
} from "./queue/bull-queue.types";
