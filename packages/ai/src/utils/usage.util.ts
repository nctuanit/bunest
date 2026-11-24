import type { AiModelPricing } from "../interfaces/ai-module-options.interface";
import type { AiUsage } from "../interfaces/ai-usage.interface";

export const ZERO_USAGE: AiUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
});

/** Normalizes provider/AI SDK usage into `AiUsage`, with omitted counts as 0. */
export function toUsage(usage: Record<string, any> | undefined): AiUsage {
  if (!usage) return { ...ZERO_USAGE };
  const inputTokens =
    typeof usage.inputTokens === "object" && usage.inputTokens !== null
      ? (usage.inputTokens.total ?? 0)
      : (usage.inputTokens ?? usage.promptTokens ?? 0);
  const outputTokens =
    typeof usage.outputTokens === "object" && usage.outputTokens !== null
      ? (usage.outputTokens.total ?? 0)
      : (usage.outputTokens ?? usage.completionTokens ?? 0);
  const cachedInputTokens =
    (typeof usage.inputTokens === "object" && usage.inputTokens !== null
      ? usage.inputTokens.cacheRead
      : undefined) ??
    usage.inputTokenDetails?.cacheReadTokens ??
    usage.cachedInputTokens ??
    0;
  const reasoningTokens =
    (typeof usage.outputTokens === "object" && usage.outputTokens !== null
      ? usage.outputTokens.reasoning
      : undefined) ??
    usage.outputTokenDetails?.reasoningTokens ??
    usage.reasoningTokens ??
    0;
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      typeof usage.totalTokens === "number"
        ? usage.totalTokens
        : inputTokens + outputTokens,
    cachedInputTokens,
    reasoningTokens,
  };
}

export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/** The cost of `usage` at `pricing` (per million tokens); `undefined` without pricing. */
export function costOf(
  usage: AiUsage,
  pricing: AiModelPricing | undefined,
): number | undefined {
  if (!pricing) {
    return undefined;
  }
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const cost =
    (usage.inputTokens - cached) * pricing.input +
    cached * (pricing.cachedInput ?? pricing.input) +
    usage.outputTokens * pricing.output;
  return cost / 1_000_000;
}

export function addCost(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}
