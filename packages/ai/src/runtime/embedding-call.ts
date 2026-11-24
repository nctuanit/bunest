import type { ResiliencePolicy } from "@bunest/resilience";
import type {
  AiEmbeddingCallOptions,
  AiEmbeddingSettings,
  AiEmbeddingUsageEvent,
} from "../interfaces/ai-embedding.interface";
import type { AiModuleOptions } from "../interfaces/ai-module-options.interface";
import type { EmbeddingModelResult } from "../interfaces/ai-types.interface";
import type {
  AiEmbeddingModels,
  ResolvedEmbeddingModel,
} from "../models/ai-embedding-models.service";
import { AiConfigurationError } from "../errors/ai.errors";
import { resolveEmbeddingModel } from "../providers/http-provider";
import { modelPolicy, runStep, type PolicyPlan } from "./model-policy";

const NEVER_ABORTED = new AbortController().signal;
const DEFAULT_MAX_PARALLEL_CALLS = 4;

/** One operation's state. */
export interface EmbeddingPlan extends PolicyPlan<ResolvedEmbeddingModel> {
  model: ResolvedEmbeddingModel;
  label?: string;
  settings: Pick<AiEmbeddingSettings, "headers" | "providerOptions"> & {
    maxParallelCalls: number;
  };
  listeners: Array<(event: AiEmbeddingUsageEvent) => void | Promise<void>>;
}

/**
 * Resolves only embedding settings: language generation defaults never reach an embedding provider.
 */
export function createEmbeddingPlan(
  options: AiEmbeddingCallOptions,
  models: AiEmbeddingModels,
  moduleOptions: AiModuleOptions,
  preset: (name: string) => ResiliencePolicy,
): EmbeddingPlan {
  if (typeof options !== "object" || options === null) {
    throw new AiConfigurationError(
      "Pass the embedding call its options: { value } or { values }, and the rest.",
    );
  }
  const model = models.resolve(options.model);
  const defaults = moduleOptions.embeddingDefaults ?? {};
  const pick = <K extends keyof AiEmbeddingSettings>(
    key: K,
  ): AiEmbeddingSettings[K] =>
    options[key] ?? model.settings[key] ?? defaults[key];

  const maxParallelCalls =
    pick("maxParallelCalls") ?? DEFAULT_MAX_PARALLEL_CALLS;
  if (!Number.isSafeInteger(maxParallelCalls) || maxParallelCalls < 1) {
    throw new AiConfigurationError(
      "`maxParallelCalls` must be a finite positive whole number.",
    );
  }

  const own = pick("resilience");
  const policy =
    own === undefined
      ? modelPolicy(
          model,
          { retry: pick("retry"), timeout: pick("timeout") },
          "ai:embedding",
        )
      : typeof own === "string"
        ? preset(own)
        : own;

  return {
    model,
    chain: [model],
    signal: options.abortSignal ?? NEVER_ABORTED,
    source: options.label ?? "AiService",
    fallbackIf: () => false,
    policyFor: () => policy,
    ...(options.label !== undefined && { label: options.label }),
    settings: {
      maxParallelCalls,
      ...(pick("headers") !== undefined && { headers: pick("headers") }),
      ...(pick("providerOptions") !== undefined && {
        providerOptions: pick("providerOptions"),
      }),
    },
    listeners: [
      moduleOptions.onEmbeddingUsage,
      options.onEmbeddingUsage,
    ].filter(
      (
        listener,
      ): listener is (event: AiEmbeddingUsageEvent) => void | Promise<void> =>
        typeof listener === "function",
    ),
  };
}

export interface EmbedSingleResult {
  value: string;
  embedding: number[];
  usage: { tokens: number };
  warnings: unknown[];
  response?: { headers?: Record<string, string>; body?: unknown };
  providerMetadata?: Record<string, Record<string, unknown>>;
}

export interface EmbedManyResult {
  values: string[];
  embeddings: number[][];
  usage: { tokens: number };
  warnings: unknown[];
  responses?: Array<{ headers?: Record<string, string>; body?: unknown }>;
  providerMetadata?: Record<string, Record<string, unknown>>;
}

