import { Injectable, Logger } from "@bunest/core";
import type { GraphQLError } from "../engine";

/**
 * Context passed to the "request start" hook.
 */
export interface GqlRequestStartHookContext {
  query?: string;
  operationName?: string;
  variables?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

/**
 * Context passed to the "request end" hook.
 */
export interface GqlRequestEndHookContext extends GqlRequestStartHookContext {
  errors?: readonly GraphQLError[];
  state?: unknown;
}

export type GqlRequestStartHook = (
  context: GqlRequestStartHookContext,
) => unknown;

export type GqlRequestEndHook = (
  context: GqlRequestEndHookContext,
) => void | Promise<void>;

type ResolverWrapperDecorator = (
  fn: (...args: unknown[]) => void,
) => (...args: unknown[]) => void;

/**
 * Host for resolver instrumentation decorators and GraphQL request start/end
 * lifecycle hooks (matching `@nestjs/graphql@14` `ResolverDecoratorHost`).
 */
@Injectable()
export class ResolverDecoratorHost {
  private readonly logger = new Logger(ResolverDecoratorHost.name);
  private decorator?: ResolverWrapperDecorator;
  private onRequestStartHook?: GqlRequestStartHook;
  private onRequestEndHook?: GqlRequestEndHook;

  setDecorator(decorator: ResolverWrapperDecorator): void {
    this.decorator = decorator;
  }

  getDecorator(): (...args: unknown[]) => void {
    return (
      (this.decorator as unknown as (...args: unknown[]) => void) ??
      ((fn: (...args: unknown[]) => void) => fn)
    );
  }

  decorate(target: (...args: unknown[]) => void): (...args: unknown[]) => void {
    return this.decorator ? this.decorator(target) : target;
  }

  setOnRequestStartHook(hook: GqlRequestStartHook): void {
    this.onRequestStartHook = hook;
  }

  getOnRequestStartHook(): GqlRequestStartHook {
    return this.onRequestStartHook ?? (() => undefined);
  }

  setOnRequestEndHook(hook: GqlRequestEndHook): void {
    this.onRequestEndHook = hook;
  }

  getOnRequestEndHook(): GqlRequestEndHook {
    return this.onRequestEndHook ?? (() => undefined);
  }

  hasRequestHooks(): boolean {
    return Boolean(this.onRequestStartHook || this.onRequestEndHook);
  }

  onRequestStart(context: GqlRequestStartHookContext): unknown {
    if (!this.onRequestStartHook) {
      return undefined;
    }
    try {
      const result = this.onRequestStartHook(context);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return this.handleRejection(result as Promise<unknown>);
      }
      return result;
    } catch (err) {
      this.logger.error("Error in GraphQL onRequestStart hook", err);
      return undefined;
    }
  }

  onRequestEnd(context: GqlRequestEndHookContext): void | Promise<void> {
    if (!this.onRequestEndHook) {
      return undefined;
    }
    try {
      const result = this.onRequestEndHook(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        return this.handleRejection(result as Promise<void>).then(
          () => undefined,
        );
      }
      return result;
    } catch (err) {
      this.logger.error("Error in GraphQL onRequestEnd hook", err);
      return undefined;
    }
  }

  private handleRejection<T>(promise: Promise<T>): Promise<T | undefined> {
    return promise.catch((err) => {
      this.logger.error("Unhandled rejection in GraphQL request hook", err);
      return undefined;
    });
  }
}
