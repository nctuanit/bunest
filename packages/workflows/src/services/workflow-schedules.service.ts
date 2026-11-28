import { Inject, Injectable } from "@bunest/core";
import { isDate } from "@bunest/core/common";
import type { ScheduleRecord } from "../core/interfaces/schedule-store.interface";
import {
  assertScheduleId,
  nextOccurrences,
  parseSchedule,
} from "../core/scheduling/schedule-spec";
import type { Scheduler } from "../core/scheduling/scheduler";
import { systemClock } from "../core/time/clock";
import { WorkflowNotFoundError } from "../errors/workflow-not-found.error";
import { WorkflowStateError } from "../errors/workflow-state.error";
import type { WorkflowStartResult } from "../interfaces/workflow-client.interface";
import type { WorkflowClock } from "../interfaces/workflow-clock.interface";
import type {
  UpsertWorkflowScheduleOptions,
  WorkflowSchedule,
  WorkflowScheduleListFilter,
  WorkflowSchedulePreviewOptions,
  WorkflowSchedulePreviewSpec,
  WorkflowScheduleSpec,
} from "../interfaces/workflow-schedule.interface";
import type { WorkflowsModuleOptions } from "../interfaces/workflows-module-options.interface";
import { normalize } from "../utils/normalize.util";
import { scheduleSpec } from "../utils/schedule-spec.util";
import { assertStorableJson } from "../utils/storable-text.util";
import { WORKFLOWS_MODULE_OPTIONS } from "../workflows.module-definition";
import { WorkflowRegistry } from "./workflow-registry.service";
import { WorkflowScheduler } from "./workflow-scheduler.service";
import { WorkflowWorker } from "./workflow-worker.service";

/**
 * Schedules that start workflow instances: a cron expression, an interval or an RFC 5545 rule, in a time zone.
 */
@Injectable()
export class WorkflowSchedules {
  private readonly clock: WorkflowClock;

  constructor(
    @Inject(WORKFLOWS_MODULE_OPTIONS)
    options: WorkflowsModuleOptions,
    private readonly registry: WorkflowRegistry,
    private readonly scheduler: WorkflowScheduler,
    private readonly worker: WorkflowWorker,
  ) {
    this.clock = options.clock ?? systemClock;
  }

  private get engine(): Scheduler<WorkflowScheduleSpec> {
    return this.scheduler.engine;
  }

  async upsert<W>(
    id: string,
    schedule: UpsertWorkflowScheduleOptions<W>,
  ): Promise<WorkflowSchedule> {
    assertScheduleId(id);
    const owner = `Schedule "${id}"`;
    if (schedule === null || typeof schedule !== "object") {
      throw new TypeError(
        `${owner}: expected options with workflow and cron, every or rrule.`,
      );
    }
    const workflow = this.registry.resolve(schedule.workflow, schedule.version);
    const spec = scheduleSpec(owner, schedule, {
      version: schedule.version ?? null,
      inputFn: false,
    });
    if (typeof schedule.input === "function") {
      throw new TypeError(
        `${owner}: upsert() stores its input, so it can't be a function. Pass a value; a declared schedule (@Workflow(name, { schedules })) can compute it.`,
      );
    }
    let input: unknown;
    try {
      input = normalize(schedule.input) ?? null;
    } catch (error) {
      throw new TypeError(
        `${owner}: its input is not JSON-serializable: ${(error as Error).message}`,
      );
    }
    assertStorableJson(
      `${owner}: its input`,
      input,
      this.scheduler.textCheck("payload"),
    );
    const saved = await this.engine.save(
      id,
      (current) => {
        if (current?.declared) {
          throw declaredError(current);
        }
        return this.engine.changed(current, {
          target: workflow.name,
          declared: false,
          spec,
          payload: input,
        });
      },
      { replacing: true },
    );
    this.worker.kick();
    return this.scheduler.view(saved!);
  }

  async get(id: string): Promise<WorkflowSchedule | null> {
    const record = await this.engine.read(id);
    return record ? this.scheduler.view(record) : null;
  }

