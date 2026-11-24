import type { ResiliencePolicy } from "@bunest/resilience";
import type {
  AiCallOptions,
  AiModelReference,
  AiToolChoice,
} from "../interfaces/ai-call-options.interface";
import type {
  AiBudget,
  AiModuleOptions,
} from "../interfaces/ai-module-options.interface";
import type { AiCaller } from "../interfaces/ai-tool.interface";
import type { ModelMessage } from "../interfaces/ai-types.interface";
import type { AiUsageEvent } from "../interfaces/ai-usage.interface";
import type { AiModels, ResolvedModel } from "../models/ai-models.service";
import type { AiTools } from "../tools/ai-tools.service";
import { AiConfigurationError } from "../errors/ai.errors";
import { modelPolicy, type PolicyPlan, type StepAttempt } from "./model-policy";

const DEFAULT_MAX_STEPS = 10;

/** The generation settings of one model call. */
export interface GenerationSettings {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
  headers?: Record<string, string | undefined>;
}

/** Everything a call needs, resolved once. Internal. */
export interface CallPlan extends PolicyPlan {
  label?: string;
  maxSteps: number;
  budget?: AiBudget;
  instructions?: string;
  messages: ModelMessage[];
  tools?: ReturnType<AiTools["select"]>;
  toolChoice?: AiToolChoice;
  caller: AiCaller;
  listeners: Array<(event: AiUsageEvent) => void | Promise<void>>;
  settingsFor(model: ResolvedModel): GenerationSettings;
  /** The attempt whose tools may run. */
  running?: StepAttempt;
}

/**
 * Resolves a call's options. Mistakes (unknown model or agent function, both `prompt` and `messages`)
 * throw synchronously before anything is sent.
 */
export function createCallPlan(
  options: AiCallOptions,
  {
    models,
    tools,
    moduleOptions,
    signal,
    preset,
    toolExecution = true,
  }: {
    models: AiModels;
    tools: AiTools;
    moduleOptions: AiModuleOptions;
    signal: AbortSignal;
    preset: (name: string) => ResiliencePolicy;
    toolExecution?: boolean;
  },
): CallPlan {
  if (typeof options !== "object" || options === null) {
    throw new AiConfigurationError(
      "Pass the call its options: { prompt } or { messages }, and the rest.",
    );
  }
  const defaults = moduleOptions.defaults ?? {};
  const primary = models.resolve(options.model);
  const chain = [
    primary,
    ...fallbacks(options.fallback, primary, models),
  ].filter(
    (model, index, all) =>
      all.findIndex((other) => other.model === model.model) === index,
  );
  const caller: AiCaller = { ...options.caller };
  const plan = {} as CallPlan;

  const onExecute = () => plan.running?.commit();
  const onProgress = (progress: {
    toolCallId: string;
    toolName: string;
    progress: number;
    total?: number;
    message?: string;
  }) =>
    plan.running?.emit({
      type: "data-tool-progress",
      id: progress.toolCallId,
      data: progress,
      transient: true,
    });

  const selected = options.tools?.length
    ? tools.select(options.tools, {
        caller,
        onExecute,
        onProgress,
        execute: toolExecution,
      })
    : undefined;

  const maxSteps = options.maxSteps ?? defaults.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new AiConfigurationError(
      `\`maxSteps\` must be a whole number of at least 1. Got ${String(maxSteps)}.`,
    );
  }

  const policies = new Map<ResolvedModel, ResiliencePolicy | undefined>();
  const pick = <K extends keyof GenerationSettings>(
    model: ResolvedModel,
    key: K,
  ): GenerationSettings[K] =>
    (options as Partial<GenerationSettings>)[key] ??
    (model.settings as Partial<GenerationSettings>)[key] ??
    (defaults as Partial<GenerationSettings>)[key];

  return Object.assign(plan, {
    ...(options.label !== undefined && { label: options.label }),
    chain,
    signal,
    maxSteps,
    ...((options.budget ?? defaults.budget) && {
      budget: options.budget ?? defaults.budget,
    }),
    ...(options.instructions !== undefined && {
      instructions: options.instructions,
    }),
    messages: messagesOf(options),
    ...(selected && { tools: selected }),
    ...(options.toolChoice !== undefined && { toolChoice: options.toolChoice }),
    caller,
    listeners: [moduleOptions.onUsage, options.onUsage].filter(
      (listener): listener is (event: AiUsageEvent) => void | Promise<void> =>
        typeof listener === "function",
    ),
    source: options.label ?? "AiService",
    fallbackIf: options.fallbackIf ?? (() => true),
    policyFor: (model: ResolvedModel) => {
      let policy = policies.get(model);
      if (!policies.has(model)) {
        const own =
          options.resilience ??
          model.settings.resilience ??
          defaults.resilience;
        policy =
          own === undefined
            ? modelPolicy(model, {
                retry: options.retry ?? model.settings.retry ?? defaults.retry,
                timeout:
                  options.timeout ?? model.settings.timeout ?? defaults.timeout,
              })
            : typeof own === "string"
              ? preset(own)
              : own;
        policies.set(model, policy);
      }
      return policy;
    },
    settingsFor: (model: ResolvedModel) => {
      const settings: GenerationSettings = {};
      for (const key of [
        "maxOutputTokens",
        "temperature",
        "topP",
        "topK",
        "seed",
        "stopSequences",
        "presencePenalty",
        "frequencyPenalty",
        "providerOptions",
        "headers",
      ] as const) {
        const value = pick(model, key);
        if (value !== undefined) {
          (settings as Record<keyof GenerationSettings, unknown>)[key] = value;
        }
      }
      return settings;
    },
  });
}

function fallbacks(
  option: AiCallOptions["fallback"],
  primary: ResolvedModel,
  models: AiModels,
): ResolvedModel[] {
  if (option === false) {
    return [];
  }
  if (option === undefined) {
    return primary.fallback.map((name) => models.resolve(name));
  }
  const references: AiModelReference[] = Array.isArray(option)
    ? [...option]
    : [option];
  return references.map((reference) => models.resolve(reference));
}

function messagesOf(options: AiCallOptions): ModelMessage[] {
  const { prompt, messages } = options;
  if (prompt !== undefined && messages !== undefined) {
    throw new AiConfigurationError("Pass `prompt` or `messages`, not both.");
  }
  if (typeof prompt === "string") {
    return [{ role: "user", content: prompt }];
  }
  if (Array.isArray(messages) && messages.length > 0) {
    return [...messages];
  }
  throw new AiConfigurationError(
    "Pass `prompt` (a string) or `messages` (a non-empty array of model messages).",
  );
}
