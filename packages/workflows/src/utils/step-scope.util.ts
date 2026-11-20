import { AsyncLocalStorage } from "node:async_hooks";

interface StepScopeState {
  idempotencyKey: string;
  signals: Map<string, number>;
  starts: Map<string, number>;
}

const scope = new AsyncLocalStorage<StepScopeState>();

/** Runs a step attempt's function, so the signals it sends and the workflows it starts can derive their ids from the step. */
export function runInStepScope<T>(idempotencyKey: string, fn: () => T): T {
  return scope.run(
    { idempotencyKey, signals: new Map(), starts: new Map() },
    fn,
  );
}

/**
 * The dedupe id of a signal sent without one from inside a step, directly or through a mapped
 * event. `undefined` outside a step.
 */
export function stepSignalId(
  name: string,
  key: string | null,
): string | undefined {
  const step = scope.getStore();
  if (!step) {
    return undefined;
  }
  const counter = JSON.stringify([name, key]);
  const n = (step.signals.get(counter) ?? 0) + 1;
  step.signals.set(counter, n);
  return JSON.stringify([step.idempotencyKey, key, n]);
}

/**
 * The id of a workflow started without one from inside a step. `undefined` outside a step.
 */
export function stepStartId(workflow: string): string | undefined {
  const step = scope.getStore();
  if (!step) {
    return undefined;
  }
  const n = (step.starts.get(workflow) ?? 0) + 1;
  step.starts.set(workflow, n);
  return JSON.stringify([step.idempotencyKey, workflow, n]);
}
