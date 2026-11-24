import type { INestApplicationContext } from "@bunest/core";
import type { TestingModuleBuilder } from "@bunest/testing";
import type { AiCaller } from "../interfaces/ai-tool.interface";
import type {
  EmbeddingModel,
  LanguageModel,
} from "../interfaces/ai-types.interface";
import {
  AI_EMBEDDING_MODEL_OVERRIDES,
  AI_MODEL_OVERRIDES,
} from "../ai.constants";
import { AiTools } from "../tools/ai-tools.service";

export {
  FakeModel,
  fakeModel,
  providerError,
  type FakeAnswer,
  type FakeModelCall,
  type FakeToolCall,
  type FakeTurn,
} from "./fake-model";

export {
  FakeEmbeddingModel,
  fakeEmbeddingModel,
  type FakeEmbeddingAnswer,
  type FakeEmbeddingModelCall,
  type FakeEmbeddingModelOptions,
  type FakeEmbeddingTurn,
} from "./fake-embedding-model";

/**
 * Replaces configured models by name (`{ default: new FakeModel([...]) }`) in a testing module,
 * keeping their other options (pricing, fallback, timeouts).
 */
export function overrideModels(
  builder: TestingModuleBuilder,
  models: Record<string, LanguageModel>,
): TestingModuleBuilder {
  return builder.overrideProvider(AI_MODEL_OVERRIDES).useValue(models);
}

/**
 * Replaces configured embedding models by name, preserving their settings and pricing.
 */
export function overrideEmbeddingModels(
  builder: TestingModuleBuilder,
  models: Record<string, EmbeddingModel>,
): TestingModuleBuilder {
  return builder
    .overrideProvider(AI_EMBEDDING_MODEL_OVERRIDES)
    .useValue(models);
}

/**
 * Calls the agent function `name` with `input` as `caller`, as an agent's call does:
 * input validated by its schema, scopes checked, then guards, interceptors, pipes and filters.
 */
export async function callTool(
  app: INestApplicationContext,
  name: string,
  input: unknown = {},
  { caller }: { caller?: AiCaller } = {},
): Promise<unknown> {
  await app.init();
  return app.get(AiTools, { strict: false }).call(name, input, caller);
}
