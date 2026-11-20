export function recordModelRequest(name: string): void {
  _requestedModels.add(name);
}

export function requestedModelNames(): string[] {
  return [..._requestedModels];
}

export function recordEmbeddingModelRequest(name: string): void {
  _requestedEmbeddingModels.add(name);
}

export function requestedEmbeddingModelNames(): string[] {
  return [..._requestedEmbeddingModels];
}

const _requestedModels = new Set<string>();
const _requestedEmbeddingModels = new Set<string>();
