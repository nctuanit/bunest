import { assertPriority } from "../core/limits/limits";
import { parseSchedule } from "../core/scheduling/schedule-spec";
import type {
  WorkflowScheduleOptions,
  WorkflowScheduleSpec,
} from "../interfaces/workflow-schedule.interface";

export type { WorkflowScheduleSpec };

/** Checks a schedule's options and returns its spec; throws a `TypeError` that names `owner` for anything invalid. */
export function scheduleSpec(
  owner: string,
  options: WorkflowScheduleOptions,
  extra: { version: number | null; inputFn: boolean },
): WorkflowScheduleSpec {
  const spec = parseSchedule(options, owner);
  const priority = options.priority ?? 0;
  assertPriority(priority, owner);
  return { ...spec, priority, ...extra };
}
