/**
 * pattern-registry.interface.ts
 *
 * Module Augmentation targets for `@bunest/microservices`.
 * Automatically populated by `bunest dev` / `bunest typegen` from `@MessagePattern(...)`
 * and `@EventPattern(...)` decorated handlers.
 */

/**
 * Request/response contract for a registered RPC `@MessagePattern()` handler.
 */
export interface RegisteredMessagePatternEntry<TReq = unknown, TRes = unknown> {
  readonly request: TReq;
  readonly response: TRes;
}

/**
 * Global registry mapping RPC message pattern keys to `{ request, response }` contracts.
 *
 * @example
 * ```ts
 * declare module "@bunest/microservices" {
 *   interface BunestMessagePatternRegistry {
 *     "orders.create": { request: CreateOrderDto; response: OrderDto };
 *   }
 * }
 * ```
 */
export interface BunestMessagePatternRegistry {}

/**
 * Global registry mapping fire-and-forget `@EventPattern()` keys to payload types.
 *
 * @example
 * ```ts
 * declare module "@bunest/microservices" {
 *   interface BunestEventPatternRegistry {
 *     "user.created": UserCreatedEvent;
 *   }
 * }
 * ```
 */
export interface BunestEventPatternRegistry {}

/** Union of all registered message pattern keys (or `never` when unaugmented). */
export type RegisteredMessagePatternKey = keyof BunestMessagePatternRegistry &
  string;

/** Union of all registered event pattern keys (or `never` when unaugmented). */
export type RegisteredEventPatternKey = keyof BunestEventPatternRegistry &
  string;

/** Extract request type for a registered message pattern key `K`. */
export type MessagePatternRequest<
  K extends keyof BunestMessagePatternRegistry,
> = BunestMessagePatternRegistry[K] extends { request: infer TReq }
  ? TReq
  : unknown;

/** Extract response type for a registered message pattern key `K`. */
export type MessagePatternResponse<
  K extends keyof BunestMessagePatternRegistry,
> = BunestMessagePatternRegistry[K] extends { response: infer TRes }
  ? TRes
  : unknown;
