import type {
  BullQueueProcessorCallback,
  BullQueueSeparateProcessor,
} from "../queue/bull-queue.types";

/**
 * @publicApi
 */
export interface BullQueueAdvancedProcessor {
  concurrency?: number;
  name?: string;
  callback: BullQueueProcessorCallback;
}

/**
 * @publicApi
 */
export interface BullQueueAdvancedSeparateProcessor {
  concurrency?: number;
  name?: string;
  path: BullQueueSeparateProcessor;
}
