import { AsyncLocalStorage } from "node:async_hooks";
import {
  HttpException,
  IntrinsicException,
  Logger,
  RequestMethod,
} from "@bunest/common";
import type {
  CompleteTraceEventNode,
  CreateObserveModuleOptions,
  JobSnapshot,
  OngoingTraceEventNode,
  RequestSnapshot,
} from "../interfaces/observe-types";
import { CALLER_METADATA_KEY } from "../observe.constants";
import { TraceSpanDelegate } from "../trace-span.delegate";
import type { KeyOf } from "../types/key-of.type";
import { LogRedactor } from "../utils/log-redactor";
import type { TraceContext } from "../utils/trace-context.util";
import { uuidv7 } from "../utils/uuid-v7.util";
import {
  collapseRepeatedSpans,
  DEFAULT_SPAN_COLLAPSE,
  type SpanCollapseSettings,
} from "./collapse-repeated-spans.util";
import type { SkipSpansPredicate } from "./skip-spans.util";

export const UNFINISHED_SPANS_TAG = "observe.unfinishedSpans";
export const UNRECORDED_SPANS_TAG = "observe.unrecordedSpans";

const MAX_SPANS_PER_TRACE = 2_000;
const MAX_SPAN_DEPTH = 64;
const MAX_CAPTURED_ERRORS_PER_TRACE = 20;

type TraceId = string;

interface TraceEntry {
  snapshot: RequestSnapshot | JobSnapshot;
  openNodes: Map<string, OngoingTraceEventNode>;
  totalSpans: number;
  unrecordedSpans: number;
  capturedErrors: number;
  keepEmpty: boolean;
}

function isRequestSnapshot(
  snapshot: RequestSnapshot | JobSnapshot,
): snapshot is RequestSnapshot {
  return "protocol" in snapshot;
}

export class OperationTraceRegistry {
  private readonly als: AsyncLocalStorage<
    Map<KeyOf<{ [CALLER_METADATA_KEY]: string }>, unknown>
  >;
  private readonly sourceContext: CreateObserveModuleOptions["sourceContext"];
  private readonly traces = new Map<TraceId, TraceEntry>();
  private readonly logger = new Logger(OperationTraceRegistry.name);
  private spanCollapse: SpanCollapseSettings | undefined = DEFAULT_SPAN_COLLAPSE;
  private skipSpans: SkipSpansPredicate | undefined;
  private redactor: LogRedactor | null = new LogRedactor();
  private readonly traceContexts = new WeakMap<object, TraceContext>();

  constructor(
    als: AsyncLocalStorage<
      Map<KeyOf<{ [CALLER_METADATA_KEY]: string }>, unknown>
    >,
    sourceContext?: CreateObserveModuleOptions["sourceContext"],
  ) {
    this.als = als;
    this.sourceContext = sourceContext;
  }

  configureSpanCollapse(settings: SpanCollapseSettings | undefined): void {
    this.spanCollapse = settings;
  }

  configureSkipSpans(predicate: SkipSpansPredicate | undefined): void {
    this.skipSpans = predicate;
  }

  configureRedaction(redactor: LogRedactor | null): void {
    this.redactor = redactor;
  }

  getRedactor(): LogRedactor | null {
    return this.redactor;
  }

  hasTrace(traceId: TraceId): boolean {
    return this.traces.has(traceId);
  }

  hasOpenSpans(traceId: TraceId): boolean {
    const entry = this.traces.get(traceId);
    if (!entry) return false;
    for (const node of entry.openNodes.values()) {
      if (node.type === "start") return true;
    }
    return false;
  }

  hasOperationId(traceId: TraceId): boolean {
    const entry = this.traces.get(traceId);
    if (!entry || !isRequestSnapshot(entry.snapshot)) return false;
    return Boolean(entry.snapshot.operationId);
  }

  startTrace(
    traceId: TraceId,
    data:
      | Omit<RequestSnapshot, "traces" | "startTimestamp" | "calledAt" | "traceId">
      | Omit<JobSnapshot, "duration">,
    reportedTraceId?: string,
    traceContext?: TraceContext,
  ): void {
    const now = performance.now();
    const snapshot: RequestSnapshot | JobSnapshot =
      "protocol" in data
        ? {
            ...data,
            traceId: reportedTraceId ?? traceId,
            calledAt: new Date().toISOString(),
            startTimestamp: now,
            traces: [],
          }
        : {
            ...data,
            traceId: reportedTraceId ?? data.traceId ?? traceId,
            calledAt: data.calledAt ?? new Date().toISOString(),
            startTimestamp: data.startTimestamp ?? now,
            traces: data.traces ?? [],
          };

    if (traceContext) {
      this.traceContexts.set(snapshot, traceContext);
    }

    this.traces.set(traceId, {
      snapshot,
      openNodes: new Map(),
      totalSpans: 0,
      unrecordedSpans: 0,
      capturedErrors: 0,
      keepEmpty: false,
    });
  }

