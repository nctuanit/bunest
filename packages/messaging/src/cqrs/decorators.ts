import {
  Injectable,
  MetadataRegistry,
  type InjectableOptions,
  type Type,
} from "@bunest/core";
import type {
  CommandMetadata,
  CommandType,
  EventMetadata,
  EventType,
  IAggregateRoot,
  ICommand,
  IEvent,
  IQuery,
  QueryMetadata,
  QueryType,
  SagaMethodMetadata,
} from "./interfaces";
import { AggregateRootStorage } from "./storages/aggregate-root.storage";
import {
  COMMAND_HANDLER_METADATA,
  COMMAND_METADATA,
  EVENTS_HANDLER_METADATA,
  EVENT_METADATA,
  QUERY_HANDLER_METADATA,
  QUERY_METADATA,
  SAGA_METADATA,
} from "./tokens";

function ensureIdMetadata(key: symbol, target: Function): string {
  const existing = MetadataRegistry.get<CommandMetadata>(key, target);
  if (existing?.id) {
    return existing.id;
  }
  const id = crypto.randomUUID();
  MetadataRegistry.define<CommandMetadata>(key, { id }, target);
  return id;
}

function isInjectableOptions(value: unknown): value is InjectableOptions {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value === "function"
  ) {
    return false;
  }
  return "scope" in value || "durable" in value;
}

/**
 * Registers a provider class as the single handler for `command`.
 */
export function CommandHandler(
  command: ICommand | CommandType,
  options?: InjectableOptions,
): ClassDecorator {
  return (target: Function) => {
    Injectable(options)(target);
    if (typeof command === "function") {
      ensureIdMetadata(COMMAND_METADATA, command);
    }
    MetadataRegistry.define<CommandType>(
      COMMAND_HANDLER_METADATA,
      command as CommandType,
      target,
    );
  };
}

/**
 * Registers a provider class as the single handler for `query`.
 */
export function QueryHandler(
  query: IQuery | QueryType,
  options?: InjectableOptions,
): ClassDecorator {
  return (target: Function) => {
    Injectable(options)(target);
    if (typeof query === "function") {
      ensureIdMetadata(QUERY_METADATA, query);
    }
    MetadataRegistry.define<QueryType>(
      QUERY_HANDLER_METADATA,
      query as QueryType,
      target,
    );
  };
}

/**
 * Registers a provider class as an event handler for one or more event classes.
 * Accepts an optional trailing `InjectableOptions` object (e.g. `{ scope: Scope.REQUEST }`).
 */
export function EventsHandler(
  ...events: Array<IEvent | EventType | InjectableOptions>
): ClassDecorator {
  let injectableOptions: InjectableOptions | undefined;
  const eventTypes: EventType[] = [];

  for (let i = 0; i < events.length; i++) {
    const item = events[i];
    if (i === events.length - 1 && isInjectableOptions(item)) {
      injectableOptions = item;
    } else if (typeof item === "function") {
      ensureIdMetadata(EVENT_METADATA, item);
      eventTypes.push(item as EventType);
    }
  }

  return (target: Function) => {
    Injectable(injectableOptions)(target);
    MetadataRegistry.define<readonly EventType[]>(
      EVENTS_HANDLER_METADATA,
      eventTypes,
      target,
    );
  };
}

/**
 * Marks a method or property on a provider class as a CQRS Saga reacting to
 * published events and returning follow-up command(s) for `CommandBus`.
 * Inheritance-safe (copy-on-write on target constructor).
 */
export function Saga(): MethodDecorator & PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendOwnArray<SagaMethodMetadata>(
      SAGA_METADATA,
      [{ methodName: propertyKey }],
      target.constructor,
    );
  };
}

/**
 * Registers an `AggregateRoot` (or `WithAggregateRoot`) class so `CqrsModule`
 * automatically merges `EventBus` publish context onto its prototype during bootstrap.
 */
export function Publishable(): ClassDecorator {
  return (target: Function) => {
    AggregateRootStorage.add(target as unknown as Type<IAggregateRoot<any>>);
  };
}

export type { CommandMetadata, EventMetadata, QueryMetadata };
