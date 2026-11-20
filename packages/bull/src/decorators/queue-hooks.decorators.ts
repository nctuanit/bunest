import { SetMetadata } from "@bunest/common";
import { BULL_MODULE_ON_QUEUE_EVENT } from "../bull.constants";
import type {
  BullQueueEvent,
  BullQueueEventOptions,
  QueueEventDecoratorOptions,
} from "../bull.types";
import { BullQueueEvents } from "../enums/bull-queue-events.enum";
import { BullQueueGlobalEvents } from "../enums/bull-queue-global-events.enum";

/**
 * @publicApi
 */
export const OnQueueEvent = (
  eventNameOrOptions: BullQueueEvent | BullQueueEventOptions,
): MethodDecorator =>
  SetMetadata(
    BULL_MODULE_ON_QUEUE_EVENT,
    typeof eventNameOrOptions === "string"
      ? { eventName: eventNameOrOptions }
      : eventNameOrOptions,
  );

/**
 * @publicApi
 */
export const OnQueueError = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueEvents.ERROR,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnQueueWaiting = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueEvents.WAITING,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnQueueActive = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueEvents.ACTIVE,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnQueueStalled = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueEvents.STALLED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnQueueProgress = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueEvents.PROGRESS,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnQueueCompleted = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueEvents.COMPLETED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnQueueFailed = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueEvents.FAILED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnQueuePaused = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueEvents.PAUSED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnQueueResumed = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueEvents.RESUMED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnQueueCleaned = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueEvents.CLEANED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnQueueDrained = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueEvents.DRAINED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnQueueRemoved = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueEvents.REMOVED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnGlobalQueueError = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueGlobalEvents.ERROR,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnGlobalQueueWaiting = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueGlobalEvents.WAITING,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnGlobalQueueActive = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueGlobalEvents.ACTIVE,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnGlobalQueueStalled = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueGlobalEvents.STALLED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnGlobalQueueProgress = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueGlobalEvents.PROGRESS,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnGlobalQueueCompleted = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueGlobalEvents.COMPLETED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnGlobalQueueFailed = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueGlobalEvents.FAILED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnGlobalQueuePaused = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueGlobalEvents.PAUSED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnGlobalQueueResumed = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueGlobalEvents.RESUMED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnGlobalQueueCleaned = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueGlobalEvents.CLEANED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnGlobalQueueDrained = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueGlobalEvents.DRAINED,
  } as BullQueueEventOptions);

/**
 * @publicApi
 */
export const OnGlobalQueueRemoved = (
  options?: QueueEventDecoratorOptions,
): MethodDecorator =>
  OnQueueEvent({
    ...options,
    eventName: BullQueueGlobalEvents.REMOVED,
  } as BullQueueEventOptions);
