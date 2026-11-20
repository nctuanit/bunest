import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable, Logger } from "@bunest/common";
import type { ObserveAgentSharedBuffer } from "../agent/observe-agent.buffer";
import { Counter } from "../custom-metrics/counter";
import { Gauge } from "../custom-metrics/gauge";
import { Summary } from "../custom-metrics/summary";
import type {
  GaugeKind,
  ObserveModuleOptionsWithDefaults,
} from "../interfaces/observe-types";
import { CALLER_METADATA_KEY, TRACE_REGISTRY_KEY } from "../observe.constants";
import { TraceSpanDelegate } from "../trace-span.delegate";
import type { Path, PathValue } from "../types/path-value.type";
import { uuidv7 } from "../utils/uuid-v7.util";
import type { OperationTraceRegistry } from "./operation-trace.registry";

const MAX_METRICS = 500;
const MAX_OPERATION_ID_LENGTH = 255;

@Injectable()
export class TracerService<
  Store extends object = Record<string | symbol, unknown>,
  TraceKey extends string = "traceId",
> {
  private readonly operationTraceRegistry: OperationTraceRegistry;
  private readonly als: AsyncLocalStorage<
    Map<string | symbol | TraceKey, any>
  >;
  private readonly observeAgentSharedBuffer: ObserveAgentSharedBuffer;
  private readonly options: ObserveModuleOptionsWithDefaults;
  private readonly counters = new Map<string, Counter<any>>();
  private readonly gauges = new Map<string, Gauge<any>>();
  private readonly summaries = new Map<string, Summary<any>>();
  private readonly logger = new Logger(TracerService.name);
  private hasReportedUnusableOperationId = false;
  private hasReportedMetricLimit = false;
  private hasReportedErrorOutsideContext = false;

  constructor(
    operationTraceRegistry: OperationTraceRegistry,
    als: AsyncLocalStorage<Map<string | symbol | TraceKey, any>>,
    observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    options: ObserveModuleOptionsWithDefaults,
  ) {
    this.operationTraceRegistry = operationTraceRegistry;
    this.als = als;
    this.observeAgentSharedBuffer = observeAgentSharedBuffer;
    this.options = options;
  }

  async createSpan(
    name: string,
    callback: (span: TraceSpanDelegate) => unknown | Promise<unknown>,
  ): Promise<any> {
    const store = this.als.getStore();
    if (!store) {
      return await callback(new TraceSpanDelegate(uuidv7(), name, {}));
    }
    const registryKey = this.resolveRegistryKey(store);
    if (!registryKey) {
      return await callback(new TraceSpanDelegate(uuidv7(), name, {}));
    }
    const callerId = store.get(CALLER_METADATA_KEY) as string | undefined;
    return await this.operationTraceRegistry.createManualSpan(
      registryKey,
      callerId,
      name,
      callback,
    );
  }

  async activeSpan(): Promise<TraceSpanDelegate> {
    const store = this.als.getStore();
    if (!store) {
      return new TraceSpanDelegate(uuidv7(), undefined, {});
    }
    const registryKey = this.resolveRegistryKey(store);
    const callerId = store.get(CALLER_METADATA_KEY) as string | undefined;
    if (!registryKey || !callerId) {
      return new TraceSpanDelegate(uuidv7(), undefined, {});
    }
    const active = this.operationTraceRegistry.getActiveSpan(
      registryKey,
      callerId,
    );
    if (!active) {
      return new TraceSpanDelegate(uuidv7(), undefined, {});
    }
    active.tags ??= {};
    return new TraceSpanDelegate(
      active.spanId ?? callerId,
      active.name ?? `${active.className}.${active.methodKey}`,
      active.tags,
    );
  }

  async captureError(
    error: Error,
    tags: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    const store = this.als.getStore();
    if (!store) {
      if (!this.hasReportedErrorOutsideContext) {
        this.hasReportedErrorOutsideContext = true;
        this.logger.warn(
          "TracerService.captureError() called outside an active trace context.",
        );
      }
      return;
    }
    const registryKey = this.resolveRegistryKey(store);
    if (!registryKey) return;
    const callerId = store.get(CALLER_METADATA_KEY) as string | undefined;
    this.operationTraceRegistry.captureError(registryKey, callerId, error, tags);
  }

  counter<TLabel extends string = "default">(name: string): Counter<TLabel>;
  counter<TLabel extends string = "default">(
    name: string,
    attributes: {
      description?: string;
      initialValue?: number;
      labels?: TLabel[];
    },
  ): Counter<TLabel>;
  counter<TLabel extends string = "default">(
    name: string,
    attributes?: {
      description?: string;
      initialValue?: number;
      labels?: TLabel[];
    },
  ): Counter<TLabel> {
    const existing = this.counters.get(name);
    if (existing) {
      return existing as Counter<TLabel>;
    }
    const instance = new Counter<TLabel>(
      name,
      attributes?.description,
      attributes?.initialValue,
      attributes?.labels,
    );
    if (this.admitsMetric()) {
      this.counters.set(name, instance);
      this.observeAgentSharedBuffer.registerMetric(instance);
    }
    return instance;
  }

  gauge<TLabel extends string = "default">(name: string): Gauge<TLabel>;
  gauge<TLabel extends string = "default">(
    name: string,
    attributes: {
      description?: string;
      initialValue?: number;
      labels?: TLabel[];
      kind?: GaugeKind;
    },
  ): Gauge<TLabel>;
  gauge<TLabel extends string = "default">(
    name: string,
    attributes?: {
      description?: string;
      initialValue?: number;
      labels?: TLabel[];
      kind?: GaugeKind;
    },
  ): Gauge<TLabel> {
    const existing = this.gauges.get(name);
    if (existing) {
      return existing as Gauge<TLabel>;
    }
    const instance = attributes
      ? new Gauge<TLabel>(name, attributes)
      : new Gauge<TLabel>(name);
    if (this.admitsMetric()) {
      this.gauges.set(name, instance);
      this.observeAgentSharedBuffer.registerMetric(instance);
    }
    return instance;
  }

  summary<TLabel extends string = "default">(name: string): Summary<TLabel>;
  summary<TLabel extends string = "default">(
    name: string,
    attributes: {
      description?: string;
      labels?: TLabel[];
      sampleSize?: number;
    },
  ): Summary<TLabel>;
  summary<TLabel extends string = "default">(
    name: string,
    attributes?: {
      description?: string;
      labels?: TLabel[];
      sampleSize?: number;
    },
  ): Summary<TLabel> {
    const existing = this.summaries.get(name);
    if (existing) {
      return existing as Summary<TLabel>;
    }
    const instance = attributes
      ? new Summary<TLabel>(name, attributes)
      : new Summary<TLabel>(name);
    if (this.admitsMetric()) {
      this.summaries.set(name, instance);
      this.observeAgentSharedBuffer.registerMetric(instance);
    }
    return instance;
  }

  currentTraceId(): string | null {
    const store = this.als.getStore();
    if (!store) return null;
    const id = store.get(this.options.traceIdKey);
    return typeof id === "string" ? id : null;
  }

  setOperationId(operationId: string): void {
    if (typeof operationId !== "string" || operationId.trim().length === 0) {
      if (!this.hasReportedUnusableOperationId) {
        this.hasReportedUnusableOperationId = true;
        this.logger.warn(
          "TracerService.setOperationId() requires a non-blank string.",
        );
      }
      return;
    }
    const store = this.als.getStore();
    if (!store) return;
    const registryKey = this.resolveRegistryKey(store);
    if (!registryKey) return;
    const cleaned = operationId.trim().slice(0, MAX_OPERATION_ID_LENGTH);
    this.operationTraceRegistry.setOperationId(registryKey, cleaned);
  }

  setAttribute<P extends Path<Store>>(key: P, value: PathValue<Store, P>): void {
    const store = this.als.getStore();
    if (!store) return;
    if (key === this.options.traceIdKey) return;
    store.set(key as string, value);
  }

  getAttribute<P extends Path<Store>>(key: P): PathValue<Store, P> | undefined {
    const store = this.als.getStore();
    if (!store) return undefined;
    return store.get(key as string) as PathValue<Store, P> | undefined;
  }

  private resolveRegistryKey(
    store: Map<string | symbol | TraceKey, any>,
  ): string | undefined {
    const key =
      (store.get(TRACE_REGISTRY_KEY) as string | undefined) ??
      (store.get(this.options.traceIdKey) as string | undefined);
    return typeof key === "string" ? key : undefined;
  }

  private admitsMetric(): boolean {
    const total = this.counters.size + this.gauges.size + this.summaries.size;
    if (total >= MAX_METRICS) {
      if (!this.hasReportedMetricLimit) {
        this.hasReportedMetricLimit = true;
        this.logger.warn(
          `Observe reached max metric limit (${MAX_METRICS}); additional metrics will not be reported.`,
        );
      }
      return false;
    }
    return true;
  }
}
