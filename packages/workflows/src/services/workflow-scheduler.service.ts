import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@bunest/core";
import type { ScheduleRecord } from "../core/interfaces/schedule-store.interface";
import type {
  DeclaredSchedule,
  DueOccurrence,
  ScheduleProduction,
  ScheduleSkip,
} from "../core/interfaces/scheduler-options.interface";
import { occurrenceId } from "../core/scheduling/schedule-spec";
import { Scheduler } from "../core/scheduling/scheduler";
import { systemClock } from "../core/time/clock";
import { WorkflowStateError } from "../errors/workflow-state.error";
import { WorkflowEvents } from "../events/workflow-events.service";
import type { WorkflowClock } from "../interfaces/workflow-clock.interface";
import type { WorkflowMetadata } from "../interfaces/workflow-decorator-options.interface";
import type {
  WorkflowInstance,
  WorkflowStatus,
} from "../interfaces/workflow-instance.interface";
import type {
  WorkflowSchedule,
  WorkflowScheduleSpec,
} from "../interfaces/workflow-schedule.interface";
import type { WorkflowsModuleOptions } from "../interfaces/workflows-module-options.interface";
import type { EncodedWorkflowStore } from "../storage/encoded-workflow.store";
import {
  ENGINE_STORE,
  PAYLOAD_CODECS,
  WorkflowStorage,
} from "../storage/workflow.storage";
import { newInstance } from "../utils/new-instance.util";
import { workflowScheduleStore } from "../utils/schedule-store.util";
import {
  unstorableJson,
  type TextCheck,
  type TextPlace,
} from "../utils/storable-text.util";
import { WORKFLOWS_MODULE_OPTIONS } from "../workflows.module-definition";
import { WorkflowRegistry } from "./workflow-registry.service";

const RUNNING_PAGE = 100;
const UNFINISHED: WorkflowStatus[] = [
  "pending",
  "running",
  "suspended",
  "compensating",
];

/**
 * @internal Workflows' schedules on the core's `Scheduler`.
 */
