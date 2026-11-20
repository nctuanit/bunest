export const COMMAND_METADATA = Symbol.for("bunest:cqrs:command");
export const COMMAND_HANDLER_METADATA = Symbol.for(
  "bunest:cqrs:command-handler",
);
export const QUERY_METADATA = Symbol.for("bunest:cqrs:query");
export const QUERY_HANDLER_METADATA = Symbol.for("bunest:cqrs:query-handler");
export const EVENT_METADATA = Symbol.for("bunest:cqrs:event");
export const EVENTS_HANDLER_METADATA = Symbol.for("bunest:cqrs:events-handler");
export const SAGA_METADATA = Symbol.for("bunest:cqrs:saga");
export const CQRS_MODULE_OPTIONS = Symbol.for("bunest:cqrs:module-options");