  traceContextOf(snapshot: object): TraceContext | undefined {
    return this.traceContexts.get(snapshot);
  }

  endTrace(
    traceId: string,
    opts?: {
      statusCode?: number;
      userId?: string;
      status?: JobSnapshot["status"];
    },
  ): void {
    const entry = this.traces.get(traceId);
    if (!entry) return;
    const snap = entry.snapshot;
    if (snap.startTimestamp !== undefined) {
      snap.duration = Math.max(0, performance.now() - snap.startTimestamp);
    }
    if (isRequestSnapshot(snap)) {
      if (opts?.statusCode !== undefined) {
        snap.attributes = { ...snap.attributes, statusCode: opts.statusCode };
      }
      if (opts?.userId !== undefined) {
        snap.userId = opts.userId;
      }
    } else if (opts?.status !== undefined) {
      snap.status = opts.status;
    }
  }

  internalStartTraceStep(
    traceId: TraceId,
    className: string,
    methodKey: string,
    callerId: string | undefined,
    explicitSpanId?: string,
  ): string | undefined {
    const entry = this.traces.get(traceId);
    if (!entry) return undefined;
    if (entry.totalSpans >= MAX_SPANS_PER_TRACE) {
      entry.unrecordedSpans++;
      return undefined;
    }
    entry.totalSpans++;

    const spanId = explicitSpanId ?? uuidv7();
    const startTime = performance.now();
    const startOffset =
      entry.snapshot.startTimestamp !== undefined
        ? Math.max(0, startTime - entry.snapshot.startTimestamp)
        : undefined;

    const node: OngoingTraceEventNode = {
      type: "start",
      origin: "auto",
      spanId,
      className,
      methodKey,
      startTime,
      ...(startOffset !== undefined ? { startOffset } : {}),
      children: [],
    };

    this.attachToCaller(entry, node, callerId);
    entry.openNodes.set(spanId, node);
    return spanId;
  }

  internalEndTraceStep(
    traceId: TraceId,
    spanId: string | undefined,
    _className: string,
    _methodKey: string,
    _callerId: string | undefined,
    error?: Error | string | object,
    _outgoing?: boolean,
  ): void {
    if (!spanId) return;
    const entry = this.traces.get(traceId);
    if (!entry) return;
    const node = entry.openNodes.get(spanId);
    if (!node || node.type === "end") return;

    node.type = "end";
    const duration = Math.max(0, performance.now() - node.startTime);
    (node as unknown as { duration: number }).duration = duration;

    if (error !== undefined) {
      if (entry.capturedErrors < MAX_CAPTURED_ERRORS_PER_TRACE) {
        entry.capturedErrors++;
        const payload = this.toErrorPayload(error);
        node.error = payload;
        if (!entry.snapshot.error) {
          entry.snapshot.error = payload;
        }
        if (isRequestSnapshot(entry.snapshot) && !entry.snapshot.attributes?.statusCode) {
          entry.snapshot.attributes = {
            ...entry.snapshot.attributes,
            statusCode: this.toErrorStatusCode(error),
          };
        }
      } else {
        node.error = true;
      }
    }
  }

  addRouteMetadataToTrace(
    requestId: string,
    requestMethod: RequestMethod,
    path: string,
  ): void {
    const entry = this.traces.get(requestId);
    if (!entry || !isRequestSnapshot(entry.snapshot)) return;
    const methodName = RequestMethod[requestMethod] ?? String(requestMethod);
    entry.snapshot.attributes = {
      ...entry.snapshot.attributes,
      method: methodName,
    };
    if (!entry.snapshot.operationId) {
      entry.snapshot.operationId = path;
    }
  }

  setOperationId(traceId: TraceId, operationId: string): void {
    const entry = this.traces.get(traceId);
    if (!entry || !isRequestSnapshot(entry.snapshot)) return;
    if (entry.snapshot.operationId === operationId) return;
    if (
      entry.snapshot.operationId &&
      !entry.snapshot.attributes?.defaultOperationId
    ) {
      entry.snapshot.attributes = {
        ...entry.snapshot.attributes,
        defaultOperationId: entry.snapshot.operationId,
      };
    }
    entry.snapshot.operationId = operationId;
  }

