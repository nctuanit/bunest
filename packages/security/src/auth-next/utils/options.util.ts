/** `value` must be set and not empty. */
export function requireOption(
  value: unknown,
  option: string,
  what: string,
): void {
  if (value !== undefined && value !== null && value !== "") {
    return;
  }
  throw new TypeError(
    `AuthenticationModule: \`${option}\` is required (${what}), but it is ${value === "" ? "empty" : "undefined"}: ` +
      "is the environment variable it reads set?",
  );
}

/** `value`, when set, must be an integer from `min` to `max`. */
export function requireIntegerOption(
  value: unknown,
  option: string,
  { min, max = Number.MAX_SAFE_INTEGER }: { min: number; max?: number },
): void {
  if (
    value === undefined ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max)
  ) {
    return;
  }
  const range =
    max === Number.MAX_SAFE_INTEGER
      ? `of at least ${min}`
      : `from ${min} to ${max}`;
  throw new TypeError(
    `AuthenticationModule: \`${option}\` must be an integer ${range}, but it is ` +
      `${typeof value === "string" ? JSON.stringify(value) : String(value)}` +
      (Number.isNaN(value)
        ? ": is the environment variable it reads set?"
        : "."),
  );
}

/** `value` must be an absolute http(s) URL. */
export function requireUrlOption(
  value: unknown,
  option: string,
  what: string,
): void {
  requireOption(value, option, what);
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new TypeError(
      `AuthenticationModule: \`${option}\` must be an absolute http(s) URL (${what}). Got ${JSON.stringify(value)}` +
        (typeof value === "string" && value.startsWith("undefined")
          ? ": is the environment variable it reads set?"
          : "."),
    );
  }
}
