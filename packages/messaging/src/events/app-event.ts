export const APP_EVENT_SYMBOL = Symbol.for("bunest:messaging:app-event");

/**
 * Strongly-typed application event contract shared between `@OnEvent(event)`,
 * `@EmitEvent(event)`, `events.emitAppEvent(event, payload)`, and
 * `events.emitAppEventAsync(event, payload)`.
 */
export interface AppEvent<TName extends string = string, TPayload = unknown> {
  readonly [APP_EVENT_SYMBOL]: true;
  readonly name: TName;
  /** Phantom type carrier for payload inference. */
  readonly __payload?: TPayload;
}

/** Extracts the payload type `TPayload` from an `AppEvent`. */
export type AppEventPayload<TEvent> =
  TEvent extends AppEvent<string, infer TPayload> ? TPayload : never;

export function isAppEvent(
  value: unknown,
): value is AppEvent<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[APP_EVENT_SYMBOL] === true &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

/**
 * Defines a type-safe event contract usable across `@OnEvent(event)`,
 * `@EmitEvent(event)`, `EventEmitterService.emitAppEvent()`, and
 * `EventEmitterService.emitAppEventAsync()`.
 */
export function defineAppEvent<
  TPayload = unknown,
  TName extends string = string,
>(name: TName): AppEvent<TName, TPayload> {
  if (!name || typeof name !== "string") {
    throw new Error("defineAppEvent() requires a non-empty string event name.");
  }
  return Object.freeze({
    [APP_EVENT_SYMBOL]: true as const,
    name,
  });
}
