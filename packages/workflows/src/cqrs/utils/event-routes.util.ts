import { MetadataRegistry, type Type } from "@bunest/core";
import { WORKFLOW_EVENT_ROUTES_METADATA } from "../../workflows.constants";
import type { WorkflowEventRoute } from "../interfaces/workflow-event-route.interface";

/** The class's own routes, in declaration order (decorators apply bottom-up). */
export function eventRoutesOf(target: Function): WorkflowEventRoute[] {
  return (
    MetadataRegistry.getOwn<WorkflowEventRoute[]>(
      WORKFLOW_EVENT_ROUTES_METADATA,
      target,
    ) ?? []
  );
}

export function addEventRoute(
  target: Function,
  route: WorkflowEventRoute,
): void {
  MetadataRegistry.define(
    WORKFLOW_EVENT_ROUTES_METADATA,
    [route, ...eventRoutesOf(target)],
    target,
  );
}

export function assertEventClass(
  decorator: string,
  event: unknown,
): asserts event is Type<object> {
  if (typeof event !== "function") {
    throw new TypeError(
      `@${decorator}() takes the event class first, got ${event === null ? "null" : typeof event}.`,
    );
  }
}

export function assertMapper(
  decorator: string,
  event: Type<object>,
  option: string,
  value: unknown,
  required = false,
): void {
  if (value === undefined && !required) {
    return;
  }
  if (typeof value !== "function") {
    throw new TypeError(
      `@${decorator}(${event.name}): \`${option}\` must be a function of the event, such as (event) => event.orderId` +
        `${required ? "" : ", or left out"}.`,
    );
  }
}
