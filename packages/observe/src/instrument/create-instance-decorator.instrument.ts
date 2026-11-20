import { AsyncLocalStorage } from "node:async_hooks";
import { Reflector } from "@bunest/common";
import { CALLER_METADATA_KEY, TRACE_REGISTRY_KEY } from "../observe.constants";
import type { OperationTraceRegistry } from "../services/operation-trace.registry";
import type { KeyOf } from "../types/key-of.type";

const INSTRUMENTED_MARK = Symbol("observe:instrumented");

function isPlainSkippable(instance: unknown): boolean {
  if (instance === null || typeof instance !== "object") {
    return true;
  }
  if (instance instanceof Reflector) {
    return true;
  }
  if ((instance as Record<symbol, unknown>)[INSTRUMENTED_MARK]) {
    return true;
  }
  const ctorName = (instance as { constructor?: { name?: string } }).constructor
    ?.name;
  if (
    !ctorName ||
    ctorName === "Object" ||
    ctorName === "Array" ||
    ctorName === "Map" ||
    ctorName === "Set" ||
    ctorName === "MongoClient" ||
    ctorName === "Db" ||
    ctorName === "TracerService" ||
    ctorName === "OperationTraceRegistry" ||
    ctorName === "ObserveAgentSharedBuffer"
  ) {
    return true;
  }
  return false;
}

export function createInstanceDecorator<T extends Record<string, unknown>>(
  als: AsyncLocalStorage<Map<KeyOf<T>, any>>,
  operationTraceRegistry: OperationTraceRegistry,
  options: {
    traceIdKey: string;
    skipInstrumentation: (instance: unknown) => boolean;
  },
): (instance: unknown) => any {
  return (instance: unknown): any => {
    try {
      if (options.skipInstrumentation(instance)) {
        return instance;
      }
      if (isPlainSkippable(instance)) {
        return instance;
      }
    } catch {
      return instance;
    }

    const target = instance as Record<string | symbol, unknown>;
    const className =
      (target.constructor as { name?: string } | undefined)?.name ?? "Unknown";
    const wrappedMethods = new Map<string | symbol, Function>();

    return new Proxy(target, {
      get(obj, prop, receiver) {
        if (prop === INSTRUMENTED_MARK) {
          return true;
        }
        const value = Reflect.get(obj, prop, receiver);
        if (
          typeof prop !== "string" ||
          prop === "constructor" ||
          prop.startsWith("_") ||
          typeof value !== "function"
        ) {
          return value;
        }

        let wrapped = wrappedMethods.get(prop);
        if (!wrapped) {
          wrapped = function (this: unknown, ...args: unknown[]) {
            const store = als.getStore();
            if (!store) {
              return (value as Function).apply(this === receiver ? obj : this, args);
            }
            const registryKey =
              (store.get(TRACE_REGISTRY_KEY as KeyOf<T>) as
                | string
                | undefined) ??
              (store.get(options.traceIdKey as KeyOf<T>) as string | undefined);
            if (!registryKey || !operationTraceRegistry.hasTrace(registryKey)) {
              return (value as Function).apply(this === receiver ? obj : this, args);
            }

            const callerId = store.get(CALLER_METADATA_KEY as KeyOf<T>) as
              | string
              | undefined;
            const spanId = operationTraceRegistry.internalStartTraceStep(
              registryKey,
              className,
              prop,
              callerId,
            );
            const nextStore = new Map(store);
            if (spanId) {
              nextStore.set(CALLER_METADATA_KEY as KeyOf<T>, spanId);
            }

            const invoke = () =>
              (value as Function).apply(this === receiver ? obj : this, args);

            try {
              const result = als.run(nextStore, invoke);
              if (
                result !== null &&
                (typeof result === "object" || typeof result === "function") &&
                typeof (result as PromiseLike<unknown>).then === "function"
              ) {
                return (result as Promise<unknown>).then(
                  (resolved) => {
                    operationTraceRegistry.internalEndTraceStep(
                      registryKey,
                      spanId,
                      className,
                      prop,
                      callerId,
                    );
                    return resolved;
                  },
                  (err) => {
                    operationTraceRegistry.internalEndTraceStep(
                      registryKey,
                      spanId,
                      className,
                      prop,
                      callerId,
                      err as Error,
                    );
                    throw err;
                  },
                );
              }
              operationTraceRegistry.internalEndTraceStep(
                registryKey,
                spanId,
                className,
                prop,
                callerId,
              );
              return result;
            } catch (err) {
              operationTraceRegistry.internalEndTraceStep(
                registryKey,
                spanId,
                className,
                prop,
                callerId,
                err as Error,
              );
              throw err;
            }
          };
          wrappedMethods.set(prop, wrapped);
        }
        return wrapped;
      },
    });
  };
}
