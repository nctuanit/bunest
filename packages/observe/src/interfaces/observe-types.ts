import type {
  FactoryProvider,
  ModuleMetadata,
  Provider,
  Type,
} from "@bunest/common";

export type GaugeKind = "additive" | "ratio" | "peak";

export interface CustomMetric<TLabel extends string = "default"> {
  name: string;
  value: Record<string, number>;
  description?: string;
  type: "counter" | "gauge" | "summary";
  labels?: TLabel[];
  kind?: GaugeKind;
  tags?: Record<string, string>;
  lastUpdated?: number;
  increase?: Record<string, number>;
  p50?: Record<string, number>;
  p95?: Record<string, number>;
  p99?: Record<string, number>;
  observations?: Record<string, number>;
  total?: Record<string, number>;
  maximum?: Record<string, number>;
}

export interface GraphQLResolveInfoLike {
  fieldName: string;
  parentType: {
    name: string;
  };
  operation?: {
    operation?: string;
    name?: {
      value?: string;
    };
  };
}

export interface TraceSpan {
  spanId?: string;
  name?: string;
  origin: "manual" | "auto";
  tags?: Record<string, string | number | boolean>;
  error?:
    | boolean
    | {
        cls?: string;
        message: string;
        stack?: string;
        tags?: Record<string, string | number | boolean>;
      };
}

export interface OngoingTraceEventNode extends TraceSpan {
  type: "start" | "end";
  className: string;
  methodKey: string;
  startTime: number;
  startOffset?: number;
  children: Array<CompleteTraceEventNode | OngoingTraceEventNode>;
  parent?: OngoingTraceEventNode;
}

export interface CompleteTraceEventNode extends TraceSpan {
  className: string;
  methodKey: string;
  duration: number;
  startOffset?: number;
  children: Array<CompleteTraceEventNode>;
}

export interface CapturedRequest {
  headers?: Record<string, string>;
  body?: string;
  truncated?: boolean;
}

export interface HttpCaptureOptions {
  headers?: string[] | false;
  body?: boolean | { maxBytes?: number };
  slowerThanMs?: number;
}

export interface OutgoingHttpOptions {
  ignore?: Array<string | RegExp> | ((url: string) => boolean);
  traceContext?: boolean;
  queryParamsObfuscateRegex?: RegExp;
}

export interface OutgoingLlmOptions {
  enabled?: boolean;
  providers?: string[];
}

export interface OtlpExportOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  protocol?: "http/protobuf" | "http/json";
  compression?: "gzip" | "none";
  timeoutMillis?: number;
  serviceName?: string;
  resourceAttributes?: Record<string, string | number | boolean>;
}

export interface RequestSnapshot {
  calledAt?: string;
  traceId: string;
  startTimestamp?: number;
  duration?: number;
  protocol: string;
  operationId?: string;
  traces: Array<OngoingTraceEventNode | CompleteTraceEventNode>;
  tags?: Record<string, string | number | boolean>;
  error?: {
    cls?: string;
    message: string;
    stack?: string;
    tags?: Record<string, string | number | boolean>;
  };
  request?: CapturedRequest;
  userId?: string;
  attributes?: {
    method?: string;
    statusCode?: number;
    originalUrl?: string;
    defaultOperationId?: string;
  };
}

export interface JobSnapshot {
  id: string;
  traceId: string;
  name: string;
  queueName: string;
  status?: "completed" | "failed";
  calledAt?: string;
  startTimestamp?: number;
  duration?: number;
  enqueuedAt?: string;
  waitDuration?: number;
  attemptsMade?: number;
  maxAttempts?: number;
  traces: Array<OngoingTraceEventNode | CompleteTraceEventNode>;
  tags?: Record<string, string | number | boolean>;
  error?: {
    cls?: string;
    message: string;
    stack?: string;
    tags?: Record<string, string | number | boolean>;
  };
}

export interface NodeRuntimeMetrics {
  cpu: {
    user: number;
    system: number;
    percentageUsed: number;
  };
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers?: number;
    percentageUsed: number;
  };
  gc: {
    count: number;
    totalDuration: number;
    breakdown?: {
      minor?: {
        count: number;
        duration: number;
      };
      major?: {
        count: number;
        duration: number;
      };
      incremental?: {
        count: number;
        duration: number;
      };
    };
  };
  eventLoop: {
    lag: number;
    utilization: number;
  };
}

export interface RedactionOptions {
  enabled?: boolean;
  patterns?: RegExp[];
  keys?: string[];
  replacement?: string;
  useDefaultPatterns?: boolean;
}

