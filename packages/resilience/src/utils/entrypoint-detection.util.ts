import { METADATA_KEYS, type Type } from "@bunest/common";
import type { FallbackMetadata } from "../interfaces/entrypoint-options.interface";
import {
  FALLBACK_METADATA,
  RESILIENCE_METADATA_KEYS,
} from "../resilience.constants";

const GATEWAY_METADATA = "websockets:is_gateway";
const NEST_CONTROLLER_WATERMARK = "__controller__";
const NEST_ENTRY_PROVIDER_WATERMARK = "__entryProvider__";

/** Method metadata that marks a transport handler: HTTP route, message/event pattern, WS message, GraphQL resolver. */
const HANDLER_METADATA: ReadonlyArray<string | symbol> = [
  METADATA_KEYS.ROUTE_PATH,
  METADATA_KEYS.ROUTE_METHOD,
  "path",
  "microservices:pattern",
  "message",
  "graphql:resolver_type",
  "graphql:resolve_property",
];

export function hasResilienceMetadata(target: unknown): boolean {
  if (typeof target !== "function") {
    return false;
  }
  return RESILIENCE_METADATA_KEYS.some(
    (key) => Reflect.getMetadata(key, target) !== undefined,
  );
}

export function isEntryClass(cls: Type): boolean {
  return [
    METADATA_KEYS.CONTROLLER,
    NEST_CONTROLLER_WATERMARK,
    NEST_ENTRY_PROVIDER_WATERMARK,
    GATEWAY_METADATA,
  ].some((key) => Boolean(Reflect.getMetadata(key, cls)));
}

export function isHandler(fn: unknown): fn is Function {
  return (
    typeof fn === "function" &&
    HANDLER_METADATA.some((key) => Reflect.getMetadata(key, fn) !== undefined)
  );
}

export function isEntrypointMethod(cls: Type, handler: unknown): boolean {
  return isEntryClass(cls) && isHandler(handler);
}

/**
 * Collects method names referenced as `@Fallback("methodName")` targets on `cls`
 * (either class-level or on any prototype method) so class-level resilience decorators
 * do not recursively wrap the recovery method itself.
 */
export function collectFallbackTargetMethods(cls: Type): Set<string> {
  const targets = new Set<string>();
  const classFallback = Reflect.getMetadata(FALLBACK_METADATA, cls) as
    | FallbackMetadata
    | undefined;
  if (classFallback?.method) {
    targets.add(classFallback.method);
  }

  let proto: object | null = (cls.prototype as object | null) ?? null;
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor") {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc && typeof desc.value === "function") {
        const meta = Reflect.getMetadata(FALLBACK_METADATA, desc.value) as
          | FallbackMetadata
          | undefined;
        if (meta?.method) {
          targets.add(meta.method);
        }
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  return targets;
}
