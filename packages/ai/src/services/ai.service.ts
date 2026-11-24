import { channel, Inject, Injectable, Logger, ModuleRef } from "@bunest/core";
import { ResilienceService, type ResiliencePolicy } from "@bunest/resilience";
import type {
  AiCallOptions,
  AiObjectCallOptions,
} from "../interfaces/ai-call-options.interface";
import type {
  AiEmbedManyOptions,
  AiEmbedManyResult,
  AiEmbedOptions,
  AiEmbedResult,
  AiEmbeddingUsageEvent,
} from "../interfaces/ai-embedding.interface";
import type { AiModuleOptions } from "../interfaces/ai-module-options.interface";
import type {
  AiObjectResult,
  AiTextResult,
} from "../interfaces/ai-result.interface";
import type {
  AiSchema,
  InferSchemaOutput,
} from "../interfaces/ai-schema.interface";
import type { ModelMessage } from "../interfaces/ai-types.interface";
import type { AiUsageEvent } from "../interfaces/ai-usage.interface";
import { AI_MODULE_OPTIONS } from "../ai.constants";
import { AiConfigurationError, AiOutputError } from "../errors/ai.errors";
import { AiEmbeddingModels } from "../models/ai-embedding-models.service";
import { AiModels } from "../models/ai-models.service";
import { runLoop, usageEvent } from "../runtime/agent-loop";
import { createCallPlan, type CallPlan } from "../runtime/call-plan";
import {
  createEmbeddingPlan,
  runEmbedding,
  type EmbeddingPlan,
} from "../runtime/embedding-call";
import { runStep } from "../runtime/model-policy";
import { generateStep, type StepOutcome } from "../runtime/steps";
import { AiTextStream } from "../runtime/text-stream";
import { AiTools } from "../tools/ai-tools.service";
import { toModelSchema } from "../utils/schema.util";

const NEVER_ABORTED = new AbortController().signal;
const usageChannel = channel("bunest:ai:usage");
const embeddingUsageChannel = channel("bunest:ai:embedding-usage");

