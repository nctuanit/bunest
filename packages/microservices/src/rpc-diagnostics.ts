import {
  CLS_ID,
  ClsContextPropagator,
  ClsService,
  captureClsContext,
  clsToHeaders,
  diagnosticsChannel,
  getAmbientClsStore,
  getAmbientTraceparent,
  type ClsContextCarrier,
  type ClsContextPropagatorOptions,
  type ClsServiceLike,
  type DiagnosticChannel,
} from "@bunest/core";

/** Diagnostics channel published around outbound `ClientProxy.send()` / `emit()` calls. */
export const RPC_CLIENT_CHANNEL = "bunest:rpc:client";

/** Diagnostics channel published around inbound `@MessagePattern()` / `@EventPattern()` handling. */
export const RPC_SERVER_CHANNEL = "bunest:rpc:server";

export interface RpcDiagnosticEvent {
  readonly phase: "start" | "end" | "error";
  readonly kind: "request" | "event";
  readonly pattern: string;
  readonly transport: string;
  readonly durationMs?: number;
  readonly error?: unknown;
  readonly traceparent?: string;
  readonly attempt?: number;
}

export const rpcClientChannel: DiagnosticChannel =
  diagnosticsChannel(RPC_CLIENT_CHANNEL);

export const rpcServerChannel: DiagnosticChannel =
  diagnosticsChannel(RPC_SERVER_CHANNEL);

/**
 * Shared default `ClsService` backed by `@bunest/core`'s singleton default CLS
 * `ContextStorage`, used when a transport server restores inbound CLS headers
 * without an explicitly injected `ClsService`.
 */
export const defaultRpcClsService = new ClsService();

export type ClsPropagationConfig =
  | boolean
  | readonly string[]
  | ClsContextPropagatorOptions
  | undefined;

export function resolveClsPropagator(config: ClsPropagationConfig): {
  readonly enabled: boolean;
  readonly propagator: ClsContextPropagator;
} {
  if (config === false) {
    return { enabled: false, propagator: new ClsContextPropagator() };
  }
  if (Array.isArray(config)) {
    return {
      enabled: true,
      propagator: new ClsContextPropagator({ keys: config }),
    };
  }
  if (config && typeof config === "object") {
    return {
      enabled: true,
      propagator: new ClsContextPropagator(
        config as ClsContextPropagatorOptions,
      ),
    };
  }
  return { enabled: true, propagator: new ClsContextPropagator() };
}

function captureAmbientCarrier(
  propagator: ClsContextPropagator,
): ClsContextCarrier {
  const store = getAmbientClsStore();
  const values: Record<string, unknown> = {};
  let clsId: string | undefined;

  if (store) {
    const rawId = store.get(CLS_ID);
    if (typeof rawId === "string" && rawId.length > 0) {
      clsId = rawId;
    }
    for (let i = 0; i < propagator.keys.length; i++) {
      const key = propagator.keys[i]!;
      if (store.has(key)) {
        const val = store.get(key);
        if (val !== undefined) {
          values[key] = val;
        }
      }
    }
  }

  const ambientTraceparent =
    getAmbientTraceparent() ??
    (store && typeof store.get("traceparent") === "string"
      ? (store.get("traceparent") as string)
      : undefined);

  return {
    ...(clsId !== undefined ? { clsId } : {}),
    ...(ambientTraceparent !== undefined
      ? { traceparent: ambientTraceparent }
      : {}),
    values,
  };
}

function hasHeaderCaseInsensitive(
  record: Readonly<Record<string, unknown>>,
  name: string,
): boolean {
  const lower = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lower) {
      return true;
    }
  }
  return false;
}

export function findTraceparentInMetadata(
  record: unknown,
): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const obj = record as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    if (key.toLowerCase() === "traceparent" && typeof val === "string" && val.length > 0) {
      return val;
    }
  }
  if (obj.headers && typeof obj.headers === "object" && !Array.isArray(obj.headers)) {
    for (const [key, val] of Object.entries(obj.headers as Record<string, unknown>)) {
      if (key.toLowerCase() === "traceparent" && typeof val === "string" && val.length > 0) {
        return val;
      }
    }
  }
  return undefined;
}

/**
 * Captures outbound CLS + ambient W3C `traceparent` headers and merges them
 * with any user/hook-supplied packet metadata without overwriting user keys.
 * Returns `undefined` when no metadata or context values are present.
 */
