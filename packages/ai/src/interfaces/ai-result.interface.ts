import type { AiModelInfo, ModelMessage } from './ai-types.interface';
import type { AiUsage } from './ai-usage.interface';

export type { AiModelInfo, ModelMessage };

export interface AiToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface AiToolResult extends AiToolCall {
  /** What the tool returned; absent when it failed. */
  output?: unknown;
  /** What the model was told about a failure. */
  error?: string;
}

/** One model call of a text generation. */
export interface AiStep {
  index: number;
  model: AiModelInfo;
  text: string;
  toolCalls: AiToolCall[];
  toolResults: AiToolResult[];
  finishReason: string;
  usage: AiUsage;
  cost?: number;
  /** Attempts made for this step. */
  attempts: number;
}

export interface AiTextResult {
  /** The text of the last step. */
  text: string;
  /** The last step's finish reason. */
  finishReason: string;
  steps: AiStep[];
  /** Summed over the steps. */
  usage: AiUsage;
  /** Summed cost; `undefined` when no model had pricing. */
  cost?: number;
  toolCalls: AiToolCall[];
  toolResults: AiToolResult[];
  /** The messages of every step, to append to a conversation. */
  responseMessages: ModelMessage[];
  /** The model of the last step. */
  model: AiModelInfo;
}

export interface AiObjectResult<T> extends AiTextResult {
  /** The answer, validated by the schema. */
  object: T;
}
