import type {
  EntrypointDecorator,
  EntrypointFallbackFn,
  FallbackDecoratorOptions,
  FallbackMetadata,
  FallbackMethodDecorator,
} from "../interfaces/entrypoint-options.interface";
import { FALLBACK_METADATA } from "../resilience.constants";
import { withResilienceAspect } from "./resilience-decorator.util";

/**
 * Returns the fallback's result instead of failing: the name of a method on
 * the same class (TypeScript checks that it exists), or a function. Both are
 * called with `(error, executionContext)` (or `(error, aspectContext)` on services).
 *
 * Not applied to client errors (`isClientError()`), nor once the response was committed.
 */
export function Fallback<K extends string>(
  method: K,
  options?: FallbackDecoratorOptions,
): FallbackMethodDecorator<K>;
export function Fallback(
  fn: EntrypointFallbackFn,
  options?: FallbackDecoratorOptions,
): EntrypointDecorator;
export function Fallback(
  target: string | EntrypointFallbackFn,
  options: FallbackDecoratorOptions = {},
): EntrypointDecorator {
  const metadata: FallbackMetadata =
    typeof target === "function"
      ? { fn: target, handleIf: options.handleIf }
      : { method: target, handleIf: options.handleIf };
  return withResilienceAspect(FALLBACK_METADATA, metadata);
}
