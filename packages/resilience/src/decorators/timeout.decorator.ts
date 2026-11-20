import type { Duration } from "../interfaces/duration.interface";
import type { EntrypointDecorator } from "../interfaces/entrypoint-options.interface";
import { TIMEOUT_METADATA } from "../resilience.constants";
import { withResilienceAspect } from "./resilience-decorator.util";

/**
 * Time budget per attempt. Without an argument, the duration comes from a
 * preset or a class-level `@Timeout()`, then from `defaults.timeout`. The
 * handler reads the matching `AbortSignal` with `@Signal()` (or `ResilienceContext.signal`
 * inside `@Injectable()` services). Answers 504 on HTTP.
 */
export const Timeout = (timeout?: Duration): EntrypointDecorator =>
  withResilienceAspect(TIMEOUT_METADATA, timeout ?? null);
