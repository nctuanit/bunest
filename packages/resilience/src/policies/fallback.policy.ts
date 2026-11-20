import type { AttemptContext } from "../interfaces/execute-options.interface";
import type {
  FallbackHandler,
  FallbackOptions,
} from "../interfaces/fallback-options.interface";
import { callPredicate } from "../utils/options.util";
import {
  call,
  isClientError,
  ResiliencePolicy,
  type Execution,
  type Next,
} from "./resilience.policy";

const defaultHandleIf = (error: unknown): boolean => !isClientError(error);

type InternalFallbackHandler<R> = (
  error: unknown,
  context: AttemptContext,
  invocation?: unknown,
) => unknown;

/**
 * Replaces a failure with the handler's result. Not applied when the caller
 * aborted, or when part of the result was already delivered.
 */
export class FallbackPolicy<R = unknown> extends ResiliencePolicy {
  private readonly handleIf: (error: unknown) => boolean;
  /** Entrypoint fallbacks also get Bunest's `ExecutionContext` (the execution's `invocation`). */
  private readonly handler: InternalFallbackHandler<R>;

  constructor(handler: FallbackHandler<R>, options: FallbackOptions = {}) {
    super(options.name ?? "fallback");
    this.handler = handler as InternalFallbackHandler<R>;
    this.handleIf = options.handleIf ?? defaultHandleIf;
  }

  /** @internal */
  override async run<T>(next: Next<T>, execution: Execution): Promise<T> {
    try {
      return await call(next, execution);
    } catch (error) {
      if (execution.signal.aborted || execution.committed()) {
        throw error;
      }
      if (!callPredicate("handleIf", this.handleIf, error)) {
        throw error;
      }
      this.emit({
        type: "fallback",
        policy: this.name,
        source: execution.source,
        error,
      });
      const value = this.handler(
        error,
        { signal: execution.signal, attempt: execution.attempt },
        execution.invocation,
      );
      return (await execution.adopt(value)) as T;
    }
  }
}
