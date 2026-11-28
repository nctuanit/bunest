import { Body, Controller, Delete, Get, Param, Post } from "@bunest/core";
import { TasksService } from "./tasks.service";

@Controller("tasks")
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get("status")
  getStatus() {
    return {
      cronRuns: this.tasks.cronRuns,
      intervalRuns: this.tasks.intervalRuns,
      warmupCompleted: this.tasks.warmupCompleted,
      dynamicTriggers: [...this.tasks.dynamicTriggers],
    };
  }

  @Get("jobs")
  listJobs() {
    return this.tasks.listRegisteredJobs();
  }

  @Post("cron")
  addCron(@Body() body: { name: string; expression: string }) {
    return this.tasks.addDynamicCron(body.name, body.expression);
  }

  @Delete("cron/:name")
  removeCron(@Param("name") name: string) {
    return this.tasks.deleteDynamicCron(name);
  }
}
