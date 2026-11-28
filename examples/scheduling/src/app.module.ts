import { Module } from "@bunest/core";
import { ScheduleModule } from "@bunest/jobs/scheduler";
import { TasksModule } from "./tasks/tasks.module";

@Module({
  imports: [ScheduleModule.forRoot(), TasksModule],
})
export class AppModule {}
