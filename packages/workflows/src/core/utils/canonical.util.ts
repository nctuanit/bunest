/** JSON with sorted object keys, to compare inputs and payloads by value. */
export function canonical(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : v,
    ) ?? "undefined"
  );
}
