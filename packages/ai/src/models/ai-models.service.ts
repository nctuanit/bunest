import { Inject, Injectable, Optional } from "@bunest/core";
import type {
  AiCallSettings,
  AiModelDefinition,
  AiModelPricing,
  AiModuleOptions,
  LanguageModel,
} from "../interfaces/ai-module-options.interface";
import type { AiModelReference } from "../interfaces/ai-call-options.interface";
import type { AiModelInfo } from "../interfaces/ai-types.interface";
import {
  AI_MODEL_OVERRIDES,
  AI_MODULE_OPTIONS,
  DEFAULT_MODEL_NAME,
} from "../ai.constants";
import { AiConfigurationError } from "../errors/ai.errors";
import { assertModelRegistries } from "./model-registry.util";

/** A model, as calls use it. Internal. */
export interface ResolvedModel {
  info: AiModelInfo;
  model: LanguageModel;
  pricing?: AiModelPricing;
  settings: AiCallSettings;
  /** The names of the models tried after it. */
  fallback: string[];
}

/** The configured models, by name. */
@Injectable()
export class AiModels {
  private readonly models = new Map<string, ResolvedModel>();

  constructor(
    @Inject(AI_MODULE_OPTIONS) options: AiModuleOptions,
    @Optional()
    @Inject(AI_MODEL_OVERRIDES)
    overrides?: Record<string, LanguageModel> | null,
  ) {
    assertModelRegistries(options);
    const models = options.models ?? {};
    for (const [name, entry] of Object.entries(models)) {
      const { model, pricing, fallback, ...settings } = isDefinition(entry)
        ? entry
        : { model: entry, pricing: undefined, fallback: undefined };
      assertModel(model, `AiModule: the model "${name}"`);
      const replacement = overrides?.[name];
      const used = replacement ?? model;
      this.models.set(name, {
        info: { name, ...identify(used) },
        model: used,
        ...(pricing !== undefined && { pricing }),
        settings,
        fallback: fallback === undefined ? [] : [fallback].flat(),
      });
    }

    for (const name of Object.keys(overrides ?? {})) {
      if (!this.models.has(name)) {
        throw new AiConfigurationError(
          `overrideModels(): there is no model "${name}" to override. ${this.known()}`,
        );
      }
    }

    for (const [name, resolved] of this.models) {
      for (const next of resolved.fallback) {
        if (!this.models.has(next)) {
          throw new AiConfigurationError(
            `AiModule: the model "${name}" falls back to "${next}", which is not configured. ${this.known()}`,
          );
        }
      }
    }
  }

  /** The names of the configured models. */
  names(): string[] {
    return [...this.models.keys()];
  }

  /** The `LanguageModel` called `name`. */
  get(name: string = DEFAULT_MODEL_NAME): LanguageModel {
    return this.resolve(name).model;
  }

  /** Whether a model called `name` is configured. */
  has(name: string): boolean {
    return this.models.has(name);
  }

  /** @internal What `@InjectModel(name)` injects into `inquirer`; a name that is not configured fails at startup. */
  injected(name: string, inquirer: unknown): LanguageModel {
    const resolved = this.models.get(name);
    if (!resolved) {
      const requester = (inquirer as { constructor?: { name?: string } })
        ?.constructor?.name;
      throw new AiConfigurationError(
        `${requester ? `${requester}: ` : ""}@InjectModel('${name}') asks for a model AiModule does not configure. ${this.known()} Add "${name}" to \`models\` (in forRootAsync(), to what the factory returns).`,
      );
    }
    return resolved.model;
  }

  /** @internal A name, or a `LanguageModel` given to a call (with no settings of its own). */
  resolve(reference: AiModelReference | undefined): ResolvedModel {
    if (reference === undefined || typeof reference === "string") {
      const name = reference ?? DEFAULT_MODEL_NAME;
      const resolved = this.models.get(name);
      if (!resolved) {
        throw new AiConfigurationError(
          `There is no model named "${name}". ${this.known()}`,
        );
      }
      return resolved;
    }
    assertModel(reference, "The `model` option");
    return {
      info: identify(reference),
      model: reference,
      settings: {},
      fallback: [],
    };
  }

  private known(): string {
    return `Configured: ${this.names().join(", ")}.`;
  }
}

function isDefinition(
  entry: LanguageModel | AiModelDefinition,
): entry is AiModelDefinition {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "model" in entry &&
    !("specificationVersion" in entry)
  );
}

function assertModel(model: unknown, where: string): void {
  const valid =
    (typeof model === "string" && model.length > 0) ||
    (typeof model === "object" &&
      model !== null &&
      typeof (model as { doGenerate?: unknown }).doGenerate === "function");
  if (!valid) {
    throw new AiConfigurationError(
      `${where} is not a language model. Pass a model string (e.g. 'openai/gpt-4o') or an object with doGenerate().`,
    );
  }
}

function identify(model: LanguageModel): { provider: string; modelId: string } {
  if (typeof model === "string") {
    const slash = model.indexOf("/");
    if (slash > 0) {
      return {
        provider: model.slice(0, slash),
        modelId: model.slice(slash + 1),
      };
    }
    return { provider: "gateway", modelId: model };
  }
  return { provider: model.provider, modelId: model.modelId };
}
