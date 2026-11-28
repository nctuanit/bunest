import { MetadataRegistry } from "@bunest/core";
import { EVENT_LISTENER_METADATA, ON_EVENT_METADATA } from "../constants";
import type {
  EventName,
  OnEventMetadata,
  OnEventOptions,
  OnEventType,
} from "../interfaces/event-emitter.interface";
import { isAppEvent, type AppEvent } from "../app-event";
import type { EventNameInput } from "../interfaces/event-registry.interface";

/**
 * Registers a provider or controller method as an event listener discovered
 * automatically by `EventEmitterModule` on application bootstrap.
 * Copy-on-write: never mutates parent class metadata.
 */
export function OnEvent(
  event:
    | EventNameInput
    | AppEvent<string, any>
    | readonly (EventNameInput | AppEvent<string, any>)[]
    | OnEventType,
  options: OnEventOptions = {},
): MethodDecorator {
  const isArr = Array.isArray(event);
  const unwrap = (item: unknown): EventName =>
    isAppEvent(item) ? item.name : (item as EventName);
  const events: readonly EventName[] = isArr
    ? (event as readonly unknown[]).map(unwrap)
    : [unwrap(event)];
  const normalizedEvent: OnEventType = isArr ? [...events] : events[0]!;

  const decorator = (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const entry: OnEventMetadata = {
      event: normalizedEvent,
      events,
      methodName: propertyKey,
      options: { ...options },
    };

    // Copy-on-write own array on target.constructor.
    // Insert before the first existing entry for the same methodName to preserve
    // top-to-bottom declaration order for stacked @OnEvent() decorators while
    // preserving method declaration order across methods.
    const existing =
      MetadataRegistry.getOwn<readonly OnEventMetadata[]>(
        ON_EVENT_METADATA,
        target.constructor,
      ) ?? [];
    const firstSameMethodIdx = existing.findIndex(
      (item) => item.methodName === propertyKey,
    );
    const next =
      firstSameMethodIdx !== -1
        ? [
            ...existing.slice(0, firstSameMethodIdx),
            entry,
            ...existing.slice(firstSameMethodIdx),
          ]
        : [...existing, entry];
    MetadataRegistry.define(ON_EVENT_METADATA, next, target.constructor);

    if (descriptor && typeof descriptor.value === "function") {
      MetadataRegistry.prependOwnArray<OnEventMetadata>(
        EVENT_LISTENER_METADATA,
        [entry],
        descriptor.value,
      );
    }

    return descriptor;
  };

  (decorator as MethodDecorator & { KEY: typeof EVENT_LISTENER_METADATA }).KEY =
    EVENT_LISTENER_METADATA;

  return decorator;
}

/**
 * Reads effective `@OnEvent()` metadata across a class inheritance chain.
 * Subclass decorations on an overridden method replace parent declarations for
 * that method without mutating parent metadata.
 */
export function getOnEventMetadata(target: Function): OnEventMetadata[] {
  const fromClass = MetadataRegistry.getMergedMethodArray<OnEventMetadata>(
    ON_EVENT_METADATA,
    target,
    "methodName",
  );
  const seenMethods = new Set<string | symbol>(
    fromClass.map((entry) => entry.methodName),
  );
  const extra: OnEventMetadata[] = [];

  let proto: object | null = target.prototype as object | null;
  while (proto && proto !== Object.prototype) {
    const keys: Array<string | symbol> = [
      ...Object.getOwnPropertyNames(proto),
      ...Object.getOwnPropertySymbols(proto),
    ];
    for (const key of keys) {
      if (key === "constructor" || seenMethods.has(key)) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (!desc || typeof desc.value !== "function") {
        continue;
      }
      const raw = MetadataRegistry.get<
        Partial<OnEventMetadata> | readonly Partial<OnEventMetadata>[]
      >(EVENT_LISTENER_METADATA, desc.value);
      if (!raw) {
        continue;
      }
      seenMethods.add(key);
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        if (!item || item.event === undefined) {
          continue;
        }
        const isArr = Array.isArray(item.event);
        const unwrap = (ev: unknown): EventName =>
          isAppEvent(ev) ? ev.name : (ev as EventName);
        const events: readonly EventName[] =
          item.events ??
          (isArr
            ? (item.event as readonly unknown[]).map(unwrap)
            : [unwrap(item.event)]);
        const normalizedEvent: OnEventType = isArr ? [...events] : events[0]!;
        extra.push({
          event: normalizedEvent,
          events,
          methodName: key,
          options: item.options ? { ...item.options } : {},
        });
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  return extra.length > 0 ? [...fromClass, ...extra] : fromClass;
}