export interface JobContext {
  queueName: string;
  name: string;
  id: string | undefined;
}

export interface SkipSpansContext {
  protocol: string;
  operationId: string | undefined;
  method: string | undefined;
  statusCode: number | undefined;
  duration: number;
  errorClass: string | undefined;
}

export interface WsMessageContext {
  gateway: string;
  pattern: string;
  client: any;
  data: unknown;
}

export interface CreateObserveModuleOptions {
  traceIdKey?: string;
  traceIdGenerator?: (req: unknown) => string;
  attachTraceIdToLogs?: boolean;
  skipInstrumentation?: (instance: unknown) => boolean;
  sourceContext?:
    | boolean
    | {
        linesOfContext?: number;
        maxFrames?: number;
        sourceMaps?: boolean;
      };
}

export interface ObserveOptions {
  enabled?: boolean;
  appKey?: string;
  appSecret?: string;
  endpoint?: string;
  otlp?: boolean | OtlpExportOptions;
  serviceId: string;
  serviceVersion?: string | false;
  flushInterval?: number;
  shutdownFlushTimeout?: number;
  runtimeMetrics?: boolean;
  runtimeMetricsInterval?: number;
  tracesSampleRate?:
    | number
    | ((
        protocol: "http" | "rpc" | "grpc" | "graphql" | "ws",
        attributes: any,
      ) => boolean);
  maxTracesPerBatch?: number;
  spanCollapse?:
    | false
    | {
        threshold?: number;
        keepSlowest?: number;
      };
  skipSpans?: number[] | ((operation: SkipSpansContext) => boolean);
  forwardLogs?: boolean;
  redaction?: RedactionOptions;
  debug?: boolean;
  http?: {
    ignore?:
      | Array<
          | string
          | {
              method: string;
              path: string | RegExp;
            }
          | RegExp
        >
      | ((req: any) => boolean);
    tracePreflights?: boolean;
    tags?: Record<string, string>;
    setAttributes?: (req: any) => {
      [key: string]: string | number | boolean;
    };
    queryParamsObfuscateRegex?: RegExp;
    capture?: HttpCaptureOptions | false;
    getUserId?: (req: any) => string;
  };
  rpc?: {
    ignore?: (transportId: number | string | symbol, ctx: any) => boolean;
    tags?: Record<string, string>;
    setAttributes?: (
      transportId: number | string | symbol,
      ctx: any,
    ) => {
      [key: string]: string | number | boolean;
    };
    getUserId?: (transportId: number | string | symbol, ctx: any) => string;
  };
  graphql?: {
    ignore?: (info: GraphQLResolveInfoLike) => boolean;
    tags?: Record<string, string>;
    setAttributes?: (
      info: GraphQLResolveInfoLike,
      context: any,
    ) => {
      [key: string]: string | number | boolean;
    };
    getUserId?: (context: any) => string;
  };
  grpc?: {
    ignore?: (call: any) => boolean;
    tags?: Record<string, string>;
    setAttributes?: (call: any) => {
      [key: string]: string | number | boolean;
    };
    getUserId?: (call: any) => string;
  };
  openTelemetry?: boolean;
  outgoing?:
    | false
    | {
        database?: boolean;
        http?: boolean | OutgoingHttpOptions;
        llm?: boolean | OutgoingLlmOptions;
      };
  ws?: {
    ignore?: (message: WsMessageContext) => boolean;
    tags?: Record<string, string | number | boolean>;
    setAttributes?: (message: WsMessageContext) => {
      [key: string]: string | number | boolean;
    };
    getUserId?: (message: WsMessageContext) => string | undefined;
  };
  jobs?: {
    ignore?: (job: JobContext) => boolean;
    tags?: Record<string, string>;
    setAttributes?: (job: JobContext) => {
      [key: string]: string | number | boolean;
    };
  };
}

export type ObserveModuleOptionsWithDefaults =
  Required<CreateObserveModuleOptions> & ObserveOptions;

export interface ObserveOptionsFactory {
  createObserveOptions(): Promise<ObserveOptions> | ObserveOptions;
}

export interface ObserveModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  useExisting?: Type<ObserveOptionsFactory>;
  useClass?: Type<ObserveOptionsFactory>;
  useFactory?: (...args: any[]) => Promise<ObserveOptions> | ObserveOptions;
  inject?: FactoryProvider["inject"];
  extraProviders?: Provider[];
  global?: boolean;
}
