/**
 * event-registry.interface.ts
 *
 * Module Augmentation target for `@bunest/messaging/events`.
 * Automatically populated by `bunest dev` / `bunest typegen` from `@OnEvent(...)`
 * and `@EmitEvent(...)` decorators across the project.
 */

/**
 * Global registry mapping event names to their payload types.
 * Augment via `declare module "@bunest/messaging/events"` (or run `bunest dev` / `bunest typegen`).
 *
 * @example
 * ```ts
 * declare module "@bunest/messaging/events" {
 *   interface BunestEventRegistry {
 *     "order.created": OrderCreatedEvent;
 *   }
 * }
 * ```
 */
export interface BunestEventRegistry {}

/** Union of all registered event names (or `never` when unaugmented). */
export type RegisteredEventName = keyof BunestEventRegistry & string;

/** Autocomplete-friendly event name input preserving wildcard & dynamic events. */
export type EventNameInput = [RegisteredEventName] extends [never]
  ? string | symbol
  : RegisteredEventName | (string & {}) | symbol;

/** Resolve payload argument tuple for a registered event `K`. */
export type RegisteredEventArgs<K extends keyof BunestEventRegistry> =
  BunestEventRegistry[K] extends void | never
    ? []
    : BunestEventRegistry[K] extends readonly unknown[]
      ? BunestEventRegistry[K]
      : [payload: BunestEventRegistry[K]];
