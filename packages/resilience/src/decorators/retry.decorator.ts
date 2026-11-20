import type {
  EntrypointDecorator,
  EntrypointRetryOptions,
} from "../interfaces/entrypoint-options.interface";
import { normalizeRetry } from "../policies/retry.policy";
import { RETRY_METADATA } from "../resilience.constants";
import { withResilienceAspect } from "./resilience-decorator.util";

/**
 * Re-runs the handler or service method when it fails. A number is shorthand for
 * `{ attempts }`, and `false` turns off a retry the method would otherwise inherit.
 *
 * On HTTP, only GET, HEAD and OPTIONS are retried, and on GraphQL only
 * queries, unless you set `idempotent: true`. On `@Injectable()` service methods,
 * retries execute automatically via Bunest's Core Method Aspect weaver.
 */
export const Retry = (
  options: number | false | EntrypointRetryOptions = {},
): EntrypointDecorator =>
  withResilienceAspect(RETRY_METADATA, normalizeRetry(options));
