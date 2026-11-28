import type { StandardSchemaV1 } from "@bunest/core";
import type { Job, JobOptions } from "./interfaces";

export const JOB_CONTRACT_SYMBOL = Symbol.for("bunest:jobs:job-contract");

export interface JobContractOptions<TPayload = unknown> {
  /**
   * Optional Standard Schema v1 validator (e.g. `@bunest/validation`'s `s.object(...)`,
   * Zod, Valibot, ArkType) run automatically in `queue.addContract()` before enqueuing.
   */
  readonly schema?: StandardSchemaV1<any, TPayload>;
  /**
   * Default `JobOptions` merged whenever jobs are enqueued via `queue.addContract()`.
   */
  readonly defaultOptions?: JobOptions;
}

/**
 * Type-safe job contract shared between producers (`queue.addContract(contract, data)`)
 * and workers (`@Process(contract)`).
 */
export interface JobContract<
  TName extends string = string,
  TPayload = unknown,
  TResult = unknown,
> {
  readonly [JOB_CONTRACT_SYMBOL]: true;
  readonly name: TName;
  readonly schema?: StandardSchemaV1<any, TPayload>;
  readonly defaultOptions?: JobOptions;
  /** Phantom type carrier for payload inference. */
  readonly __payload?: TPayload;
  /** Phantom type carrier for result inference. */
  readonly __result?: TResult;
}

/** Extracts the payload type `TPayload` from a `JobContract`. */
export type JobPayload<TContract> =
  TContract extends JobContract<string, infer TPayload, any> ? TPayload : never;

/** Extracts the result type `TResult` from a `JobContract`. */
export type JobResult<TContract> =
  TContract extends JobContract<string, any, infer TResult> ? TResult : never;

/** Typed `Job<TPayload, TResult>` corresponding to a `JobContract`. */
export type JobOf<TContract> =
  TContract extends JobContract<string, infer TPayload, infer TResult>
    ? Job<TPayload, TResult>
    : never;

export function isJobContract(
  value: unknown,
): value is JobContract<string, unknown, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[JOB_CONTRACT_SYMBOL] === true &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

/**
 * Defines a strongly-typed queue job contract usable across both
 * `queue.addContract(contract, payload)` and `@Process(contract)`.
 */
export function defineJobContract<
  TPayload = unknown,
  TResult = unknown,
  TName extends string = string,
>(
  name: TName,
  options?: JobContractOptions<TPayload>,
): JobContract<TName, TPayload, TResult> {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("defineJobContract() requires a non-empty string job name.");
  }
  if (name === "*") {
    throw new Error(
      'defineJobContract() cannot use "*" as a job name because "*" is reserved for catch-all handlers.',
    );
  }
  const defaultOpts = options?.defaultOptions;
  let frozenDefaultOptions: JobOptions | undefined;
  if (defaultOpts) {
    frozenDefaultOptions = Object.freeze({
      ...defaultOpts,
      ...(defaultOpts.metadata
        ? { metadata: Object.freeze({ ...defaultOpts.metadata }) }
        : {}),
    });
  }
  return Object.freeze({
    [JOB_CONTRACT_SYMBOL]: true as const,
    name,
    ...(options?.schema ? { schema: options.schema } : {}),
    ...(frozenDefaultOptions ? { defaultOptions: frozenDefaultOptions } : {}),
  });
}
