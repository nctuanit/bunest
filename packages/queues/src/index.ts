import "reflect-metadata";

export {
  BULLMQ_DRIVER,
  BULLMQ_MODULE_OPTIONS,
  BULL_CONFIG_DEFAULT_TOKEN,
  BULL_EXTRA_OPTIONS_TOKEN,
  JOB_REF,
  QUEUE_DRIVER,
  QUEUE_EVENTS_LISTENER_METADATA,
  QUEUE_EVENT_METADATA,
  QUEUE_MODULE_OPTIONS,
  QUEUE_PROCESSOR_METADATA,
  QUEUE_PROCESS_METADATA,
  QUEUE_REGISTRY,
  QUEUE_WORKER_EVENT_METADATA,
  QUEUE_WORKER_METADATA,
  getFlowProducerOptionsToken,
  getFlowProducerToken,
  getQueueOptionsToken,
  getQueueToken,
  getSharedConfigToken,
} from "./tokens";

export type {
  BackoffOptions,
  BullMQBackendFactory,
  BullMQJobLike,
  BullMQModuleOptions,
  BullMQProcessorFn,
  BullMQQueueBaseOptions,
  BullMQQueueEventName,
  BullMQQueueFactory,
  BullMQQueueFactoryContext,
  BullMQQueueLike,
  BullMQQueueOptionsBase,
  BullMQRegisterQueueOptions,
  BullMQStreamsOptions,
  BullMQWorkerEventName,
  BullMQWorkerFactory,
  BullMQWorkerFactoryContext,
  BullMQWorkerLike,
  BullMQWorkerOptionsBase,
  BullModuleExtraOptions,
  BullQueueAdvancedProcessor,
  BullQueueAdvancedSeparateProcessor,
  BullQueueKeepJobs,
  BullQueueProcessor,
  BullQueueProcessorCallback,
  BullQueueSeparateProcessor,
  BullRootModuleOptions,
  BulkJobInput,
  DefaultJobOptions,
  FlowJob,
  FlowJobNode,
  FlowNodeOpts,
  FlowOpts,
  Job,
  JobHandler,
  JobOptions,
  JobStatus,
  NestQueueEventOptions,
  NestQueueOptions,
  NestWorkerOptions,
  OnQueueEventMetadata,
  OnWorkerEventMetadata,
  ProcessMethodMetadata,
  ProcessorMetadata,
  ProcessorOptions,
  QueueConfig,
  QueueConfigFactory,
  QueueCounts,
  QueueDriver,
  QueueEventListener,
  QueueEventMetadata,
  QueueEventName,
  QueueEventsLike,
  QueueEventsListenerOptions,
  QueueModuleAsyncOptions,
  QueueModuleOptions,
  QueueModuleOptionsFactory,
  ReclaimStalledResult,
  RegisterFlowProducerAsyncOptions,
  RegisterFlowProducerOptions,
  RegisterFlowProducerOptionsFactory,
  RegisterQueueAsyncOptions,
  RegisterQueueConfigAsyncOptions,
  RegisterQueueOptions,
  RegisterQueueOptionsFactory,
  SharedBullAsyncConfiguration,
  SharedBullConfigurationFactory,
  WorkerEventMetadata,
} from "./interfaces";

export { calculateBackoffDelay } from "./backoff";

export { MemoryQueueDriver } from "./drivers/memory.driver";
export {
  LUA_ACK_JOB,
  LUA_DEQUEUE_JOB,
  LUA_ENQUEUE_JOB,
  LUA_NACK_OR_DLQ_JOB,
  LUA_RECLAIM_STALLED,
  LUA_RENEW_LEASE,
} from "./drivers/redis-lua.scripts";
export {
  RedisQueueDriver,
  type RedisQueueClientLike,
  type RedisQueueDriverOptions,
} from "./drivers/redis.driver";

export {
  QueueEvents,
  QueueEventsHost,
} from "./hosts/queue-events-host.class";
export { WorkerHost } from "./hosts/worker-host.class";
export { ProcessorDecoratorService } from "./instrument/processor-decorator.service";
export {
  FlowProducer,
  type FlowProducerQueueResolver,
} from "./flow-producer";

export {
  BullMQExplorer,
  BullMQModule,
  BullMQQueueDriver,
  BullModule,
  BullRegistrar,
} from "./adapters/bullmq.adapter";

export {
  InjectFlowProducer,
  InjectQueue,
  OnQueueEvent,
  OnWorkerEvent,
  Process,
  Processor,
  QueueEventsListener,
} from "./decorators";

export { JobTimeoutError, Queue } from "./queue";

export {
  QueueExplorer,
  QueueModule,
  QueueRegistry,
} from "./queue.module";
