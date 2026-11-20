import type {
  ScheduleRecord,
  ScheduleSave,
  ScheduleStore,
} from "../core/interfaces/schedule-store.interface";
import type {
  WorkflowScheduleClaimRequest,
  WorkflowScheduleQuery,
  WorkflowScheduleRecord,
  WorkflowScheduleSave,
  WorkflowScheduleWrite,
  WorkflowStore,
} from "../interfaces/workflow-store.interface";

export type WorkflowScheduleMethods =
  | "saveSchedule"
  | "getSchedule"
  | "listSchedules"
  | "deleteSchedule"
  | "claimSchedules"
  | "writeSchedule";

type WorkflowScheduleStoreMethods = Pick<WorkflowStore, WorkflowScheduleMethods>;

/**
 * A workflow store's schedules as the core's `ScheduleStore`, for its `Scheduler`: a schedule's workflow is its
 * target, and its input its payload.
 */
export function workflowScheduleStore(
  store: () => WorkflowScheduleStoreMethods,
): ScheduleStore {
  return {
    saveSchedule: async (save) =>
      orNull(await store().saveSchedule(toWorkflowsSave(save)), fromWorkflows),
    getSchedule: async (id) =>
      orNull(await store().getSchedule(id), fromWorkflows),
    listSchedules: async ({ target, ...query }) =>
      (
        await store().listSchedules({
          ...query,
          ...(target === undefined ? {} : { workflow: target }),
        })
      ).map(fromWorkflows),
    deleteSchedule: (id, revision) => store().deleteSchedule(id, revision),
    claimSchedules: async ({ targets, ...request }) =>
      (
        await store().claimSchedules({ ...request, workflows: targets })
      ).map(fromWorkflows),
    writeSchedule: (id, token, write) =>
      store().writeSchedule(id, token, write),
  };
}

/**
 * A core `ScheduleStore` as a workflow store's schedule methods.
 */
export function workflowScheduleMethods(
  store: ScheduleStore,
): WorkflowScheduleStoreMethods {
  return {
    saveSchedule: async (save: WorkflowScheduleSave) =>
      orNull(await store.saveSchedule(fromWorkflowsSave(save)), toWorkflows),
    getSchedule: async (id: string) =>
      orNull(await store.getSchedule(id), toWorkflows),
    listSchedules: async ({ workflow, ...query }: WorkflowScheduleQuery) =>
      (
        await store.listSchedules({
          ...query,
          ...(workflow === undefined ? {} : { target: workflow }),
        })
      ).map(toWorkflows),
    deleteSchedule: (id: string, revision?: number) =>
      store.deleteSchedule(id, revision),
    claimSchedules: async ({
      workflows,
      ...request
    }: WorkflowScheduleClaimRequest) =>
      (
        await store.claimSchedules({ ...request, targets: workflows })
      ).map(toWorkflows),
    writeSchedule: (id: string, token: string, write: WorkflowScheduleWrite) =>
      store.writeSchedule(id, token, write),
  };
}

function toWorkflowsSave({
  target,
  payload,
  ...save
}: ScheduleSave): WorkflowScheduleSave {
  return { ...save, workflow: target, input: payload };
}

function fromWorkflowsSave({
  workflow,
  input,
  ...save
}: WorkflowScheduleSave): ScheduleSave {
  return { ...save, target: workflow, payload: input };
}

function fromWorkflows({
  workflow,
  input,
  ...record
}: WorkflowScheduleRecord): ScheduleRecord {
  return { ...record, target: workflow, payload: input };
}

function toWorkflows({
  target,
  payload,
  ...record
}: ScheduleRecord): WorkflowScheduleRecord {
  return { ...record, workflow: target, input: payload };
}

function orNull<T, R>(value: T | null, map: (value: T) => R): R | null {
  return value === null ? null : map(value);
}
