function stripDangerousKeys(
  value: unknown,
  mode: boolean | "proto" | "constructor",
): unknown {
  if (mode === true || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripDangerousKeys(item, mode));
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (
      (key === "__proto__" && (mode === false || mode === "proto")) ||
      (key === "constructor" && (mode === false || mode === "constructor"))
    ) {
      delete obj[key];
      continue;
    }
    obj[key] = stripDangerousKeys(obj[key], mode);
  }
  return obj;
}

export class ElasticsearchSerializer {
  private readonly disableProtection: boolean | "proto" | "constructor";

  constructor(
    disablePrototypePoisoningProtection:
      boolean | "proto" | "constructor" = false,
  ) {
    this.disableProtection = disablePrototypePoisoningProtection;
  }

  serialize(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value);
  }

  ndserialize(items: readonly unknown[]): string {
    if (items.length === 0) {
      return "";
    }
    return (
      items
        .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        .join("\n") + "\n"
    );
  }

  deserialize<T = any>(text: string): T {
    if (!text) {
      return "" as unknown as T;
    }
    const parsed = JSON.parse(text);
    return stripDangerousKeys(parsed, this.disableProtection) as T;
  }

  qserialize(query?: Record<string, any> | string): string {
    if (!query) return "";
    if (typeof query === "string") {
      return query.replace(/^\?/, "");
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        params.set(key, value.map(String).join(","));
      } else {
        params.set(key, String(value));
      }
    }
    return params.toString();
  }
}
