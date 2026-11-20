import type {
  BullQueueProcessor,
  BullQueueProcessorCallback,
  BullQueueSeparateProcessor,
} from "../bull.types";
import type {
  BullQueueAdvancedProcessor,
  BullQueueAdvancedSeparateProcessor,
} from "../interfaces/bull.interfaces";

export function isProcessorCallback(
  processor: BullQueueProcessor,
): processor is BullQueueProcessorCallback {
  return typeof processor === "function";
}

export function isSeparateProcessor(
  processor: BullQueueProcessor,
): processor is BullQueueSeparateProcessor {
  return typeof processor === "string";
}

export function isAdvancedProcessor(
  processor: BullQueueProcessor,
): processor is BullQueueAdvancedProcessor {
  return (
    typeof processor === "object" &&
    processor !== null &&
    "callback" in processor &&
    isProcessorCallback(processor.callback)
  );
}

export function isAdvancedSeparateProcessor(
  processor: BullQueueProcessor,
): processor is BullQueueAdvancedSeparateProcessor {
  return (
    typeof processor === "object" &&
    processor !== null &&
    "path" in processor &&
    isSeparateProcessor(processor.path)
  );
}
