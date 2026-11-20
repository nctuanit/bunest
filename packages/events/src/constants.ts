import { REQUEST } from "@bunest/common";

export const EVENT_EMITTER_OPTIONS = Symbol.for("bunest:events:options");
export const ON_EVENT_METADATA = Symbol.for("bunest:events:on_event");
export const EVENT_PARAMS_METADATA = Symbol.for("bunest:events:params");
export const EVENT_LISTENER_METADATA = "EVENT_LISTENER_METADATA" as const;
export const EVENT_PAYLOAD = REQUEST;
export const DEFAULT_LISTENER_PRIORITY = 0;
