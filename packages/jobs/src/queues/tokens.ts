export const QUEUE_MODULE_OPTIONS = Symbol.for("bunest:queues:module-options");
export const QUEUE_DRIVER = Symbol.for("bunest:queues:driver");
export const QUEUE_REGISTRY = Symbol.for("bunest:queues:registry");

export const QUEUE_PROCESSOR_METADATA = Symbol.for("bunest:queues:processor");
export const QUEUE_PROCESS_METADATA = Symbol.for("bunest:queues:process");
export const QUEUE_EVENT_METADATA = Symbol.for("bunest:queues:event");
export const QUEUE_WORKER_METADATA = Symbol.for("bunest:queues:worker");
export const QUEUE_WORKER_EVENT_METADATA = Symbol.for(
  "bunest:queues:worker-event",
);
export const QUEUE_EVENTS_LISTENER_METADATA = Symbol.for(
  "bunest:queues:events-listener",
);

export const BULLMQ_MODULE_OPTIONS = Symbol.for("bunest:queues:bullmq-options");
export const BULLMQ_DRIVER = Symbol.for("bunest:queues:bullmq-driver");

export const BULL_EXTRA_OPTIONS_TOKEN = "BULLMQ_EXTRA_OPTIONS";
export const BULL_CONFIG_DEFAULT_TOKEN = "BULLMQ_CONFIG(default)";
export const JOB_REF = "REQUEST";

export function getQueueToken(name?: string): string {
  return `bunest:queues:queue:${name ?? "default"}`;
}

export function getQueueOptionsToken(name?: string): string {
  return name ? `BullMQQueueOptions_${name}` : "BullMQQueueOptions_default";
}

export function getFlowProducerToken(name?: string): string {
  return name ? `BullFlowProducer_${name}` : "BullFlowProducer_default";
}

export function getFlowProducerOptionsToken(name?: string): string {
  return name
    ? `BullMQFlowProducerOptions_${name}`
    : "BullMQFlowProducerOptions_default";
}

export function getSharedConfigToken(configKey?: string): string {
  return configKey ? `BULLMQ_CONFIG(${configKey})` : BULL_CONFIG_DEFAULT_TOKEN;
}