/** Runs a single or batch embedding operation under the plan's resilience policy with bounded concurrency. */
export async function runEmbedding(
  plan: EmbeddingPlan,
  input: { value: string },
): Promise<{
  result: EmbedSingleResult;
  event: AiEmbeddingUsageEvent;
  attempts: number;
  cost?: number;
}>;
export async function runEmbedding(
  plan: EmbeddingPlan,
  input: { values: string[] },
): Promise<{
  result: EmbedManyResult;
  event: AiEmbeddingUsageEvent;
  attempts: number;
  cost?: number;
}>;
export async function runEmbedding(
  plan: EmbeddingPlan,
  input: { value: string } | { values: string[] },
): Promise<{
  result: EmbedSingleResult | EmbedManyResult;
  event: AiEmbeddingUsageEvent;
  attempts: number;
  cost?: number;
}> {
  const started = performance.now();
  const many = "values" in input;
  if (
    many
      ? !Array.isArray(input.values) ||
        input.values.some((v) => typeof v !== "string")
      : typeof input.value !== "string"
  ) {
    throw new AiConfigurationError(
      many
        ? "`values` must be an array of strings."
        : "`value` must be a string.",
    );
  }

  const values = many ? [...input.values] : [input.value];
  const controller = new AbortController();
  const signal = AbortSignal.any([plan.signal, controller.signal]);
  const modelObj = resolveEmbeddingModel(plan.model.model);

  let attempts = 0;
  let result: EmbedSingleResult | EmbedManyResult;

  try {
    signal.throwIfAborted();
    if (!many) {
      const { value: res, attempts: used } = await runStep<
        EmbeddingModelResult,
        ResolvedEmbeddingModel
      >(
        { ...plan, signal },
        async (attempt) => {
          attempt.signal.throwIfAborted();
          return (await modelObj.doEmbed({
            values,
            ...(plan.settings.headers !== undefined && {
              headers: plan.settings.headers,
            }),
            ...(plan.settings.providerOptions !== undefined && {
              providerOptions: plan.settings.providerOptions,
            }),
            abortSignal: attempt.signal,
          })) as EmbeddingModelResult;
        },
      );
      attempts += used;
      signal.throwIfAborted();
      const tokens = res.usage?.tokens ?? 0;
      result = {
        value: input.value,
        embedding: res.embeddings?.[0] ?? [],
        usage: { tokens },
        warnings: res.warnings ?? [],
        ...(res.response !== undefined && { response: res.response }),
        ...(res.providerMetadata !== undefined && {
          providerMetadata: res.providerMetadata,
        }),
      };
    } else if (values.length === 0) {
      result = {
        values: [],
        embeddings: [],
        usage: { tokens: 0 },
        warnings: [],
        responses: [],
      };
    } else {
      const maxPerCallRaw = await Promise.resolve(
        modelObj.maxEmbeddingsPerCall,
      );
      const maxPerCall =
        typeof maxPerCallRaw === "number" && maxPerCallRaw > 0
          ? maxPerCallRaw
          : values.length;
      const supportsParallel =
        (await Promise.resolve(modelObj.supportsParallelCalls)) !== false;
      const concurrency = supportsParallel
        ? Math.max(1, plan.settings.maxParallelCalls)
        : 1;

      const chunks: string[][] = [];
      for (let i = 0; i < values.length; i += maxPerCall) {
        chunks.push(values.slice(i, i + maxPerCall));
      }

      const chunkResults = new Array<EmbeddingModelResult>(chunks.length);
      let cursor = 0;

      const runWorker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= chunks.length) break;
          signal.throwIfAborted();
          const batch = chunks[idx]!;
          const { value: res, attempts: used } = await runStep<
            EmbeddingModelResult,
            ResolvedEmbeddingModel
          >(
            { ...plan, signal },
              async (attempt) => {
                attempt.signal.throwIfAborted();
                return (await modelObj.doEmbed({
                  values: batch,
                  ...(plan.settings.headers !== undefined && {
                    headers: plan.settings.headers,
                  }),
                  ...(plan.settings.providerOptions !== undefined && {
                    providerOptions: plan.settings.providerOptions,
                  }),
                  abortSignal: attempt.signal,
                })) as EmbeddingModelResult;
              },
            );
          attempts += used;
          chunkResults[idx] = res;
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, chunks.length) }, () =>
          runWorker(),
        ),
      );
      signal.throwIfAborted();

      const embeddings: number[][] = [];
      const warnings: unknown[] = [];
      const responses: Array<{ headers?: Record<string, string>; body?: unknown }> =
        [];
      let totalTokens = 0;
      let providerMetadata:
        | Record<string, Record<string, unknown>>
        | undefined;

      for (const res of chunkResults) {
        embeddings.push(...(res.embeddings ?? []));
        warnings.push(...(res.warnings ?? []));
        if (res.response !== undefined) responses.push(res.response);
        totalTokens += res.usage?.tokens ?? 0;
        if (res.providerMetadata !== undefined) {
          providerMetadata = { ...providerMetadata, ...res.providerMetadata };
        }
      }

      result = {
        values,
        embeddings,
        usage: { tokens: totalTokens },
        warnings,
        ...(responses.length > 0 && { responses }),
        ...(providerMetadata !== undefined && { providerMetadata }),
      };
    }
  } finally {
    controller.abort();
  }

  const pricing = plan.model.pricing;
  const cost =
    pricing && Number.isFinite(result.usage.tokens)
      ? (result.usage.tokens * pricing.input) / 1_000_000
      : undefined;

  return {
    result,
    attempts,
    ...(cost !== undefined && { cost }),
    event: {
      operation: many ? "embedMany" : "embed",
      ...(plan.label !== undefined && { label: plan.label }),
      model: plan.model.info,
      inputCount: values.length,
      usage: { tokens: result.usage.tokens },
      attempts,
      durationMs: Math.round(performance.now() - started),
      ...(cost !== undefined && { cost }),
    },
  };
}
