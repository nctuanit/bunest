import { MetadataRegistry } from "@bunest/core";
import {
  AUTHENTICATION_PUBLIC,
  CAN_ANYONE_METADATA,
  CAN_METADATA,
} from "../authorization.constants";
import type { CanRequirement } from "../interfaces/can-requirement.interface";

/** What a handler declares to the authorization guard. */
export interface RouteChecks {
  onClass: CanRequirement[];
  onMethod: CanRequirement[];
  open: boolean;
}

export function routeChecks(type: Function, handler: Function): RouteChecks {
  const methodPublic = MetadataRegistry.get(AUTHENTICATION_PUBLIC, handler);
  const methodOpen =
    methodPublic === true ||
    MetadataRegistry.get(CAN_ANYONE_METADATA, handler) === true;
  const classOpen =
    MetadataRegistry.get(CAN_ANYONE_METADATA, type) === true ||
    (methodPublic === undefined &&
      MetadataRegistry.get(AUTHENTICATION_PUBLIC, type) === true);

  return {
    onClass: methodOpen
      ? []
      : (MetadataRegistry.get<CanRequirement[]>(CAN_METADATA, type) ?? []),
    onMethod:
      MetadataRegistry.get<CanRequirement[]>(CAN_METADATA, handler) ?? [],
    open: methodOpen || classOpen,
  };
}