@Injectable()
export class WorkflowScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger("Workflows");
  private readonly clock: WorkflowClock;
  readonly engine: Scheduler<WorkflowScheduleSpec>;
  private declarations?: Map<string, DeclaredSchedule<WorkflowScheduleSpec>>;

  constructor(
    private readonly storage: WorkflowStorage,
    @Inject(WORKFLOWS_MODULE_OPTIONS)
    options: WorkflowsModuleOptions,
    private readonly registry: WorkflowRegistry,
    private readonly events: WorkflowEvents,
  ) {
    this.clock = options.clock ?? systemClock;
    this.engine = new Scheduler<WorkflowScheduleSpec>({
      store: workflowScheduleStore(() => storage.source),
      clock: this.clock,
      codecs: storage[PAYLOAD_CODECS],
      payloadContext: (schedule) => ({ field: "input", schedule }),
      targets: () => registry.names(),
      declared: () => this.declared(),
      fire: (occurrence) => this.fire(occurrence),
      running: (schedule) => this.running(schedule.id),
      cancel: (id, reason, now) =>
        this.store.requestCancel(id, { reason, now, terminate: false }),
      skipped: (schedule, skip, now) => this.skipped(schedule, skip, now),
      conflictError: (message) => new WorkflowStateError(message),
      labels: {
        target: (name) => `workflow "${name}"`,
        targets: "workflows",
        payload: "input",
        upsert: "WorkflowSchedules.upsert()",
      },
      logger: this.logger,
    });
  }

  private get store(): EncodedWorkflowStore {
    return this.storage[ENGINE_STORE];
  }

  textCheck(place: TextPlace): TextCheck | undefined {
    return this.store.textCheck(place);
  }

  async onApplicationBootstrap(): Promise<void> {
    this.registry.schedules();
    try {
      await this.engine.synced();
    } catch (error) {
      this.logger.error(
        "Saving the schedules the workflows declare failed; the worker tries again before it starts any.",
        error,
      );
    }
  }

  produce(owner: string, leaseMs: number): Promise<ScheduleProduction> {
    return this.engine.produce(owner, leaseMs);
  }

  declaration(id: string): DeclaredSchedule<WorkflowScheduleSpec> | undefined {
    return this.declared().get(id);
  }

  async startOccurrence(
    record: ScheduleRecord,
    spec: WorkflowScheduleSpec,
    declared: DeclaredSchedule<WorkflowScheduleSpec> | undefined,
    workflow: WorkflowMetadata,
    at: number,
    now: number,
    rethrow = false,
  ): Promise<{ instance: WorkflowInstance; created: boolean } | null> {
    const id = occurrenceId(record.id, at);
    let data;
    try {
      const source = declared ? declared.payload : record.payload;
      const input =
        typeof source === "function"
          ? (source as (occ: { id: string; at: number }) => unknown)({
              id: record.id,
              at,
            })
          : source;
      data = newInstance(workflow, id, input ?? undefined, {
        caller: `Schedule "${record.id}"`,
        now,
        priority: spec.priority === 0 ? undefined : spec.priority,
        scheduleId: record.id,
        scheduledAt: at,
        text: this.store.textCheck,
      });
    } catch (error) {
      if (rethrow) {
        throw error;
      }
      this.logger.error(
        `Schedule "${record.id}" couldn't start its occurrence of ${new Date(at).toISOString()}: ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
    const stored = await this.store.create(data);
    if (
      !stored.created &&
      (stored.instance.workflow !== data.workflow ||
        stored.instance.scheduleId !== record.id)
    ) {
      this.logger.warn(
        `Schedule "${record.id}" didn't start its occurrence of ${new Date(at).toISOString()}: instance "${id}" exists and isn't the schedule's.`,
      );
    }
    return stored;
  }

  view(record: ScheduleRecord): WorkflowSchedule {
    const spec = record.spec as WorkflowScheduleSpec;
    const { nextAt, runs, bufferedAt } = this.engine.progress(record);
    return {
      id: record.id,
      workflow: record.target,
      version: spec.version,
      declared: record.declared,
      ...(spec.cron !== undefined ? { cron: spec.cron } : {}),
      ...(spec.every !== undefined ? { every: spec.every } : {}),
      ...(spec.rrule !== undefined ? { rrule: spec.rrule } : {}),
      tz: spec.tz,
      startAt: spec.startAt,
      endAt: spec.endAt,
      limit: spec.limit,
      missed: spec.missed,
      overlap: spec.overlap,
      priority: spec.priority,
      ...(spec.inputFn || record.payload === null
        ? {}
        : { input: record.payload }),
      paused: record.paused,
      nextAt,
      runs,
      bufferedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async readableView(record: ScheduleRecord): Promise<WorkflowSchedule> {
    return this.view(await this.engine.readable(record));
  }

  private declared(): Map<string, DeclaredSchedule<WorkflowScheduleSpec>> {
    this.declarations ??= new Map(
      [...this.registry.schedules()]
        .filter(([id, schedule]) => this.storable(id, schedule.input))
        .map(([id, schedule]) => [
          id,
          {
            id,
            target: schedule.workflow,
            version: this.registry.latest(schedule.workflow)!.version,
            spec: schedule.spec,
            payload: schedule.input,
          },
        ]),
    );
    return this.declarations;
  }

  private storable(id: string, input: unknown): boolean {
    const refused =
      typeof input === "function"
        ? undefined
        : unstorableJson(
            `Schedule "${id}": its input`,
            input,
            this.store.textCheck("payload"),
          );
    if (refused) {
      this.logger.error(
        `${refused.message} The schedule isn't saved, and doesn't start its workflow.`,
      );
    }
    return !refused;
  }

  private async fire({
    schedule,
    spec,
    declared,
    at,
    now,
  }: DueOccurrence<WorkflowScheduleSpec>): Promise<{
    created: boolean;
  } | null> {
    const workflow = this.registry.resolve(
      schedule.target,
      spec.version ?? undefined,
    );
    const started = await this.startOccurrence(
      schedule,
      spec,
      declared,
      workflow,
      at,
      now,
    );
    return started && { created: started.created };
  }

  private async running(schedule: string): Promise<string[]> {
    const instances = await this.store.inner.list({
      scheduleId: schedule,
      status: UNFINISHED,
      limit: RUNNING_PAGE,
      offset: 0,
    });
    return instances.map((instance) => instance.id);
  }

  private skipped(
    schedule: ScheduleRecord,
    skip: ScheduleSkip,
    now: number,
  ): void {
    const spec = schedule.spec as WorkflowScheduleSpec;
    const workflow = this.registry.resolve(
      schedule.target,
      spec.version ?? undefined,
    );
    this.events.emit({
      type: "schedule-skipped",
      id: schedule.id,
      workflow: workflow.name,
      version: workflow.version,
      at: now,
      ...skip,
    });
  }
}
