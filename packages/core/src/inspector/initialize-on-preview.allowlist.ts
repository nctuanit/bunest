import type { InjectionToken } from "@bunest/common";

/**
 * Allowlist of module or provider tokens permitted to instantiate even when
 * `preview: true` mode is active (matching NestJS `InitializeOnPreviewAllowlist`).
 */
export class InitializeOnPreviewAllowlist {
  private static readonly allowlist = new WeakMap<object, boolean>();
  private static readonly primitiveAllowlist = new Set<string | symbol>();

  static add(item: InjectionToken): void {
    if (
      (typeof item === "object" && item !== null) ||
      typeof item === "function"
    ) {
      InitializeOnPreviewAllowlist.allowlist.set(item as object, true);
    } else if (typeof item === "string" || typeof item === "symbol") {
      InitializeOnPreviewAllowlist.primitiveAllowlist.add(item);
    }
  }

  static has(item: InjectionToken): boolean {
    return InitializeOnPreviewAllowlist.get(item);
  }

  static get(item: InjectionToken): boolean {
    if (
      (typeof item === "object" && item !== null) ||
      typeof item === "function"
    ) {
      return InitializeOnPreviewAllowlist.allowlist.get(item as object) === true;
    }
    if (typeof item === "string" || typeof item === "symbol") {
      return InitializeOnPreviewAllowlist.primitiveAllowlist.has(item);
    }
    return false;
  }

  static clear(): void {
    InitializeOnPreviewAllowlist.primitiveAllowlist.clear();
  }
}
