import type { AiModelInfo } from './ai-types.interface';

/** Tokens a model call used. A count the provider did not report is 0. */
export interface AiUsage {
  /** Every input token, cached ones included. */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** The part of `inputTokens` read from the provider's prompt cache. */
  cachedInputTokens: number;
  /** The part of `outputTokens` spent on reasoning. */
  reasoningTokens: number;
}

/** One model call that answered. */
export interface AiUsageEvent {
  /** The call's `label`. */
  label?: string;
  model: AiModelInfo;
  /** 0-based step of the call. */
  step: number;
  /** 1-based attempt of this model for this step. */
  attempt: number;
  /** Whether it was a fallback model. */
  fallback: boolean;
  stream: boolean;
  usage: AiUsage;
  /** In the unit of the model's `pricing`; `undefined` without one. */
  cost?: number;
  durationMs: number;
  finishReason: string;
}
