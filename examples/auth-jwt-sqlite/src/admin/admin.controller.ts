import { Controller, Get } from "@bunest/core";
import { OrmMigrationRunner } from "@bunest/orm";
import { Roles } from "@bunest/security";
import { TasksService } from "../tasks/tasks.service";

@Controller("/admin")
export class AdminController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly migrations: OrmMigrationRunner,
  ) {}

  @Roles("admin")
  @Get("/stats")
  async stats() {
    const migrationStatus = await this.migrations.status();
    return {
      ...(await this.tasksService.getAdminStats()),
      appliedMigrations: migrationStatus.applied.map((m) => m.id),
    };
  }
}
