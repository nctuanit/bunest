import type { Subscribable } from "@bunest/core";
import type { AttemptContext } from "./execute-options.interface";

/** Returns what the call should have returned: a value, a Promise or a Subscribable. */
export type FallbackHandler<R = unknown> = (
  error: unknown,
  context: AttemptContext,
) => R | PromiseLike<R> | Subscribable<R>;

export interface FallbackOptions {
  /** Labels its events. */
  name?: string;
  /** Which errors the fallback replaces. Default: all but client errors (`isClientError()`). */
  handleIf?: (error: unknown) => boolean;
}
