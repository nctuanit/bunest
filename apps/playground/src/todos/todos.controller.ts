import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from "@bunest/core";
import { ApiOperation, ApiTags } from "@bunest/swagger";
import { Todo } from "./todo.entity";
import { TodosService } from "./todos.service";
import { UpdateTodoDto } from "./update-todo.dto";

@ApiTags("todos")
@Controller("/todos")
export class TodosController {
  constructor(private readonly todosService: TodosService) {}

  @ApiOperation({ summary: "List all todos" })
  @Get()
  list(): Promise<Todo[]> {
    return this.todosService.findAll();
  }

  @ApiOperation({ summary: "Get default todo schema template" })
  @Get("template")
  getTemplate(): Todo {
    return this.todosService.getTemplate();
  }

  @ApiOperation({ summary: "Get a todo by ID" })
  @Get(":id")
  getOne(@Param("id", ParseIntPipe) id: number): Promise<Todo> {
    return this.todosService.findOne(id);
  }

  @ApiOperation({ summary: "Create a new todo" })
  @Post()
  create(@Body() dto: Todo): Promise<Todo> {
    return this.todosService.create(dto);
  }

  @ApiOperation({ summary: "Update a todo" })
  @Patch(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateTodoDto,
  ): Promise<Todo> {
    return this.todosService.update(id, dto);
  }

  @ApiOperation({ summary: "Delete a todo" })
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param("id", ParseIntPipe) id: number): Promise<void> {
    return this.todosService.remove(id);
  }
}
