import { Injectable } from "@bunest/common";
import type { JobHandler } from "../interfaces";

/**
 * Instrumentation hook allowing applications (e.g., OpenTelemetry tracing or
 * metrics wrappers) to wrap worker processor functions before execution.
 */
@Injectable()
export class ProcessorDecoratorService {
  /**
   * Decorates a processor function.
   * Override this provider in your module to wrap every processor invocation.
   */
  decorate<TData = any, TResult = any>(
    processor: JobHandler<TData, TResult>,
  ): JobHandler<TData, TResult> {
    return processor;
  }
}