  addGraphQLMetadataToTrace(
    traceId: TraceId,
    metadata: {
      operationId: string;
      tags?: Record<string, string | number | boolean>;
      attributes?: RequestSnapshot["attributes"];
    },
  ): void {
    const entry = this.traces.get(traceId);
    if (!entry || !isRequestSnapshot(entry.snapshot)) return;
    if (!entry.snapshot.operationId) {
      entry.snapshot.operationId = metadata.operationId;
    }
    if (metadata.tags) {
      entry.snapshot.tags = { ...entry.snapshot.tags, ...metadata.tags };
    }
    if (metadata.attributes) {
      entry.snapshot.attributes = {
        ...entry.snapshot.attributes,
        ...metadata.attributes,
      };
    }
  }

  captureError(
    traceId: string,
    callerId: string | undefined,
    error: Error | string,
    tags: Record<string, string | number | boolean>,
  ): void {
    const entry = this.traces.get(traceId);
    if (!entry) return;
    const node = callerId ? entry.openNodes.get(callerId) : undefined;
    if (entry.capturedErrors < MAX_CAPTURED_ERRORS_PER_TRACE) {
      entry.capturedErrors++;
      const payload = this.toErrorPayload(error, tags);
      if (node) {
        node.error = payload;
        if (Object.keys(tags).length > 0) {
          node.tags = { ...node.tags, ...tags };
        }
      }
      if (!entry.snapshot.error) {
        entry.snapshot.error = payload;
      }
    } else if (node) {
      node.error = true;
      if (Object.keys(tags).length > 0) {
        node.tags = { ...node.tags, ...tags };
      }
    }
  }

  keepWithoutSpans(traceId: TraceId): void {
    const entry = this.traces.get(traceId);
    if (entry) {
      entry.keepEmpty = true;
    }
  }

  abandonTrace(traceId: TraceId): void {
    this.traces.delete(traceId);
  }

  hasSnapshotsAwaitingCompletion(): boolean {
    return false;
  }

  async pluckSnapshot(
    traceId: string,
  ): Promise<RequestSnapshot | JobSnapshot | undefined> {
    const entry = this.traces.get(traceId);
    if (!entry) return undefined;
    this.traces.delete(traceId);

    const unfinished = { count: 0 };
    const completedTree = this.finalizeTree(entry.snapshot.traces, unfinished);

    if (unfinished.count > 0) {
      entry.snapshot.tags = {
        ...entry.snapshot.tags,
        [UNFINISHED_SPANS_TAG]: unfinished.count,
      };
    }
    if (entry.unrecordedSpans > 0) {
      entry.snapshot.tags = {
        ...entry.snapshot.tags,
        [UNRECORDED_SPANS_TAG]: entry.unrecordedSpans,
      };
    }

    if (
      completedTree.length === 0 &&
      !entry.keepEmpty &&
      !entry.snapshot.error
    ) {
      return undefined;
    }

    if (isRequestSnapshot(entry.snapshot) && this.shouldSkipSpans(entry.snapshot)) {
      entry.snapshot.traces = [];
    } else {
      entry.snapshot.traces = collapseRepeatedSpans(
        completedTree,
        this.spanCollapse,
      );
    }

    return entry.snapshot;
  }

  getActiveSpan(
    traceId: string,
    callerId: string | undefined,
  ): OngoingTraceEventNode | undefined {
    const entry = this.traces.get(traceId);
    if (!entry || !callerId) return undefined;
    return entry.openNodes.get(callerId);
  }

  async createManualSpan(
    traceId: string,
    callerId: string | undefined,
    name: string,
    spanFunction: (span: TraceSpanDelegate) => any,
  ): Promise<any> {
    const entry = this.traces.get(traceId);
    const spanId = uuidv7();
    const tags: Record<string, string | number | boolean> = {};
    const delegate = new TraceSpanDelegate(spanId, name, tags);

    if (!entry || entry.totalSpans >= MAX_SPANS_PER_TRACE) {
      if (entry) entry.unrecordedSpans++;
      return await spanFunction(delegate);
    }

    entry.totalSpans++;
    const startTime = performance.now();
    const startOffset =
      entry.snapshot.startTimestamp !== undefined
        ? Math.max(0, startTime - entry.snapshot.startTimestamp)
        : undefined;

    const node: OngoingTraceEventNode = {
      type: "start",
      origin: "manual",
      spanId,
      name,
      className: "ManualSpan",
      methodKey: name,
      startTime,
      ...(startOffset !== undefined ? { startOffset } : {}),
      tags,
      children: [],
    };
    this.attachToCaller(entry, node, callerId);
    entry.openNodes.set(spanId, node);

    const store = this.als.getStore();
    const nextStore = store
      ? new Map(store)
      : new Map<KeyOf<{ [CALLER_METADATA_KEY]: string }>, unknown>();
    nextStore.set(CALLER_METADATA_KEY, spanId);

    try {
      const result = await this.als.run(nextStore, () => spanFunction(delegate));
      node.type = "end";
      (node as unknown as { duration: number }).duration = Math.max(
        0,
        performance.now() - startTime,
      );
      return result;
    } catch (err) {
      node.type = "end";
      (node as unknown as { duration: number }).duration = Math.max(
        0,
        performance.now() - startTime,
      );
      if (entry.capturedErrors < MAX_CAPTURED_ERRORS_PER_TRACE) {
        entry.capturedErrors++;
        node.error = this.toErrorPayload(err);
      } else {
        node.error = true;
      }
      throw err;
    }
  }

