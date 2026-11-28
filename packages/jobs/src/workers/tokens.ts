export const WORKER_MODULE_OPTIONS = Symbol.for("bunest:workers:module-options");
export const WORKER_POOL_REGISTRY = Symbol.for("bunest:workers:pool-registry");
export const WORKER_HANDLER_METADATA = Symbol.for("bunest:workers:handler");
export const WORKER_OFFLOAD_ASPECT = Symbol.for("bunest:workers:offload-aspect");

export function getWorkerPoolToken(name?: string): string {
  return `bunest:workers:pool:${name ?? "default"}`;
}

export function getWorkerPoolOptionsToken(name?: string): string {
  return `bunest:workers:pool-options:${name ?? "default"}`;
}
