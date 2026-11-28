import type { StandardSchemaV1 } from "@bunest/core";
import { WorkerValidationException } from "./errors";
import type { WorkerContractLike, WorkerRunOptions } from "./interfaces";

export const WORKER_CONTRACT_SYMBOL = Symbol.for("bunest:workers:contract");

export interface WorkerContractOptions<TInput = unknown, TOutput = unknown> {
  /**
   * Optional Standard Schema v1 validator run automatically before dispatching
   * a payload to the worker thread (e.g. `@bunest/validation`'s `s.object(...)`,
   * Zod, Valibot, ArkType).
   */
  readonly inputSchema?: StandardSchemaV1<any, TInput>;

  /**
   * Optional Standard Schema v1 validator run on the output returned by the worker.
   */
  readonly outputSchema?: StandardSchemaV1<any, TOutput>;

  /**
   * Default `WorkerRunOptions` merged on every `pool.run(contract, payload)` call.
   */
  readonly defaultOptions?: WorkerRunOptions;
}

/**
 * Strongly-typed task contract shared between main-thread callers (`pool.run(contract, input)`)
 * and worker implementations (`defineWorker(...)` / `@WorkerHandler(contract)`).
 */
export interface WorkerContract<
  TName extends string = string,
  TInput = unknown,
  TOutput = unknown,
> extends WorkerContractLike<TName, TInput, TOutput> {
  readonly [WORKER_CONTRACT_SYMBOL]: true;
  readonly name: TName;
  readonly inputSchema?: StandardSchemaV1<any, TInput>;
  readonly outputSchema?: StandardSchemaV1<any, TOutput>;
  readonly defaultOptions?: WorkerRunOptions;
  readonly __input?: TInput;
  readonly __output?: TOutput;
}

/** Extracts the input type `TInput` from a `WorkerContract`. */
export type WorkerContractInput<TContract> =
  TContract extends WorkerContract<string, infer TInput, any> ? TInput : never;

/** Extracts the output type `TOutput` from a `WorkerContract`. */
export type WorkerContractOutput<TContract> =
  TContract extends WorkerContract<string, any, infer TOutput>
    ? TOutput
    : never;

export function isWorkerContract(
  value: unknown,
): value is WorkerContract<string, unknown, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[WORKER_CONTRACT_SYMBOL] === true &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

/**
 * Defines a strongly-typed Bun Worker task contract with optional Standard Schema
 * validation for both input and output payloads.
 */
export function defineWorkerContract<
  TInput = unknown,
  TOutput = unknown,
  TName extends string = string,
>(
  name: TName,
  options?: WorkerContractOptions<TInput, TOutput>,
): WorkerContract<TName, TInput, TOutput> {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(
      "defineWorkerContract() requires a non-empty string task name.",
    );
  }
  if (name === "*") {
    throw new Error(
      'defineWorkerContract() cannot use "*" as a task name because "*" is reserved for catch-all handlers.',
    );
  }

  const frozenDefaults = options?.defaultOptions
    ? Object.freeze({ ...options.defaultOptions })
    : undefined;

  return Object.freeze({
    [WORKER_CONTRACT_SYMBOL]: true as const,
    name,
    ...(options?.inputSchema ? { inputSchema: options.inputSchema } : {}),
    ...(options?.outputSchema ? { outputSchema: options.outputSchema } : {}),
    ...(frozenDefaults ? { defaultOptions: frozenDefaults } : {}),
  });
}

export async function validateWithStandardSchema<T>(
  taskName: string,
  schema: StandardSchemaV1<any, T>,
  value: unknown,
): Promise<T> {
  const result = await schema["~standard"].validate(value);
  if ("issues" in result && result.issues) {
    const issues = result.issues.map((issue) => ({
      message: issue.message,
      ...(issue.path
        ? {
            path: issue.path.map((segment) =>
              typeof segment === "object" &&
              segment !== null &&
              "key" in segment
                ? (segment as { key: PropertyKey }).key
                : (segment as PropertyKey),
            ),
          }
        : {}),
    }));
    throw new WorkerValidationException(taskName, issues);
  }
  return result.value;
}
