import type { InjectionToken, Type } from "./type.interface";

/**
 * Describes the host component being resolved when choosing between a
 * durable DI sub-tree context ID and a per-request context ID.
 */
export interface HostComponentInfo {
  readonly host: Type<unknown> | InjectionToken | object;
  readonly isTreeDurable: boolean;
  readonly token?: InjectionToken;
}

/**
 * Identifies a DI request or durable sub-tree resolution context.
 */
export interface ContextId {
  readonly id: number | symbol;
  payload?: unknown;
  getParent?: (info: HostComponentInfo) => ContextId;
}

export type ContextIdResolverFn<TContextId extends ContextId = ContextId> = (
  info: HostComponentInfo,
) => TContextId | undefined;

export interface ContextIdResolver<TContextId extends ContextId = ContextId> {
  readonly resolve: ContextIdResolverFn<TContextId>;
  readonly payload: unknown;
}

/**
 * Pluggable multi-tenancy / durable DI sub-tree strategy registered via
 * `ContextIdFactory.apply(strategy)`.
 */
export interface ContextIdStrategy<
  TRequest = Request,
  TContextId extends ContextId = ContextId,
> {
  attach(
    contextId: TContextId,
    request: TRequest,
  ):
    | ContextIdResolver<TContextId>
    | ContextIdResolverFn<TContextId>
    | undefined;
}
