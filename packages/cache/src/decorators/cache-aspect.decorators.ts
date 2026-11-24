import {
  Injectable,
  createMethodAspectDecorator,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/core";
import { CacheService } from "../cache.service";
import type { CacheSetOptions } from "../interfaces/cache.interface";

export type CacheAspectKeyResolver = string | ((...args: any[]) => string);

export type CacheAspectTagsResolver =
  readonly string[] | ((...args: any[]) => readonly string[]);

export interface CacheableOptions {
  /**
   * Static cache key or dynamic key factory receiving the method's arguments.
   * When omitted, derives a deterministic key from class name, method name, and arguments.
   */
  key?: CacheAspectKeyResolver;
  /**
   * Time-to-live in milliseconds.
   */
  ttl?: number;
  /**
   * Static invalidation tags or dynamic tag factory invoked with `(...args, result)`.
   */
  tags?: CacheAspectTagsResolver;
  /**
   * Predicate evaluated before lookup/execution. Returning `false` bypasses caching completely.
   */
  condition?: (...args: any[]) => boolean;
  /**
   * Predicate evaluated on the computed result. Returning `true` skips storing the result in cache.
   */
  unless?: (result: any) => boolean;
}

export interface CacheEvictOptions {
  /**
   * Exact key (or dynamic key factory) to evict.
   */
  key?: CacheAspectKeyResolver;
  /**
   * Key prefix (or dynamic prefix factory) to evict via `deleteByPrefix()`.
   */
  prefix?: string | ((...args: any[]) => string);
  /**
   * Invalidation tags (or dynamic tag factory) to evict via `invalidateTag()`.
   */
  tags?: CacheAspectTagsResolver;
  /**
   * When `true`, clears the entire cache store via `clear()`.
   */
  allEntries?: boolean;
  /**
   * When `true`, performs eviction before invoking the decorated method (even if it throws).
   * @default false
   */
  beforeInvocation?: boolean;
}

export interface CachePutOptions {
  /**
   * Static cache key or dynamic key factory receiving the method's arguments.
   */
  key?: CacheAspectKeyResolver;
  /**
   * Time-to-live in milliseconds.
   */
  ttl?: number;
  /**
   * Static invalidation tags or dynamic tag factory invoked with `(...args, result)`.
   */
  tags?: CacheAspectTagsResolver;
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const kind = typeof value;
  if (kind === "string") return JSON.stringify(value);
  if (kind === "number" || kind === "boolean") return String(value);
  if (kind === "bigint") return `${value}n`;
  if (kind === "symbol") return (value as symbol).toString();
  if (kind === "function") {
    return `[Function:${(value as Function).name || "anonymous"}]`;
  }
  if (value instanceof Date) {
    return `Date(${value.toISOString()})`;
  }
  if (value instanceof RegExp) {
    return `RegExp(${value.toString()})`;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableSerialize(
            (value as Record<string, unknown>)[k],
            seen,
          )}`,
      );
    return `{${entries.join(",")}}`;
  }
  return String(value);
}

function buildDefaultCacheKey(ctx: MethodAspectContext<unknown>): string {
  const clsName = ctx.targetClass.name || "Service";
  const method = String(ctx.methodName);
  if (ctx.args.length === 0) {
    return `${clsName}:${method}`;
  }
  return `${clsName}:${method}:${stableSerialize(ctx.args)}`;
}

function resolveKey(
  ctx: MethodAspectContext<unknown>,
  keyOption?: CacheAspectKeyResolver,
): string {
  if (typeof keyOption === "function") {
    return keyOption(...ctx.args);
  }
  if (typeof keyOption === "string" && keyOption.length > 0) {
    return keyOption;
  }
  return buildDefaultCacheKey(ctx);
}

function resolveTags(
  tagsOption: CacheAspectTagsResolver | undefined,
  args: readonly unknown[],
  hasResult: boolean,
  result?: unknown,
): readonly string[] | undefined {
  if (!tagsOption) {
    return undefined;
  }
  const resolved =
    typeof tagsOption === "function"
      ? hasResult
        ? tagsOption(...args, result)
        : tagsOption(...args)
      : tagsOption;
  return resolved && resolved.length > 0 ? [...resolved] : undefined;
}

function buildSetOptions(
  ttl: number | undefined,
  tags: readonly string[] | undefined,
): CacheSetOptions | number | undefined {
  if (tags && tags.length > 0) {
    return {
      ...(ttl !== undefined ? { ttlMs: ttl } : {}),
      tags,
    };
  }
  return ttl;
}

/**
 * Core Method Aspect handler backing `@Cacheable(...)` on `@Injectable()` services.
 */
@Injectable()
export class CacheableAspectHandler implements MethodAspectHandler<CacheableOptions> {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly cacheService: CacheService) {}

  async intercept(
    ctx: MethodAspectContext<CacheableOptions>,
  ): Promise<unknown> {
    const options = ctx.options ?? {};

    if (options.condition && !options.condition(...ctx.args)) {
      return await ctx.proceed();
    }

    const key = resolveKey(ctx, options.key);
    const cached = await this.cacheService.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending !== undefined) {
      return await pending;
    }

    const flight = (async () => {
      const result = await ctx.proceed();
      if (result !== undefined && !(options.unless && options.unless(result))) {
        const tags = resolveTags(options.tags, ctx.args, true, result);
        await this.cacheService.set(
          key,
          result,
          buildSetOptions(options.ttl, tags),
        );
      }
      return result;
    })();

    this.inFlight.set(key, flight);
    try {
      return await flight;
    } finally {
      this.inFlight.delete(key);
    }
  }
}

/**
 * Core Method Aspect handler backing `@CacheEvict(...)` on `@Injectable()` services.
 */
@Injectable()
export class CacheEvictAspectHandler implements MethodAspectHandler<CacheEvictOptions> {
  constructor(private readonly cacheService: CacheService) {}

  async intercept(
    ctx: MethodAspectContext<CacheEvictOptions>,
  ): Promise<unknown> {
    const options = ctx.options ?? {};

    if (options.beforeInvocation) {
      await this.performEviction(ctx, options, false);
      return await ctx.proceed();
    }

    const result = await ctx.proceed();
    await this.performEviction(ctx, options, true, result);
    return result;
  }

  private async performEviction(
    ctx: MethodAspectContext<CacheEvictOptions>,
    options: CacheEvictOptions,
    hasResult: boolean,
    result?: unknown,
  ): Promise<void> {
    let didEvict = false;

    if (options.allEntries) {
      await this.cacheService.clear();
      didEvict = true;
    }

    if (options.tags) {
      const tags = resolveTags(options.tags, ctx.args, hasResult, result);
      if (tags) {
        for (const tag of tags) {
          await this.cacheService.invalidateTag(tag);
        }
        didEvict = true;
      }
    }

    if (options.prefix !== undefined) {
      const prefix =
        typeof options.prefix === "function"
          ? options.prefix(...ctx.args)
          : options.prefix;
      await this.cacheService.deleteByPrefix(prefix);
      didEvict = true;
    }

    if (options.key !== undefined) {
      const key = resolveKey(ctx, options.key);
      await this.cacheService.del(key);
      didEvict = true;
    }

    if (!didEvict) {
      await this.cacheService.del(buildDefaultCacheKey(ctx));
    }
  }
}

/**
 * Core Method Aspect handler backing `@CachePut(...)` on `@Injectable()` services.
 */
@Injectable()
export class CachePutAspectHandler implements MethodAspectHandler<CachePutOptions> {
  constructor(private readonly cacheService: CacheService) {}

  async intercept(ctx: MethodAspectContext<CachePutOptions>): Promise<unknown> {
    const options = ctx.options ?? {};
    const result = await ctx.proceed();
    if (result !== undefined) {
      const key = resolveKey(ctx, options.key);
      const tags = resolveTags(options.tags, ctx.args, true, result);
      await this.cacheService.set(
        key,
        result,
        buildSetOptions(options.ttl, tags),
      );
    }
    return result;
  }
}

/**
 * Service-level read-through caching decorator backed by `CacheService` and
 * `@bunest/core`'s Method Aspect Weaver. Supports dynamic keys, TTL, invalidation
 * tags, `condition`, `unless`, and single-flight stampede deduplication.
 */
export function Cacheable(
  options: CacheableOptions | string = {},
): ClassDecorator & MethodDecorator {
  const normalized: CacheableOptions =
    typeof options === "string" ? { key: options } : options;
  return createMethodAspectDecorator(CacheableAspectHandler, normalized);
}

/**
 * Service-level cache eviction decorator backed by `CacheService`.
 * Supports key, prefix, tag, and full-store eviction, either after successful
 * invocation (default) or before invocation (`beforeInvocation: true`).
 */
export function CacheEvict(
  options: CacheEvictOptions | string = {},
): ClassDecorator & MethodDecorator {
  const normalized: CacheEvictOptions =
    typeof options === "string" ? { key: options } : options;
  return createMethodAspectDecorator(CacheEvictAspectHandler, normalized);
}

/**
 * Service-level write-through caching decorator that always executes the method
 * and updates the cache with its returned value.
 */
export function CachePut(
  options: CachePutOptions | string = {},
): ClassDecorator & MethodDecorator {
  const normalized: CachePutOptions =
    typeof options === "string" ? { key: options } : options;
  return createMethodAspectDecorator(CachePutAspectHandler, normalized);
}
