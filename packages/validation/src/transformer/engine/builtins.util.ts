export { isPromiseLike } from "@bunest/core/common";

const TRUE_BOOLEAN_STRINGS = new Set(["true", "1"]);
const FALSE_BOOLEAN_STRINGS = new Set(["false", "0"]);

export function isDangerousKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

export function isPassthroughNativeObject(value: object): boolean {
  if (
    value instanceof RegExp ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof Error ||
    value instanceof ArrayBuffer ||
    (ArrayBuffer.isView(value) &&
      !(typeof Buffer !== "undefined" && Buffer.isBuffer(value)))
  ) {
    return true;
  }
  if (typeof URL !== "undefined" && value instanceof URL) return true;
  if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams)
    return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (typeof Headers !== "undefined" && value instanceof Headers) return true;
  if (typeof FormData !== "undefined" && value instanceof FormData) return true;
  if (typeof Request !== "undefined" && value instanceof Request) return true;
  if (typeof Response !== "undefined" && value instanceof Response) return true;
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
    return true;
  return false;
}

export function coerceBooleanSafe(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (TRUE_BOOLEAN_STRINGS.has(normalized)) return true;
    if (FALSE_BOOLEAN_STRINGS.has(normalized)) return false;
    return value;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  return value;
}

export function coerceNumberSafe(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return value;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

export function convertExplicitBoolean(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return Boolean(value);
}

export function readDesignType(
  prototype: object | undefined,
  propertyKey: string,
): Function | undefined {
  if (!prototype) return undefined;
  const reflectObj = Reflect as unknown as {
    getMetadata?: (key: string, target: object, prop: string) => unknown;
  };
  if (typeof reflectObj.getMetadata !== "function") return undefined;
  const result = reflectObj.getMetadata("design:type", prototype, propertyKey);
  return typeof result === "function" ? result : undefined;
}