  async list(
    filter: WorkflowScheduleListFilter = {},
  ): Promise<WorkflowSchedule[]> {
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new TypeError(
        `schedules.list(): limit (${limit}) and offset (${offset}) must be non-negative integers.`,
      );
    }
    if (limit === 0) {
      return [];
    }
    const records = await this.engine.store.listSchedules({
      limit,
      offset,
      ...(filter.workflow !== undefined ? { target: filter.workflow } : {}),
    });
    return Promise.all(
      records.map((record) => this.scheduler.readableView(record)),
    );
  }

  async remove(id: string): Promise<boolean> {
    const record = await this.engine.store.getSchedule(id);
    if (!record) {
      return false;
    }
    if (record.declared) {
      throw declaredError(record);
    }
    return this.engine.store.deleteSchedule(id);
  }

  async pause(id: string): Promise<WorkflowSchedule> {
    const saved = await this.engine.pause(id);
    if (!saved) {
      throw notFound(id);
    }
    return this.scheduler.readableView(saved);
  }

  async resume(id: string): Promise<WorkflowSchedule> {
    const saved = await this.engine.resume(id);
    if (!saved) {
      throw notFound(id);
    }
    this.worker.kick();
    return this.scheduler.readableView(saved);
  }

  async trigger(id: string): Promise<WorkflowStartResult> {
    const record = await this.engine.read(id);
    if (!record) {
      throw notFound(id);
    }
    const spec = record.spec as WorkflowScheduleSpec;
    const declared = record.declared
      ? this.scheduler.declaration(id)
      : undefined;
    if (spec.inputFn && !declared) {
      throw new TypeError(
        `Schedule "${id}" computes its input with a function, which this process doesn't declare: trigger it from one that registers workflow "${record.target}".`,
      );
    }
    const workflow = this.registry.resolve(
      record.target,
      spec.version ?? undefined,
    );
    const now = this.clock.now();
    const { instance, created } = (await this.scheduler.startOccurrence(
      record,
      spec,
      declared,
      workflow,
      now,
      now,
      true,
    ))!;
    if (created) {
      this.worker.kick();
    }
    return {
      id: instance.id,
      workflow: instance.workflow,
      version: instance.version,
      created,
      status: instance.status,
    };
  }

  async preview(
    schedule: string | WorkflowSchedulePreviewSpec,
    options: WorkflowSchedulePreviewOptions = {},
  ): Promise<number[]> {
    const count = options.count ?? 10;
    if (!Number.isSafeInteger(count) || count < 1 || count > 1_000) {
      throw new TypeError(
        `schedules.preview(): count (${count}) must be an integer from 1 to 1000.`,
      );
    }
    const rawFrom =
      options.from === undefined ? this.clock.now() : options.from;
    const from = isDate(rawFrom) ? rawFrom.getTime() : rawFrom;
    if (typeof from !== "number" || !Number.isFinite(from)) {
      throw new TypeError(
        `schedules.preview(): invalid from ${String(options.from)}. Pass a valid Date or a timestamp in milliseconds.`,
      );
    }
    if (typeof schedule !== "string") {
      const { cron, every, rrule, tz, startAt, endAt, limit } = schedule;
      return nextOccurrences(
        parseSchedule(
          { cron, every, rrule, tz, startAt, endAt, limit },
          "schedules.preview()",
        ),
        { from, count },
        "schedules.preview()",
      );
    }
    const record = await this.engine.store.getSchedule(schedule);
    if (!record) {
      throw notFound(schedule);
    }
    return nextOccurrences(
      record.spec as WorkflowScheduleSpec,
      { from, count, runs: this.engine.progress(record).runs },
      "schedules.preview()",
    );
  }
}

function notFound(id: string): WorkflowNotFoundError {
  return new WorkflowNotFoundError(`No workflow schedule with id "${id}".`);
}

function declaredError(record: ScheduleRecord): WorkflowStateError {
  return new WorkflowStateError(
    `Schedule "${record.id}" is declared by workflow "${record.target}" (@Workflow(name, { schedules })): change or remove it there. ` +
      "pause(), resume() and trigger() work on it.",
  );
}
