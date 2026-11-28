import { Injectable, NotFoundException } from "@bunest/core";
import {
  Cron,
  CronExpression,
  CronJob,
  Interval,
  SchedulerRegistry,
  Timeout,
} from "@bunest/jobs/scheduler";

@Injectable()
export class TasksService {
  public cronRuns = 0;
  public intervalRuns = 0;
  public warmupCompleted = false;
  public readonly dynamicTriggers: string[] = [];

  constructor(private readonly registry: SchedulerRegistry) {}

  @Cron(CronExpression.EVERY_30_SECONDS, { name: "notifications" })
  handleCron(): void {
    this.cronRuns += 1;
  }

  @Interval("heartbeat", 30)
  handleInterval(): void {
    this.intervalRuns += 1;
  }

  @Timeout("warmup", 15)
  handleTimeout(): void {
    this.warmupCompleted = true;
  }

  addDynamicCron(name: string, expression: string): { name: string; nextDate: string } {
    const job = new CronJob(expression, () => {
      this.dynamicTriggers.push(name);
    });
    this.registry.addCronJob(name, job);
    job.start();
    return {
      name,
      nextDate: job.nextDate().toISOString(),
    };
  }

  deleteDynamicCron(name: string): { deleted: string } {
    if (!this.registry.doesExist("cron", name)) {
      throw new NotFoundException(`Cron job "${name}" does not exist`);
    }
    this.registry.deleteCronJob(name);
    return { deleted: name };
  }

  listRegisteredJobs() {
    return {
      crons: [...this.registry.getCronJobs().keys()],
      intervals: this.registry.getIntervals(),
      timeouts: this.registry.getTimeouts(),
    };
  }
}
