import { toArray } from "@bunest/core/common";

/**
 * Concatenates type definitions (strings) and arrays; merges any other two
 * values as objects, one level deep (matching `@nestjs/graphql` `extend`).
 */
export function extend(obj1: unknown, obj2: unknown): any {
  if (typeof obj1 === "string") {
    return [obj1, ...toArray(obj2)];
  }
  if (Array.isArray(obj1)) {
    return [...obj1, ...toArray(obj2)];
  }
  return {
    ...((obj1 as Record<string, unknown> | null | undefined) ?? {}),
    ...((obj2 as Record<string, unknown> | null | undefined) ?? {}),
  };
}
