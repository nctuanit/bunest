/**
 * Universal Cross-Transport CLS Context Carrier & Ambient W3C Traceparent Hook.
 *
 * 100% browser-pure (zero `node:*`, zero `Bun`, zero `reflect-shim`, zero DI runtime imports)
 * so both server packages (`@bunest/jobs`, `@bunest/microservices`, `@bunest/observability`,
 * WebSocket adapter) and browser-safe `HttpClient` / `@bunest/core/typed-client` can share
 * the exact same context propagation primitives while preserving a strict package DAG.
 */

import { isPlainObject as isPlainRecord } from "../common/utils/type-guards.util";

const CLS_ID_SYMBOL = Symbol.for("bunest:core:cls_id");

/**
 * Single-realm global symbol storing the ambient W3C `traceparent` provider
 * (e.g. registered by `@bunest/observability`'s OTel tracer).
 */
export const AMBIENT_TRACEPARENT_PROVIDER_SYMBOL = Symbol.for(
  "bunest:trace:get_traceparent",
);

/**
 * Single-realm global symbol storing a reader for the active default CLS store
 * (registered automatically by `ClsService` on the server; absent in browsers).
 */
export const AMBIENT_CLS_STORE_GETTER_SYMBOL = Symbol.for(
  "bunest:cls:get_current_store",
);

/** Default CLS keys propagated across HTTP, WebSocket, Queue, and RPC boundaries. */
export const DEFAULT_CLS_PROPAGATION_KEYS = Object.freeze([
  "requestId",
  "tenantId",
  "userId",
  "correlationId",
] as const);

