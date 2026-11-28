import { Body, Controller, Get, Post } from "@bunest/core";
import { CurrentUser } from "@bunest/security";
import type { AuthenticatedUser } from "../auth/auth.service";
import { CreateTaskDto } from "./create-task.dto";
import { TasksService } from "./tasks.service";

@Controller("/tasks")
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTaskDto) {
    return this.tasksService.createTransactional(Number(user.sub), dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.tasksService.listForUser(Number(user.sub));
  }
}
