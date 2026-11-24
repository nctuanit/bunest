import type { EntityRef, InverseSideSelector } from "./types";

/**
 * Creates a typed, zero-runtime-dependency entity reference token.
 *
 * Allows declaring bidirectional relations across files using `import type` ONLY,
 * completely eliminating ESM circular module imports and TDZ `ReferenceError`:
 *
 * ```ts
 * // user.entity.ts
 * import type { Post } from "./post.entity";
 * import { Entity, OneToMany, entityRef } from "@bunest/orm";
 *
 * export const PostRef = entityRef<Post>("Post");
 *
 * @Entity("users")
 * export class User {
 *   @OneToMany(PostRef, (post) => post.author)
 *   posts!: Post[];
 * }
 * ```
 */
export function entityRef<T = unknown>(name: string): EntityRef<T> {
  if (!name || typeof name !== "string") {
    throw new Error("entityRef(name) requires a non-empty string entity or table name.");
  }
  return Object.freeze({
    __ormEntityRef: true as const,
    name,
  });
}

/**
 * Type guard checking whether a value is an `EntityRef<T>`.
 */
export function isEntityRef(value: unknown): value is EntityRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __ormEntityRef?: unknown }).__ormEntityRef === true &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

/**
 * Extracts a property name from an `inverseSide` selector WITHOUT invoking any
 * class constructor and WITHOUT brittle regex parsing of `fn.toString()` (which breaks
 * under minification).
 *
 * Uses a lightweight tracking `Proxy`:
 * - `(post) => post.author` -> `"author"`
 * - `"author"` -> `"author"`
 */
export function extractInversePropertyName(
  selector: InverseSideSelector | undefined,
): string | undefined {
  if (selector === undefined) {
    return undefined;
  }
  if (typeof selector === "string") {
    const trimmed = selector.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof selector !== "function") {
    return undefined;
  }

  const accessed: string[] = [];
  const createTrap = (path: string[]): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === "symbol") {
            return undefined;
          }
          const next = [...path, prop];
          accessed.push(next.join("."));
          return createTrap(next);
        },
      },
    );

  try {
    selector(createTrap([]));
  } catch {
    // Fall back to string inspection only if user selector threw on proxy access
  }

  if (accessed.length > 0) {
    return accessed[accessed.length - 1];
  }

  // Fallback regex for unusual arrow functions
  const src = selector.toString();
  const match = src.match(/=>\s*[A-Za-z_$][A-Za-z0-9_$]*\.([A-Za-z_$][A-Za-z0-9_$.]*)/);
  return match?.[1];
}
