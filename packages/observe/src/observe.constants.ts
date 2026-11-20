export const OBSERVE_OPTIONS = "OBSERVE_OPTIONS";

export const CALLER_METADATA_KEY = "#caller";

/** Where a store keeps the registry key when it differs from the trace id. */
export const TRACE_REGISTRY_KEY = "#registryKey";

/** Where a store keeps the W3C trace context its operation arrived with. */
export const TRACE_CONTEXT_KEY = "#traceContext";

/** The job option the enqueuing side stamps the active trace id into. */
export const JOB_TRACE_OPTION_KEY = "observeTraceId";

/** The job option the enqueuing side stamps a W3C `traceparent` into. */
export const JOB_TRACE_CONTEXT_OPTION_KEY = "observeTraceparent";
