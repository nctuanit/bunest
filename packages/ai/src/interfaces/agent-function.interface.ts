import type { AiSchema } from "./ai-schema.interface";
import type { ModelMessage } from "./ai-types.interface";

/** Options for `@AgentFunction()`. */
export interface AgentFunctionOptions {
  /** The name the model calls the function by. Default: the method's name. */
  name?: string;
  /** Shown to the model so it knows when to call the function. */
  description?: string;
  /** Standard Schema with JSON Schema describing the arguments (object at the root). */
  inputSchema?: AiSchema;
  /** Scopes the caller must hold for the function to run. */
  scopes?: string[];
}

/** Context passed as the second argument of an `@AgentFunction()` method. */
export interface AgentFunctionContext<TRequest = any, TUser = any> {
  /** The agent function's name. */
  readonly name: string;
  /** The HTTP platform's request (`caller.request`), when the call runs in one. */
  readonly request?: TRequest;
  /** The user the agent acts for (`caller.user`). */
  readonly user?: TUser;
  /** The scopes the caller holds (`caller.scopes`). */
  readonly scopes?: readonly string[];
  /** Aborted when the call is cancelled or times out. */
  readonly signal: AbortSignal;
  /** Reports progress during a long-running tool call. */
  reportProgress(
    progress: number,
    total?: number,
    message?: string,
  ): Promise<void>;
  /** The model's identifier for this tool call. */
  readonly toolCallId: string;
  /** Stable idempotency key for durable workflow steps. */
  readonly idempotencyKey?: string;
  /** The messages sent to the model in this step. */
  readonly messages: readonly ModelMessage[];
}