/**
 * Model calls: text, structured output, streams, and embeddings, with the application's agent functions as tools,
 * through the configured models, with timeouts, retries, fallback, budgets and usage events.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger("AiModule");

  constructor(
    private readonly models: AiModels,
    private readonly tools: AiTools,
    @Inject(AI_MODULE_OPTIONS) private readonly options: AiModuleOptions,
    private readonly moduleRef: ModuleRef,
    private readonly embeddingModels: AiEmbeddingModels,
  ) {}

  /** Embeds one string, with the embedding model's settings, resilience policies and embedding usage events. */
  async embed(options: AiEmbedOptions): Promise<AiEmbedResult> {
    const plan = createEmbeddingPlan(
      options,
      this.embeddingModels,
      this.options,
      (name) => this.preset(name),
    );
    const { result, event, attempts, cost } = await runEmbedding(plan, {
      value: options.value,
    });
    this.report(plan, event, "onEmbeddingUsage");
    return {
      value: result.value,
      embedding: result.embedding,
      usage: result.usage,
      warnings: result.warnings,
      ...(result.response !== undefined && { response: result.response }),
      ...(result.providerMetadata !== undefined && {
        providerMetadata: result.providerMetadata,
      }),
      model: plan.model.info,
      attempts,
      ...(cost !== undefined && { cost }),
    };
  }

  /** Embeds strings in input order with bounded concurrency (default 4). */
  async embedMany(options: AiEmbedManyOptions): Promise<AiEmbedManyResult> {
    const plan = createEmbeddingPlan(
      options,
      this.embeddingModels,
      this.options,
      (name) => this.preset(name),
    );
    const { result, event, attempts, cost } = await runEmbedding(plan, {
      values: options.values,
    });
    this.report(plan, event, "onEmbeddingUsage");
    return {
      values: result.values,
      embeddings: result.embeddings,
      usage: result.usage,
      warnings: result.warnings,
      ...(result.responses !== undefined && { responses: result.responses }),
      ...(result.providerMetadata !== undefined && {
        providerMetadata: result.providerMetadata,
      }),
      model: plan.model.info,
      attempts,
      ...(cost !== undefined && { cost }),
    };
  }

  /** Generates text; with `tools`, calls them as the model asks, and answers when it is done. */
  async generateText(options: AiCallOptions): Promise<AiTextResult> {
    const plan = this.plan(options, options?.abortSignal ?? NEVER_ABORTED);
    const { result } = await runLoop(plan, { stream: false }, (event) =>
      this.report(plan, event),
    );
    return result;
  }

  /** Generates an object that matches `schema`. Rejects with `AiOutputError` when the answer does not match it. */
  async generateObject<S extends AiSchema>(
    options: AiObjectCallOptions<S>,
  ): Promise<AiObjectResult<InferSchemaOutput<S>>> {
    const schema = toModelSchema<InferSchemaOutput<S>>(
      options?.schema,
      "generateObject() `schema`",
    );
    const plan = this.plan(options, options.abortSignal ?? NEVER_ABORTED);
    const { result, output } = await runLoop(
      plan,
      {
        stream: false,
        output: {
          schema,
          ...(options.schemaName !== undefined && { name: options.schemaName }),
          ...(options.schemaDescription !== undefined && {
            description: options.schemaDescription,
          }),
        },
      },
      (event) => this.report(plan, event),
    );
    if (output === undefined) {
      throw new AiOutputError(
        `The model was still calling tools after ${plan.maxSteps} step(s), and gave no answer. Raise \`maxSteps\`.`,
        result.text,
      );
    }
    return { ...result, object: output as InferSchemaOutput<S> };
  }

  /** Streams text: the call starts now, and its answer can be streamed to a response, read, or awaited. */
  streamText(options: AiCallOptions): AiTextStream {
    const controller = new AbortController();
    const signal = options?.abortSignal
      ? AbortSignal.any([options.abortSignal, controller.signal])
      : controller.signal;
    const plan = this.plan(options, signal);
    return new AiTextStream(controller, async (emit) => {
      const { result, finish } = await runLoop(
        plan,
        { stream: true, emit },
        (event) => this.report(plan, event),
      );
      emit(finish ?? { type: "finish", finishReason: result.finishReason });
      return result;
    });
  }

  /** @internal One model call of a durable run (`@bunest/ai/workflows`), with `messages` so far. */
  async callModel(
    options: AiCallOptions,
    {
      index,
      messages,
      signal,
    }: {
      index: number;
      messages: ModelMessage[];
      signal: AbortSignal;
    },
  ): Promise<{
    outcome: StepOutcome;
    attempts: number;
  }> {
    const plan = this.plan(
      { ...options, prompt: undefined, messages },
      signal,
      false,
    );
    const { value, attempts } = await runStep(plan, async (attempt) => {
      const outcome = await generateStep(plan, index, plan.messages, attempt);
      this.report(plan, usageEvent(plan, attempt, outcome, false));
      return outcome;
    });
    return { outcome: value, attempts };
  }

  private plan(
    options: AiCallOptions,
    signal: AbortSignal,
    toolExecution = true,
  ): CallPlan {
    return createCallPlan(options, {
      models: this.models,
      tools: this.tools,
      moduleOptions: this.options,
      signal,
      preset: (name) => this.preset(name),
      toolExecution,
    });
  }

  private preset(name: string): ResiliencePolicy {
    let service: ResilienceService;
    try {
      service = this.moduleRef.get(ResilienceService, { strict: false });
    } catch {
      throw new AiConfigurationError(
        `\`resilience: '${name}'\` names a preset of ResilienceService, and the application does not import ResilienceModule.`,
      );
    }
    return service.preset(name);
  }

  private report(
    plan: Pick<CallPlan, "listeners"> | Pick<EmbeddingPlan, "listeners">,
    event: AiUsageEvent | AiEmbeddingUsageEvent,
    hook: "onUsage" | "onEmbeddingUsage" = "onUsage",
  ): void {
    const ch = hook === "onUsage" ? usageChannel : embeddingUsageChannel;
    if (ch.hasSubscribers) {
      ch.publish(event);
    }
    for (const listener of plan.listeners) {
      try {
        Promise.resolve((listener as (ev: any) => any)(event)).catch((error) =>
          this.logListenerError(error, hook),
        );
      } catch (error) {
        this.logListenerError(error, hook);
      }
    }
  }

  private logListenerError(error: unknown, hook: string): void {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    this.logger.error(`${hook} failed: ${msg}`, stack);
  }
}
