export const BULL_MODULE_QUEUE = "bull:module_queue";
export const BULL_MODULE_QUEUE_PROCESS = "bull:module_queue_process";
export const BULL_MODULE_ON_QUEUE_EVENT = "bull:module_on_queue_event";

export const JOB_REF = "REQUEST";

export const NO_QUEUE_FOUND = (name?: string): string =>
  name
    ? `No Queue was found with the given name (${name}). Check your configuration.`
    : "No Queue was found. Check your configuration.";