/** Default mapping from CLS store keys to canonical HTTP/transport header names. */
export const DEFAULT_CLS_HEADER_MAP: Readonly<Record<string, string>> =
  Object.freeze({
    requestId: "x-request-id",
    tenantId: "x-tenant-id",
    userId: "x-user-id",
    correlationId: "x-correlation-id",
  });

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INVALID_HEADER_VALUE_RE = /[\r\n\0]/;
const VALID_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** JSON-serializable snapshot of CLS & trace context carried across transports. */
export interface ClsContextCarrier {
  readonly clsId?: string;
  readonly traceparent?: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** Carrier input accepted by restoration and header serialization helpers. */
export type ClsCarrierInput =
  | ClsContextCarrier
  | Readonly<Record<string, unknown>>;

/** Structural interface matching `ClsService` without creating a runtime import cycle. */
export interface ClsServiceLike {
  isActive(): boolean;
  getId?(): string | undefined;
  get<T = unknown>(key: string | symbol): T | undefined;
  has?(key: string | symbol): boolean;
  run<T>(callback: () => T, initial?: Record<PropertyKey, unknown>): T;
}

/** Provider returning the active W3C `traceparent` string (if any). */
export type AmbientTraceparentProvider = () => string | undefined;

/** Reader returning the active default `ClsStore` Map (if inside an active CLS context). */
export type AmbientClsStoreGetter = () =>
  | Map<string | symbol, unknown>
  | undefined;

/** Configuration for `ClsContextPropagator`. */
export interface ClsContextPropagatorOptions {
  /**
   * CLS keys captured by `capture()` and serialized by `captureToHeaders()`.
   * @default DEFAULT_CLS_PROPAGATION_KEYS
   */
  readonly keys?: readonly string[];
  /**
   * Mapping from CLS key name to HTTP/transport header name (case-insensitive on read).
   * @default DEFAULT_CLS_HEADER_MAP
   */
  readonly headerMap?: Readonly<Record<string, string>>;
}

function isStructuredCarrier(
  input: ClsCarrierInput,
): input is ClsContextCarrier {
  if (!isPlainRecord(input) || !isPlainRecord(input.values)) {
    return false;
  }
  for (const key of Object.keys(input)) {
    if (key !== "clsId" && key !== "traceparent" && key !== "values") {
      return false;
    }
  }
  return true;
}

function sanitizeHeaderValue(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (
    typeof raw !== "string" &&
    typeof raw !== "number" &&
    typeof raw !== "boolean"
  ) {
    return undefined;
  }
  const str = String(raw).trim();
  if (str.length === 0 || INVALID_HEADER_VALUE_RE.test(str)) {
    return undefined;
  }
  return str;
}

function keyToDefaultHeaderName(key: string): string {
  const mapped = DEFAULT_CLS_HEADER_MAP[key];
  if (mapped) {
    return mapped;
  }
  const lower = key.toLowerCase();
  if (lower.startsWith("x-")) {
    return lower;
  }
  const kebab = key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
  return `x-${kebab}`;
}

/**
 * Registers a single-realm ambient W3C `traceparent` provider under
 * `Symbol.for("bunest:trace:get_traceparent")`.
 *
 * Returns a disposer function that unregisters the provider only if it is
 * still the currently registered instance.
 */
export function registerAmbientTraceparentProvider(
  provider: AmbientTraceparentProvider | undefined,
): () => void {
  const g = globalThis as Record<PropertyKey, unknown>;
  if (provider === undefined) {
    delete g[AMBIENT_TRACEPARENT_PROVIDER_SYMBOL];
    return () => {};
  }
  if (typeof provider !== "function") {
    throw new TypeError(
      "registerAmbientTraceparentProvider() requires a function or undefined.",
    );
  }
  g[AMBIENT_TRACEPARENT_PROVIDER_SYMBOL] = provider;
  return () => {
    if (g[AMBIENT_TRACEPARENT_PROVIDER_SYMBOL] === provider) {
      delete g[AMBIENT_TRACEPARENT_PROVIDER_SYMBOL];
    }
  };
}

/**
 * Reads the currently active W3C `traceparent` header value from the registered
 * single-realm ambient provider (`Symbol.for("bunest:trace:get_traceparent")`),
 * returning `undefined` if none is registered or no trace span is active.
 */
export function getAmbientTraceparent(): string | undefined {
  const g = globalThis as Record<PropertyKey, unknown>;
  const provider = g[AMBIENT_TRACEPARENT_PROVIDER_SYMBOL];
  if (typeof provider !== "function") {
    return undefined;
  }
  try {
    const value = (provider as AmbientTraceparentProvider)();
    return sanitizeHeaderValue(value);
  } catch {
    return undefined;
  }
}

/**
 * Registers the server-side default CLS store reader on `globalThis` so
 * browser-pure modules (such as `HttpClient`) can inspect active CLS values
 * without importing `AsyncLocalStorage` or `node:async_hooks`.
 *
 * @internal
 */
export function registerAmbientClsStoreGetter(
  getter: AmbientClsStoreGetter | undefined,
): () => void {
  const g = globalThis as Record<PropertyKey, unknown>;
  if (getter === undefined) {
    delete g[AMBIENT_CLS_STORE_GETTER_SYMBOL];
    return () => {};
  }
  g[AMBIENT_CLS_STORE_GETTER_SYMBOL] = getter;
  return () => {
    if (g[AMBIENT_CLS_STORE_GETTER_SYMBOL] === getter) {
      delete g[AMBIENT_CLS_STORE_GETTER_SYMBOL];
    }
  };
}

/**
 * Reads the currently active ambient default CLS store map, if available.
 */
export function getAmbientClsStore():
  | Map<string | symbol, unknown>
  | undefined {
  const g = globalThis as Record<PropertyKey, unknown>;
  const getter = g[AMBIENT_CLS_STORE_GETTER_SYMBOL];
  if (typeof getter !== "function") {
    return undefined;
  }
  try {
    return (getter as AmbientClsStoreGetter)();
  } catch {
    return undefined;
  }
}

/**
 * Captures a JSON-serializable snapshot of CLS context keys + `clsId` + ambient
 * W3C `traceparent` from `cls` for propagation across async/network boundaries.
 */
export function captureClsContext(
  cls: ClsServiceLike | undefined,
  keys: readonly string[] = DEFAULT_CLS_PROPAGATION_KEYS,
): ClsContextCarrier {
  const values: Record<string, unknown> = {};
  let clsId: string | undefined;

  if (cls && cls.isActive()) {
    const rawId = cls.getId ? cls.getId() : cls.get<unknown>(CLS_ID_SYMBOL);
    if (typeof rawId === "string" && rawId.length > 0) {
      clsId = rawId;
    }

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!key || DANGEROUS_KEYS.has(key)) continue;
      const val = cls.get(key);
      if (val !== undefined) {
        values[key] = val;
      }
    }
  }

  const ambientTraceparent =
    getAmbientTraceparent() ??
    (cls?.isActive()
      ? sanitizeHeaderValue(cls.get<unknown>("traceparent"))
      : undefined);

  return {
    ...(clsId !== undefined ? { clsId } : {}),
    ...(ambientTraceparent !== undefined
      ? { traceparent: ambientTraceparent }
      : {}),
    values,
  };
}

/**
 * Executes `fn` inside a fresh isolated `ClsService` context hydrated from
 * `carrier` (preserving `CLS_ID`, captured keys, and `traceparent`).
 */
