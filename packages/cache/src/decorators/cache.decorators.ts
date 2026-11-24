import { SetMetadata, type CustomDecorator } from "@bunest/core";
import {
  CACHE_KEY_METADATA,
  CACHE_TTL_METADATA,
  NO_CACHE_METADATA,
} from "../constants";
import type {
  CacheKeyMetadataValue,
  CacheTtlMetadataValue,
} from "../interfaces/cache.interface";

/**
 * Overrides the HTTP cache key for a controller or route handler method.
 * Accepts a static key string or a dynamic `(context: ExecutionContext) => string | Promise<string | undefined>` function.
 */
export function CacheKey(
  key: CacheKeyMetadataValue,
): CustomDecorator<typeof CACHE_KEY_METADATA> {
  return SetMetadata(CACHE_KEY_METADATA, key);
}

/**
 * Overrides the HTTP cache TTL (in milliseconds) for a controller or route handler method.
 * Accepts either a static number (ms) or a `CacheTTLFactory` function `(ctx: ExecutionContext) => number | Promise<number>`.
 */
export function CacheTTL(
  ttl: CacheTtlMetadataValue,
): CustomDecorator<typeof CACHE_TTL_METADATA> {
  return SetMetadata(CACHE_TTL_METADATA, ttl);
}

/**
 * Disables HTTP response caching for a controller or route handler method.
 */
export function NoCache(): CustomDecorator<typeof NO_CACHE_METADATA> {
  return SetMetadata(NO_CACHE_METADATA, true);
}
