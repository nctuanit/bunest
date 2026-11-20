import "reflect-metadata";

export {
  admitsSeries,
  Counter,
  MAX_SERIES_PER_METRIC,
  stringifyLabel,
} from "./custom-metrics/counter";
export { Gauge } from "./custom-metrics/gauge";
export { Summary } from "./custom-metrics/summary";
export { createInstanceDecorator } from "./instrument/create-instance-decorator.instrument";
export type {
  CreateObserveModuleOptions,
  CustomMetric,
  GaugeKind,
  GraphQLResolveInfoLike,
  JobContext,
  JobSnapshot,
  NodeRuntimeMetrics,
  ObserveModuleAsyncOptions,
  ObserveModuleOptionsWithDefaults,
  ObserveOptions,
  ObserveOptionsFactory,
  RedactionOptions,
  RequestSnapshot,
  SkipSpansContext,
  TraceSpan,
  WsMessageContext,
} from "./interfaces/observe-types";
export {
  CALLER_METADATA_KEY,
  JOB_TRACE_CONTEXT_OPTION_KEY,
  JOB_TRACE_OPTION_KEY,
  OBSERVE_OPTIONS,
  TRACE_CONTEXT_KEY,
  TRACE_REGISTRY_KEY,
} from "./observe.constants";
export {
  Objective,
  OBJECTIVES_METADATA,
  objectiveProblems,
  toDeclaredObjective,
  unknownObjectiveFields,
  type ObjectiveOptions,
} from "./objectives/objective.decorator";
export { createObserveModule } from "./observe.module";
export { TracerService } from "./services/tracer.service";
export { SPAN_COLLAPSED_TAG } from "./services/collapse-repeated-spans.util";
export {
  UNFINISHED_SPANS_TAG,
  UNRECORDED_SPANS_TAG,
} from "./services/operation-trace.registry";
export { TraceSpanDelegate } from "./trace-span.delegate";
export type { KeyOf } from "./types/key-of.type";
export type {
  Path,
  PathImpl,
  PathImpl2,
  PathValue,
} from "./types/path-value.type";
export {
  defaultTraceIdGenerator,
  openTelemetryTraceIdGenerator,
  REQUEST_ID_PATTERN,
} from "./utils/default-trace-id-generator.util";