export function restoreClsContext<T>(
  cls: ClsServiceLike,
  carrier: ClsCarrierInput | undefined,
  fn: () => T,
): T {
  const initial: Record<PropertyKey, unknown> = {};

  if (carrier) {
    if (isStructuredCarrier(carrier)) {
      for (const [key, value] of Object.entries(carrier.values)) {
        if (!DANGEROUS_KEYS.has(key) && value !== undefined) {
          initial[key] = value;
        }
      }
      if (typeof carrier.clsId === "string" && carrier.clsId.length > 0) {
        initial[CLS_ID_SYMBOL] = carrier.clsId;
      } else if (
        typeof initial.requestId === "string" &&
        initial.requestId.length > 0
      ) {
        initial[CLS_ID_SYMBOL] = initial.requestId;
      }
      if (
        typeof carrier.traceparent === "string" &&
        carrier.traceparent.length > 0 &&
        initial.traceparent === undefined
      ) {
        initial.traceparent = carrier.traceparent;
      }
    } else if (isPlainRecord(carrier)) {
      for (const [key, value] of Object.entries(carrier)) {
        if (!DANGEROUS_KEYS.has(key) && value !== undefined) {
          initial[key] = value;
        }
      }
      if (
        typeof initial.requestId === "string" &&
        initial.requestId.length > 0
      ) {
        initial[CLS_ID_SYMBOL] = initial.requestId;
      }
    }
  }

  return cls.run(fn, initial);
}

/**
 * Converts a `ClsContextCarrier` (or flat key-value record) into sanitized
 * outgoing HTTP/transport headers using `headerMap` (defaulting to
 * `requestId -> x-request-id`, `tenantId -> x-tenant-id`, `userId -> x-user-id`,
 * `correlationId -> x-correlation-id`, plus `traceparent`).
 */
export function clsToHeaders(
  carrier: ClsCarrierInput | undefined,
  headerMap: Readonly<Record<string, string>> = DEFAULT_CLS_HEADER_MAP,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!carrier) {
    return headers;
  }

  const structured = isStructuredCarrier(carrier);
  const values: Readonly<Record<string, unknown>> = structured
    ? carrier.values
    : (isPlainRecord(carrier) ? carrier : {});

  for (const [clsKey, rawHeaderName] of Object.entries(headerMap)) {
    if (!clsKey || DANGEROUS_KEYS.has(clsKey)) continue;
    const headerName = rawHeaderName.trim().toLowerCase();
    if (!headerName || !VALID_HEADER_NAME_RE.test(headerName)) continue;

    let rawValue = Object.prototype.hasOwnProperty.call(values, clsKey)
      ? values[clsKey]
      : undefined;

    if (
      rawValue === undefined &&
      clsKey === "requestId" &&
      structured &&
      carrier.clsId !== undefined
    ) {
      rawValue = carrier.clsId;
    }

    const sanitized = sanitizeHeaderValue(rawValue);
    if (sanitized !== undefined) {
      headers[headerName] = sanitized;
    }
  }

  const rawTraceparent = structured
    ? (carrier.traceparent ?? values.traceparent)
    : values.traceparent;
  const traceparent = sanitizeHeaderValue(rawTraceparent);
  if (traceparent !== undefined && headers.traceparent === undefined) {
    headers.traceparent = traceparent;
  }

  return headers;
}

/**
 * Extracts a `ClsContextCarrier` from Web `Headers` or a plain header record
 * using `headerMap` (case-insensitive lookup) plus W3C `traceparent`.
 */
