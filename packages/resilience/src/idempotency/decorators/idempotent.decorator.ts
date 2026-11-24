import { SetMetadata, type CustomDecorator } from "@bunest/core";
import { IDEMPOTENT_METADATA } from "../idempotency.constants";
import type { IdempotentOptions } from "../interfaces/idempotent-options.interface";
import { toMs, type Duration } from "../utils/duration.util";

/**
 * Makes retries of the decorated handler safe: calls that carry the same
 * idempotency key run the handler once, and every retry gets the stored
 * result. Works on HTTP routes, GraphQL mutations and microservice handlers.
 *
 * On a class, it covers every handler that changes state: not GET, HEAD or
 * OPTIONS routes, GraphQL queries or nested field resolvers, unless they
 * have their own `@Idempotent()`. Handler options are merged over the
 * class's, and both over the `IdempotencyModule` options, field by field.
 */
export const Idempotent = (
  options: IdempotentOptions = {},
): CustomDecorator<string> =>
  SetMetadata(
    IDEMPOTENT_METADATA,
    withDurationsInMs(options, "@Idempotent()"),
  ) as CustomDecorator<string>;

type DurationKey =
  "ttl" | "lockTtl" | "maxLockHold" | "retryAfter" | "storeTimeout";

/**
 * Validates and converts `ttl`, `lockTtl`, `maxLockHold`, `retryAfter` and
 * `storeTimeout` to milliseconds where they are declared, so a typo fails at
 * startup with the option's name. Rounded up to whole milliseconds: stores
 * pass them on as is, and Redis `PEXPIRE` rejects a fraction halfway through
 * a script, after its writes.
 */
export function withDurationsInMs<T extends IdempotentOptions>(
  options: T,
  where: string,
): T {
  const result: Record<string, unknown> = {
    ...(options as Record<string, unknown>),
  };
  const convert = (name: DurationKey, min: number): void => {
    const value = (options as Record<string, unknown>)[name];
    if (value === undefined) {
      return;
    }
    let ms: number;
    try {
      ms = Math.ceil(toMs(value as Duration));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TypeError(`${where}: invalid \`${name}\`. ${msg}`);
    }
    if (ms < min) {
      throw new TypeError(
        `${where}: \`${name}\` must be at least ${min} ms, got ${JSON.stringify(value)}.`,
      );
    }
    result[name] = ms;
  };
  convert("ttl", 1);
  convert("lockTtl", 1);
  convert("maxLockHold", 1);
  convert("retryAfter", 0);
  convert("storeTimeout", 1);
  return result as T;
}