export function buildOutboundRpcMetadata(input: {
  readonly userMetadata?: Record<string, unknown>;
  readonly hookMetadata?: Record<string, unknown>;
  readonly propagator: ClsContextPropagator;
  readonly cls?: ClsServiceLike;
  readonly enabled: boolean;
}): {
  readonly metadata: Record<string, unknown> | undefined;
  readonly traceparent: string | undefined;
} {
  let merged: Record<string, unknown> | undefined;

  if (input.userMetadata) {
    merged = { ...input.userMetadata };
  }
  if (input.hookMetadata) {
    merged = { ...(merged ?? {}), ...input.hookMetadata };
  }

  if (input.enabled) {
    const carrier = input.cls
      ? captureClsContext(input.cls, input.propagator.keys)
      : captureAmbientCarrier(input.propagator);
    const headers = clsToHeaders(carrier, input.propagator.headerMap);
    for (const [key, value] of Object.entries(headers)) {
      if (!merged || !hasHeaderCaseInsensitive(merged, key)) {
        merged ??= {};
        merged[key] = value;
      }
    }
  } else {
    // Even if CLS key propagation is disabled, still honor explicit ambient traceparent if absent
    const tp = getAmbientTraceparent();
    if (tp && (!merged || !hasHeaderCaseInsensitive(merged, "traceparent"))) {
      merged ??= {};
      merged.traceparent = tp;
    }
  }

  const traceparent = merged
    ? findTraceparentInMetadata(merged)
    : getAmbientTraceparent();

  return { metadata: merged, traceparent };
}

function collectHeaderRecord(
  candidate: unknown,
  out: Record<string, string>,
): void {
  if (!candidate || typeof candidate !== "object") {
    return;
  }
  if (candidate instanceof Headers) {
    candidate.forEach((value, key) => {
      if (!(key.toLowerCase() in out)) {
        out[key.toLowerCase()] = value;
      }
    });
    return;
  }
  if (candidate instanceof Map) {
    for (const [k, v] of candidate.entries()) {
      if (typeof v === "string") {
        const lk = String(k).toLowerCase();
        if (!(lk in out)) out[lk] = v;
      }
    }
    return;
  }
  if (Array.isArray(candidate)) {
    return;
  }
  for (const [k, v] of Object.entries(candidate as Record<string, unknown>)) {
    const lk = k.toLowerCase();
    if (lk in out) continue;
    if (typeof v === "string") {
      out[lk] = v;
    } else if (v instanceof Uint8Array) {
      out[lk] = new TextDecoder().decode(v);
    } else if (Array.isArray(v) && typeof v[0] === "string") {
      out[lk] = v[0];
    }
  }
}

/**
 * Extracts a `ClsContextCarrier` from an incoming `RpcContext` (or transport
 * `BaseRpcContext` exposing `.metadata`, `.headers`, `.getMetadata()`, or `.getHeaders()`).
 */
export function extractInboundClsCarrier(
  ctx: unknown,
  propagator: ClsContextPropagator,
): ClsContextCarrier {
  const flatHeaders: Record<string, string> = {};
  if (ctx && typeof ctx === "object") {
    const rec = ctx as Record<string, unknown> & {
      getMetadata?: () => unknown;
      getHeaders?: () => unknown;
    };
    const meta = rec.metadata;
    collectHeaderRecord(meta, flatHeaders);
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      collectHeaderRecord((meta as Record<string, unknown>).headers, flatHeaders);
    }
    if (typeof rec.getMetadata === "function") {
      const md = rec.getMetadata();
      if (
        md &&
        typeof md === "object" &&
        typeof (md as { toHeaders?: () => Record<string, string> }).toHeaders ===
          "function"
      ) {
        collectHeaderRecord(
          (md as { toHeaders: () => Record<string, string> }).toHeaders(),
          flatHeaders,
        );
      } else {
        collectHeaderRecord(md, flatHeaders);
      }
    }
    if (typeof rec.getHeaders === "function") {
      collectHeaderRecord(rec.getHeaders(), flatHeaders);
    }
  }

  return propagator.fromHeaders(flatHeaders);
}

export function hasCarrierContext(carrier: ClsContextCarrier): boolean {
  return (
    carrier.clsId !== undefined ||
    carrier.traceparent !== undefined ||
    Object.keys(carrier.values).length > 0
  );
}
