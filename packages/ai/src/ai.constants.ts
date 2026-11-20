/** The module options injection token. */
export const AI_MODULE_OPTIONS = 'AI_MODULE_OPTIONS';

/** Where `@AgentFunction()` records its options, on the method. */
export const AGENT_FUNCTION_METADATA = 'nestjs:ai:agent-function';

/** The `ExecutionContext` type of agent function calls. */
export const AI_CONTEXT_TYPE = 'ai';

/** The parameter metadata of agent functions. */
export const AI_PARAMS_METADATA = '__routeArguments__';

/** The name of the model calls use when they name none. */
export const DEFAULT_MODEL_NAME = 'default';

/** Models that replace configured ones by name, from `@bunest/ai/testing`. Internal. */
export const AI_MODEL_OVERRIDES: unique symbol = Symbol('AI_MODEL_OVERRIDES');

/** Embedding-model replacements from `@bunest/ai/testing`. Internal. */
export const AI_EMBEDDING_MODEL_OVERRIDES: unique symbol = Symbol(
  'AI_EMBEDDING_MODEL_OVERRIDES',
);

/** The injection token of the model called `name`. */
export function getModelToken(name?: string): string {
  return `AI_MODEL_${name ?? DEFAULT_MODEL_NAME}`;
}

/** The injection token of the embedding model called `name`. */
export function getEmbeddingModelToken(name?: string): string {
  return `AI_EMBEDDING_MODEL_${name ?? DEFAULT_MODEL_NAME}`;
}
