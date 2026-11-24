import { MetadataRegistry } from "@bunest/core";
import { EVENT_LISTENER_METADATA, ON_EVENT_METADATA } from "../constants";
import type {
  EventName,
  OnEventMetadata,
  OnEventOptions,
  OnEventType,
} from "../interfaces/event-emitter.interface";
import type { EventNameInput } from "../interfaces/event-registry.interface";

/**
 * Registers a provider or controller method as an event listener discovered
 * automatically by `EventEmitterModule` on application bootstrap.
 * Copy-on-write: never mutates parent class metadata.
 */
export function OnEvent(
  event: EventNameInput | readonly EventNameInput[] | OnEventType,
  options: OnEventOptions = {},
): MethodDecorator {
  const isArr = Array.isArray(event);
  const events: readonly EventName[] = isArr
    ? [...(event as readonly EventName[])]
    : [event as EventName];
  const normalizedEvent: OnEventType = isArr
    ? [...(event as readonly EventName[])]
    : (event as EventName);

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
  return MetadataRegistry.getMergedMethodArray<OnEventMetadata>(
    ON_EVENT_METADATA,
    target,
    "methodName",
  );
}
