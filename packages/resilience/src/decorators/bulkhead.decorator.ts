import type { BulkheadOptions } from "../interfaces/bulkhead-options.interface";
import type { EntrypointDecorator } from "../interfaces/entrypoint-options.interface";
import { BULKHEAD_METADATA } from "../resilience.constants";
import { withResilienceAspect } from "./resilience-decorator.util";

/**
 * Concurrency limit, per handler or service method unless named. A per-method bulkhead is
 * registered under the method's name (`OrdersService.process`); see
 * `ResilienceService.bulkhead()`. A string refers to a named bulkhead
 * configured elsewhere. Answers 503 when full on HTTP.
 */
export const Bulkhead = (
  options: BulkheadOptions | string = {},
): EntrypointDecorator => withResilienceAspect(BULKHEAD_METADATA, options);