export function headersToCls(
  headers:
    | Headers
    | Readonly<Record<string, string | readonly string[] | undefined>>
    | undefined,
  headerMap: Readonly<Record<string, string>> = DEFAULT_CLS_HEADER_MAP,
): ClsContextCarrier {
  const values: Record<string, unknown> = {};
  if (!headers) {
    return { values };
  }

  const isHeadersInstance =
    typeof Headers !== "undefined" &&
    (headers instanceof Headers ||
      typeof (headers as Partial<Headers>).get === "function");

  let normalizedRecord: Record<string, string> | undefined;
  const readHeader = (headerName: string): string | undefined => {
    const lower = headerName.toLowerCase();
    if (isHeadersInstance) {
      const val = (headers as Headers).get(lower);
      return val !== null ? sanitizeHeaderValue(val) : undefined;
    }
    if (!normalizedRecord) {
      normalizedRecord = {};
      for (const [k, v] of Object.entries(
        headers as Record<string, string | readonly string[] | undefined>,
      )) {
        const lk = k.toLowerCase();
        const raw = Array.isArray(v) ? v[0] : v;
        const clean = sanitizeHeaderValue(raw);
        if (clean !== undefined) {
          normalizedRecord[lk] = clean;
        }
      }
    }
    return normalizedRecord[lower];
  };

  for (const [clsKey, headerName] of Object.entries(headerMap)) {
    if (!clsKey || DANGEROUS_KEYS.has(clsKey) || !headerName) continue;
    const val = readHeader(headerName);
    if (val !== undefined) {
      values[clsKey] = val;
    }
  }

  const traceparent = readHeader("traceparent");
  const clsId =
    typeof values.requestId === "string" && values.requestId.length > 0
      ? values.requestId
      : undefined;

  return {
    ...(clsId !== undefined ? { clsId } : {}),
    ...(traceparent !== undefined ? { traceparent } : {}),
    values,
  };
}

/**
 * Reads headers from the currently active ambient default CLS store for
 * outbound `HttpClient` propagation without importing server CLS/ALS classes.
 *
 * @internal
 */
export function captureAmbientClsHeaders(
  propagate: boolean | readonly string[],
  headerMap?: Readonly<Record<string, string>>,
): Record<string, string> {
  if (!propagate) {
    return {};
  }
  const store = getAmbientClsStore();
  if (!store) {
    return {};
  }

  const keys = Array.isArray(propagate)
    ? propagate
    : DEFAULT_CLS_PROPAGATION_KEYS;
  const effectiveMap: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!key || DANGEROUS_KEYS.has(key)) continue;
    effectiveMap[key] = headerMap?.[key] ?? keyToDefaultHeaderName(key);
    if (store.has(key)) {
      const val = store.get(key);
      if (val !== undefined) {
        values[key] = val;
      }
    }
  }

  const rawId = store.get(CLS_ID_SYMBOL);
  const clsId = typeof rawId === "string" && rawId.length > 0 ? rawId : undefined;
  return clsToHeaders({ ...(clsId ? { clsId } : {}), values }, effectiveMap);
}

/**
 * Reusable cross-transport CLS context propagator configured with an explicit
 * key list and header map for HTTP, WebSockets, Queues, and Microservices.
 */
export class ClsContextPropagator {
  public readonly keys: readonly string[];
  public readonly headerMap: Readonly<Record<string, string>>;

  constructor(options: ClsContextPropagatorOptions = {}) {
    this.keys = options.keys
      ? Object.freeze([...options.keys])
      : DEFAULT_CLS_PROPAGATION_KEYS;
    if (options.headerMap) {
      this.headerMap = Object.freeze({ ...options.headerMap });
    } else if (options.keys) {
      const built: Record<string, string> = {};
      for (const key of options.keys) {
        if (!key || DANGEROUS_KEYS.has(key)) continue;
        built[key] = keyToDefaultHeaderName(key);
      }
      this.headerMap = Object.freeze(built);
    } else {
      this.headerMap = DEFAULT_CLS_HEADER_MAP;
    }
  }

  capture(cls: ClsServiceLike | undefined): ClsContextCarrier {
    return captureClsContext(cls, this.keys);
  }

  restore<T>(
    cls: ClsServiceLike,
    carrier: ClsCarrierInput | undefined,
    fn: () => T,
  ): T {
    return restoreClsContext(cls, carrier, fn);
  }

  /** Alias for `restore()` matching cross-transport propagation naming. */
  runRestored<T>(
    cls: ClsServiceLike,
    carrier: ClsCarrierInput | undefined,
    fn: () => T,
  ): T {
    return restoreClsContext(cls, carrier, fn);
  }

  toHeaders(carrier: ClsCarrierInput | undefined): Record<string, string> {
    return clsToHeaders(carrier, this.headerMap);
  }

  fromHeaders(
    headers:
      | Headers
      | Readonly<Record<string, string | readonly string[] | undefined>>
      | undefined,
  ): ClsContextCarrier {
    return headersToCls(headers, this.headerMap);
  }

  captureToHeaders(cls: ClsServiceLike | undefined): Record<string, string> {
    return this.toHeaders(this.capture(cls));
  }

  runFromHeaders<T>(
    cls: ClsServiceLike,
    headers:
      | Headers
      | Readonly<Record<string, string | readonly string[] | undefined>>
      | undefined,
    fn: () => T,
  ): T {
    return this.restore(cls, this.fromHeaders(headers), fn);
  }
}
