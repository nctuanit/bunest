import { Inject, SetMetadata } from "@bunest/core";
import {
  SKIP_THROTTLE_METADATA,
  THROTTLE_METADATA,
  getOptionsToken,
  getStorageToken,
  type ThrottleDecoratorConfig,
} from "./throttler.interface";

/**
 * Overrides throttler limits (`{ ttl, limit }` or named map `{ short: { ttl, limit } }`)
 * on a controller class or route handler method.
 */
export const Throttle = (config: ThrottleDecoratorConfig) =>
  SetMetadata(THROTTLE_METADATA, config);

/**
 * Skips rate limiting on a controller or route handler method.
 * Pass `true` (default) to skip all throttlers, or a map `{ short: true }` for specific named throttlers.
 */
export const SkipThrottle = (skip: boolean | Record<string, boolean> = true) =>
  SetMetadata(SKIP_THROTTLE_METADATA, skip);

/**
 * Injects the configured `ThrottlerModuleOptions`.
 */
export const InjectThrottlerOptions = () => Inject(getOptionsToken());

/**
 * Injects the configured `ThrottlerStorage` service.
 */
export const InjectThrottlerStorage = () => Inject(getStorageToken());
