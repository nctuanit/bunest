/**
 * Returns true if the property key could trigger prototype pollution.
 */
export function isDangerousKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively strips dangerous keys (`__proto__`, `constructor`, `prototype`)
 * from parsed objects and arrays without mutating `Object.prototype`.
 */
export function sanitizeObject<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  return sanitizeInternal(value, new WeakMap()) as T;
}

function sanitizeInternal(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const cached = seen.get(value);
  if (cached !== undefined) {
    return cached;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) {
      out[i] = sanitizeInternal(value[i], seen);
    }
    return out;
  }

  if (!isPlainObject(value)) {
    // Preserve built-in instances (Date, Uint8Array, File, Blob, RegExp, etc.)
    return value;
  }

  const clean: Record<string, unknown> = {};
  seen.set(value, clean);

  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    clean[key] = sanitizeInternal(
      (value as Record<string, unknown>)[key],
      seen,
    );
  }

  return clean;
}

/**
 * Creates a shallow sanitized copy of a string-keyed record, omitting dangerous keys.
 */
export function sanitizeRecord<T>(
  input: Record<string, T> | undefined | null,
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!input) {
    return out;
  }
  for (const key in input) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      continue;
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const value = input[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
