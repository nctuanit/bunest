import type { ContextId } from "@bunest/core";
import { ContextIdFactory } from "@bunest/core";

export const ASYNC_CONTEXT_ATTRIBUTE = Symbol("ASYNC_CONTEXT_ATTRIBUTE");

interface AsyncContextCarrier {
  [ASYNC_CONTEXT_ATTRIBUTE]?: AsyncContext;
}

/**
 * Represents the DI context of an asynchronous CQRS operation, enabling
 * request-scoped (`Scope.REQUEST`) command, query, and event handlers.
 */
export class AsyncContext {
  readonly id: ContextId;

  constructor(id?: ContextId) {
    this.id = id ?? ContextIdFactory.create();
  }

  /**
   * Attaches this async context to a command, query, event, or arbitrary object.
   */
  attachTo(target: object): void {
    Object.defineProperty(target, ASYNC_CONTEXT_ATTRIBUTE, {
      value: this,
      enumerable: false,
      configurable: true,
    });
  }

  /**
   * Checks whether `target` already has an `AsyncContext` attached.
   */
  static isAttached(target: object): boolean {
    if (!target || typeof target !== "object") {
      return false;
    }
    return Boolean((target as AsyncContextCarrier)[ASYNC_CONTEXT_ATTRIBUTE]);
  }

  /**
   * Copies an `AsyncContext` from a source object (or `AsyncContext` instance) onto `to`.
   */
  static merge(from: object | undefined, to: object): void {
    if (!from || !to) {
      return;
    }
    const fromContext =
      from instanceof AsyncContext
        ? from
        : (from as AsyncContextCarrier)[ASYNC_CONTEXT_ATTRIBUTE];
    if (!fromContext) {
      return;
    }
    Object.defineProperty(to, ASYNC_CONTEXT_ATTRIBUTE, {
      value: fromContext,
      enumerable: false,
      configurable: true,
    });
  }

  /**
   * Retrieves the `AsyncContext` attached to `target`, if any.
   */
  static of(target: object): AsyncContext | undefined {
    if (!target || typeof target !== "object") {
      return undefined;
    }
    return (target as AsyncContextCarrier)[ASYNC_CONTEXT_ATTRIBUTE];
  }
}
