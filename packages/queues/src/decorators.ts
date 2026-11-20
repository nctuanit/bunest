import { Inject, Injectable, MetadataRegistry } from "@bunest/common";
import type {
  BullMQQueueEventName,
  BullMQWorkerEventName,
  NestQueueEventOptions,
  NestWorkerOptions,
  ProcessMethodMetadata,
  ProcessorMetadata,
  ProcessorOptions,
  QueueEventMetadata,
  QueueEventsListenerOptions,
  WorkerEventMetadata,
} from "./interfaces";
import {
  QUEUE_EVENTS_LISTENER_METADATA,
  QUEUE_EVENT_METADATA,
  QUEUE_PROCESSOR_METADATA,
  QUEUE_PROCESS_METADATA,
  QUEUE_WORKER_EVENT_METADATA,
  QUEUE_WORKER_METADATA,
  getFlowProducerToken,
  getQueueToken,
} from "./tokens";

/**
 * Injects the `Queue` instance registered for `name` (defaults to `"default"`).
 */
export function InjectQueue(
  name?: string,
): ParameterDecorator & PropertyDecorator {
  return Inject(getQueueToken(name));
}

/**
 * Injects the `FlowProducer` instance registered for `name` (defaults to `"default"`).
 */
export function InjectFlowProducer(
  name?: string,
): ParameterDecorator & PropertyDecorator {
  return Inject(getFlowProducerToken(name));
}

/**
 * Marks a provider class as a queue worker processor bound to a queue.
 * Supports all 4 NestJS `@nestjs/bullmq` overloads plus Bunest concurrency shorthand.
 */
export function Processor(queueName: string): ClassDecorator;
export function Processor(
  queueName: string,
  workerOptions: NestWorkerOptions,
): ClassDecorator;
export function Processor(processorOptions: ProcessorOptions): ClassDecorator;
export function Processor(
  processorOptions: ProcessorOptions,
  workerOptions: NestWorkerOptions,
): ClassDecorator;
export function Processor(
  queueNameOrOptions: string | ProcessorOptions,
  maybeWorkerOptions?: NestWorkerOptions,
): ClassDecorator {
  const normalizedOptions: ProcessorOptions =
    queueNameOrOptions && typeof queueNameOrOptions === "object"
      ? queueNameOrOptions
      : { name: queueNameOrOptions };

  const queueName = normalizedOptions.name ?? "default";
  const concurrency =
    maybeWorkerOptions?.concurrency ?? normalizedOptions.concurrency;

  return (target: Function) => {
    Injectable(
      normalizedOptions.scope !== undefined
        ? { scope: normalizedOptions.scope }
        : undefined,
    )(target);

    const meta: ProcessorMetadata = {
      queueName,
      name: normalizedOptions.name,
      scope: normalizedOptions.scope,
      configKey: normalizedOptions.configKey,
      concurrency,
      workerOptions: maybeWorkerOptions,
    };

    MetadataRegistry.define<ProcessorMetadata>(
      QUEUE_PROCESSOR_METADATA,
      meta,
      target,
    );

    if (maybeWorkerOptions) {
      MetadataRegistry.define<NestWorkerOptions>(
        QUEUE_WORKER_METADATA,
        maybeWorkerOptions,
        target,
      );
    }
  };
}

/**
 * Marks a method on a `@Processor()` class as the handler for a specific `jobName`
 * (or the default catch-all handler when `jobName` is omitted).
 * Inheritance-safe (copy-on-write on target constructor).
 */
export function Process(jobName?: string): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendOwnArray<ProcessMethodMetadata>(
      QUEUE_PROCESS_METADATA,
      [{ methodName: propertyKey, jobName }],
      target.constructor,
    );
  };
}

/**
 * Registers a queue event listener on a `@QueueEventsListener()` or `@Processor()` class.
 * Inheritance-safe (copy-on-write on target constructor).
 */
export function OnQueueEvent(eventName: BullMQQueueEventName): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendOwnArray<QueueEventMetadata>(
      QUEUE_EVENT_METADATA,
      [{ methodName: propertyKey, event: eventName, eventName }],
      target.constructor,
    );
  };
}

/**
 * Registers a worker lifecycle event listener on a `@Processor()` class.
 * Inheritance-safe (copy-on-write on target constructor).
 */
export function OnWorkerEvent(
  eventName: BullMQWorkerEventName,
): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendOwnArray<WorkerEventMetadata>(
      QUEUE_WORKER_EVENT_METADATA,
      [{ methodName: propertyKey, eventName }],
      target.constructor,
    );
  };
}

/**
 * Marks a `QueueEventsHost` subclass as a queue-level event listener for `queueName`.
 */
export function QueueEventsListener(
  queueName: string,
  queueEventsOptions?: NestQueueEventOptions,
): ClassDecorator {
  return (target: Function) => {
    Injectable()(target);
    MetadataRegistry.define<QueueEventsListenerOptions>(
      QUEUE_EVENTS_LISTENER_METADATA,
      { queueName, queueEventsOptions },
      target,
    );
  };
}
