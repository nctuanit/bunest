import type { AiModelInfo } from '../interfaces/ai-types.interface';
import type { AiUsage } from '../interfaces/ai-usage.interface';

/** The base class of the package's errors. */
export class AiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A model name, an agent function or an option the package cannot use. Thrown at startup or when the call is made. */
export class AiConfigurationError extends AiError {}

/** One failed attempt of a model call. */
export interface AiAttemptFailure {
  model: AiModelInfo;
  attempt: number;
  error: unknown;
}

/** Every attempt of a model call failed, on every model tried. `cause` is the last error. */
export class AiModelError extends AiError {
  readonly attempts: AiAttemptFailure[];

  constructor(attempts: AiAttemptFailure[]) {
    const last = attempts[attempts.length - 1];
    const tried = [
      ...new Set(attempts.map((attempt) => describeModel(attempt.model))),
    ].join(', ');
    super(
      `The model call failed after ${attempts.length} attempt(s) (${tried}): ${messageOf(last?.error)}`,
      { cause: last?.error },
    );
    this.attempts = attempts;
  }
}

/** The call would have started a model call over its `budget`. */
export class AiBudgetExceededError extends AiError {
  readonly usage: AiUsage;
  readonly cost: number | undefined;
  readonly limit: { maxTokens?: number; maxCost?: number };

  constructor(
    usage: AiUsage,
    cost: number | undefined,
    limit: { maxTokens?: number; maxCost?: number },
  ) {
    const spent =
      limit.maxCost !== undefined && cost !== undefined
        ? `cost ${cost}`
        : `${usage.totalTokens} tokens`;
    super(
      `The call's budget is spent (${spent}), so it stopped before the next model call`,
    );
    this.usage = usage;
    this.cost = cost;
    this.limit = limit;
  }
}

/** The model's answer to `generateObject()` is not JSON, or does not match the schema. */
export class AiOutputError extends AiError {
  /** What the model answered. */
  readonly text: string;

  constructor(
    message: string,
    /** What the model answered. */
    text: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.text = text;
  }
}

/**
 * What the model is told about a tool call that failed: a guard's refusal (`Forbidden resource`),
 * an `HttpException`'s message, `Internal server error` for anything else.
 */
export class AiToolError extends AiError {
  readonly toolName: string;

  constructor(message: string, toolName: string, options?: ErrorOptions) {
    super(message, options);
    this.toolName = toolName;
  }

  /** The model reads `String(error)`: the message alone, not the class name. */
  override toString(): string {
    return this.message;
  }
}

export function describeModel(model: AiModelInfo): string {
  return model.name ?? `${model.provider}:${model.modelId}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
