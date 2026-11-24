import { Inject } from "@bunest/core";
import { DEFAULT_MODEL_NAME, getEmbeddingModelToken } from "../ai.constants";
import { recordEmbeddingModelRequest } from "../models/model-requests";

/**
 * Injects the configured `EmbeddingModel` called `name` (default `'default'`).
 */
export function InjectEmbeddingModel(
  name: string = DEFAULT_MODEL_NAME,
): PropertyDecorator & ParameterDecorator {
  recordEmbeddingModelRequest(name);
  return Inject(getEmbeddingModelToken(name));
}
