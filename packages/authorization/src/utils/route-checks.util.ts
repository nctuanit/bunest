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
  const methodPublic = Reflect.getMetadata(AUTHENTICATION_PUBLIC, handler);
  const methodOpen =
    methodPublic === true ||
    Reflect.getMetadata(CAN_ANYONE_METADATA, handler) === true;
  const classOpen =
    Reflect.getMetadata(CAN_ANYONE_METADATA, type) === true ||
    (methodPublic === undefined &&
      Reflect.getMetadata(AUTHENTICATION_PUBLIC, type) === true);

  return {
    onClass: methodOpen
      ? []
      : ((Reflect.getMetadata(CAN_METADATA, type) as CanRequirement[] | undefined) ?? []),
    onMethod:
      (Reflect.getMetadata(CAN_METADATA, handler) as CanRequirement[] | undefined) ?? [],
    open: methodOpen || classOpen,
  };
}
