import { compareAsc, isObject } from "@bunest/core/common";

/** JSON with sorted object keys, to compare inputs and payloads by value. */
export function canonical(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      isObject(v)
        ? Object.fromEntries(
            Object.entries(v).sort(([a], [b]) => compareAsc(a, b)),
          )
        : v,
    ) ?? "undefined"
  );
}
