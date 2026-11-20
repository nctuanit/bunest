export const isUndefined = (value: unknown): value is undefined =>
  value === undefined;

export function isPlainObject(value: unknown): value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags) as unknown as T;
  }
  if (value instanceof Uint8Array) {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      return Buffer.from(value) as unknown as T;
    }
    return new Uint8Array(value) as unknown as T;
  }
  if (value instanceof Map) {
    const cloned = new Map();
    for (const [k, v] of value.entries()) {
      cloned.set(deepClone(k), deepClone(v));
    }
    return cloned as unknown as T;
  }
  if (value instanceof Set) {
    const cloned = new Set();
    for (const v of value.values()) {
      cloned.add(deepClone(v));
    }
    return cloned as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  // Preserve ObjectId-like value objects without stripping prototype
  if (
    typeof (value as { toHexString?: unknown }).toHexString === "function" &&
    typeof (value as { equals?: unknown }).equals === "function"
  ) {
    return value;
  }
  const copy: Record<string, any> = {};
  for (const [k, v] of Object.entries(value as Record<string, any>)) {
    copy[k] = deepClone(v);
  }
  return copy as T;
}

export function getNestedValue(obj: Record<string, any>, path: string): any {
  if (!path.includes(".")) {
    return obj[path];
  }
  const segments = path.split(".");
  let current: any = obj;
  for (let i = 0; i < segments.length; i++) {
    if (current === null || current === undefined) {
      return undefined;
    }
    const seg = segments[i]!;
    if (Array.isArray(current) && !/^\d+$/.test(seg)) {
      const rest = segments.slice(i).join(".");
      return current.map((item) =>
        item && typeof item === "object" ? getNestedValue(item, rest) : undefined,
      );
    }
    current = current[seg];
  }
  return current;
}

const FORBIDDEN_PATH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function setNestedValue(
  obj: Record<string, any>,
  path: string,
  value: unknown,
): void {
  const segments = path.split(".");
  for (const seg of segments) {
    if (FORBIDDEN_PATH_KEYS.has(seg)) {
      return;
    }
  }
  if (segments.length === 1) {
    obj[segments[0]!] = value;
    return;
  }
  let current: Record<string, any> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (
      current[seg] === undefined ||
      current[seg] === null ||
      typeof current[seg] !== "object"
    ) {
      current[seg] = {};
    }
    current = current[seg];
  }
  current[segments[segments.length - 1]!] = value;
}

export function deleteNestedValue(obj: Record<string, any>, path: string): void {
  const segments = path.split(".");
  for (const seg of segments) {
    if (FORBIDDEN_PATH_KEYS.has(seg)) {
      return;
    }
  }
  if (segments.length === 1) {
    delete obj[segments[0]!];
    return;
  }
  let current: any = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== "object") {
      return;
    }
    current = current[segments[i]!];
  }
  if (current && typeof current === "object") {
    delete current[segments[segments.length - 1]!];
  }
}

export function pluralizeCollectionName(modelName: string): string {
  const lower = modelName.toLowerCase();
  if (lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("z")) {
    return `${lower}es`;
  }
  if (lower.endsWith("y") && !/[aeiou]y$/.test(lower)) {
    return `${lower.slice(0, -1)}ies`;
  }
  return `${lower}s`;
}
