import type { CircuitBreakerOptions } from "../interfaces/circuit-breaker-options.interface";
import type { EntrypointDecorator } from "../interfaces/entrypoint-options.interface";
import { CIRCUIT_BREAKER_METADATA } from "../resilience.constants";
import { withResilienceAspect } from "./resilience-decorator.util";

/**
 * Circuit breaker, per handler or service method unless named. A per-method breaker is
 * registered under the method's name (`OrdersService.fetch`); see
 * `ResilienceService.circuitBreaker()`. A string refers to a named breaker
 * configured elsewhere. Answers 503 with `Retry-After` while open on HTTP.
 */
export const CircuitBreaker = (
  options: CircuitBreakerOptions | string = {},
): EntrypointDecorator =>
  withResilienceAspect(CIRCUIT_BREAKER_METADATA, options);
