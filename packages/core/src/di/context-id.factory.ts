import type {
  ContextId,
  ContextIdStrategy,
  HostComponentInfo,
} from "../common/index";

let nextContextId = 1;
let activeStrategy: ContextIdStrategy<any> | undefined;
const requestContextIds = new WeakMap<object, ContextId>();

/**
 * Creates per-request and durable multi-tenant DI `ContextId` instances,
 * supporting pluggable `ContextIdStrategy` implementations registered via
 * `ContextIdFactory.apply(strategy)`.
 */
export class ContextIdFactory {
  /**
   * Generates a unique `ContextId`.
   */
  static create(): ContextId {
    return { id: nextContextId++ };
  }

  /**
   * Registers a durable DI sub-tree strategy (e.g., per-tenant sub-tree caching).
   * Pass `undefined` (or call `reset()`) to restore default per-request behavior.
   */
  static apply<TRequest = Request>(
    strategy: ContextIdStrategy<TRequest> | undefined,
  ): void {
    activeStrategy = strategy;
  }

  /**
   * Returns the currently registered `ContextIdStrategy`, if any.
   */
  static getStrategy(): ContextIdStrategy<any> | undefined {
    return activeStrategy;
  }

  /**
   * Clears any active `ContextIdStrategy` (useful in test teardown).
   */
  static reset(): void {
    activeStrategy = undefined;
  }

  /**
   * Returns (or creates and attaches via the active `ContextIdStrategy`) the
   * `ContextId` associated with `request`.
   */
  static getByRequest<TRequest extends object = Request>(
    request: TRequest,
  ): ContextId {
    if (typeof request === "object" && request !== null) {
      const existing = requestContextIds.get(request);
      if (existing) {
        return existing;
      }
    }

    const contextId = ContextIdFactory.create();

    if (activeStrategy) {
      const resolverOrFn = activeStrategy.attach(contextId, request);
      if (typeof resolverOrFn === "function") {
        contextId.getParent = (info: HostComponentInfo): ContextId =>
          resolverOrFn(info) ?? contextId;
      } else if (resolverOrFn && typeof resolverOrFn === "object") {
        contextId.payload = resolverOrFn.payload;
        contextId.getParent = (info: HostComponentInfo): ContextId =>
          resolverOrFn.resolve(info) ?? contextId;
      }
    }

    if (typeof request === "object" && request !== null) {
      requestContextIds.set(request, contextId);
    }

    return contextId;
  }
}

/**
 * Helper function matching NestJS `@nestjs/core` `createContextId()`.
 */
export function createContextId(): ContextId {
  return ContextIdFactory.create();
}