  private attachToCaller(
    entry: TraceEntry,
    node: OngoingTraceEventNode,
    callerId: string | undefined,
  ): void {
    const parent = callerId ? entry.openNodes.get(callerId) : undefined;
    if (!parent || parent.type === "end") {
      entry.snapshot.traces.push(node);
      return;
    }
    let depth = 0;
    let cursor: OngoingTraceEventNode | undefined = parent;
    while (cursor) {
      depth++;
      cursor = cursor.parent;
    }
    node.parent = parent;
    if (depth < MAX_SPAN_DEPTH) {
      parent.children.push(node);
    }
  }

  private finalizeTree(
    nodes: Array<OngoingTraceEventNode | CompleteTraceEventNode>,
    unfinished: { count: number },
  ): CompleteTraceEventNode[] {
    const out: CompleteTraceEventNode[] = [];
    for (const raw of nodes) {
      if ("type" in raw && raw.type === "start") {
        unfinished.count += 1 + this.countSubtree(raw.children);
        continue;
      }
      const duration =
        "duration" in raw && typeof raw.duration === "number"
          ? raw.duration
          : "startTime" in raw
            ? Math.max(0, performance.now() - raw.startTime)
            : 0;
      const children = this.finalizeTree(raw.children, unfinished);
      out.push({
        ...(raw.spanId !== undefined ? { spanId: raw.spanId } : {}),
        ...(raw.name !== undefined ? { name: raw.name } : {}),
        origin: raw.origin,
        className: raw.className,
        methodKey: raw.methodKey,
        duration,
        ...(raw.startOffset !== undefined ? { startOffset: raw.startOffset } : {}),
        ...(raw.tags && Object.keys(raw.tags).length > 0
          ? { tags: raw.tags }
          : {}),
        ...(raw.error !== undefined ? { error: raw.error } : {}),
        children,
      });
    }
    return out;
  }

  private countSubtree(
    nodes: Array<OngoingTraceEventNode | CompleteTraceEventNode>,
  ): number {
    let total = 0;
    for (const n of nodes) {
      total += 1 + this.countSubtree(n.children);
    }
    return total;
  }

  private shouldSkipSpans(snapshot: RequestSnapshot): boolean {
    if (!this.skipSpans) return false;
    try {
      return this.skipSpans({
        protocol: snapshot.protocol,
        operationId: snapshot.operationId,
        method: snapshot.attributes?.method,
        statusCode: snapshot.attributes?.statusCode,
        duration: snapshot.duration ?? 0,
        errorClass: snapshot.error?.cls,
      });
    } catch (err) {
      this.logger.warn(
        `skipSpans predicate threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private toErrorStatusCode(error: unknown): number {
    if (error instanceof HttpException) {
      const status = error.getStatus();
      return status >= 400 && status < 500 ? status : 400;
    }
    if (error instanceof IntrinsicException) {
      return 400;
    }
    return 500;
  }

  private toErrorPayload(
    error: unknown,
    tags?: Record<string, string | number | boolean>,
  ): {
    cls?: string;
    message: string;
    stack?: string;
    tags?: Record<string, string | number | boolean>;
  } {
    void this.sourceContext;
    const rawMessage =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : String(error);
    const rawStack = error instanceof Error ? error.stack : undefined;
    const cls =
      error instanceof Error
        ? error.constructor?.name || error.name
        : undefined;
    const message = this.redactor
      ? this.redactor.redactMessage(rawMessage)
      : rawMessage;
    const stack =
      rawStack !== undefined
        ? this.redactor
          ? this.redactor.redactMessage(rawStack)
          : rawStack
        : undefined;
    return {
      ...(cls ? { cls } : {}),
      message,
      ...(stack !== undefined ? { stack } : {}),
      ...(tags && Object.keys(tags).length > 0 ? { tags } : {}),
    };
  }
}
