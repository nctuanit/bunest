import { DecoratorRegistry, Injectable } from "../common/index";

/**
 * Reflection helper for discovering method names across a class prototype chain
 * (excluding `constructor`, getters, and setters).
 */
@Injectable()
export class MetadataScanner {
  /**
   * Returns all unique method names defined on `prototype` and its ancestors
   * (stopping before `Object.prototype`), preserving derived-first discovery order.
   */
  getAllMethodNames(prototype: object | null | undefined): string[] {
    if (!prototype || typeof prototype !== "object") {
      return [];
    }

    const seen = new Set<string>();
    const names: string[] = [];
    let current: object | null = prototype;

    while (current && current !== Object.prototype) {
      for (const propName of Object.getOwnPropertyNames(current)) {
        if (propName === "constructor" || seen.has(propName)) {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, propName);
        if (descriptor && typeof descriptor.value === "function") {
          seen.add(propName);
          names.push(propName);
        }
      }
      current = Object.getPrototypeOf(current) as object | null;
    }

    return names;
  }

  /**
   * Generator variant matching NestJS `MetadataScanner.getAllFilteredMethodNames()`.
   */
  *getAllFilteredMethodNames(
    prototype: object | null | undefined,
  ): IterableIterator<string> {
    for (const name of this.getAllMethodNames(prototype)) {
      yield name;
    }
  }

  /**
   * Iterates every method name on `prototype`, invoking `callback(name)` and
   * returning all non-nullish results.
   */
  scanFromPrototype<T extends object, R = unknown>(
    _instance: T,
    prototype: object | null | undefined,
    callback: (name: string) => R,
  ): Array<NonNullable<R>> {
    const methodNames = this.getAllMethodNames(prototype);
    const results: Array<NonNullable<R>> = [];

    for (const name of methodNames) {
      const value = callback(name);
      if (value !== undefined && value !== null) {
        results.push(value as NonNullable<R>);
      }
    }

    return results;
  }
}

DecoratorRegistry.markInternal(MetadataScanner);
