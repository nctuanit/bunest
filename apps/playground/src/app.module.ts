import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  type OnApplicationBootstrap,
} from "@bunest/core";
import type { BunestApplication } from "@bunest/core";
import {
  DevtoolsModule,
  ObservabilityModule,
  Span,
} from "@bunest/observability";
import {
  Column,
  CrudRepository,
  Entity,
  OrmModule,
  Repository,
  PrimaryGeneratedColumn,
  Transactional,
} from "@bunest/orm";
import {
  ApiOperation,
  ApiTags,
  DocumentBuilder,
  SwaggerModule,
} from "@bunest/swagger";
import { ValidationPipe } from "@bunest/validation";
import { UpdateTodoDto } from "./tasks.dto";

export interface TodoItem {
  readonly id: number;
  readonly title: string;
  readonly completed: boolean;
}

@Entity("todos")
export class Todo implements TodoItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({
    type: "text",
    minLength: 1,
    description: "Todo title",
    example: "Try Bunest Playground",
  })
  title!: string;

  @Column({
    type: "boolean",
    default: false,
    description: "Whether the todo is completed",
    example: false,
  })
  completed!: boolean;
}

@Span({ kind: "CLIENT" })
@Repository(Todo)
export abstract class TodoRepository extends CrudRepository<Todo, number> {
  abstract findAllByCompleted(completed: boolean): Promise<Todo[]>;
}

@Injectable()
export class TodosService implements OnApplicationBootstrap {
  constructor(private readonly todos: TodoRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    if ((await this.todos.count()) === 0) {
      await this.todos.save({
        title: "Try Bunest Playground",
        completed: false,
      });
    }
  }

  @Span("todos.find_all")
  findAll(): Promise<Todo[]> {
    return this.todos.findAll();
  }

  @Span("todos.find_one")
  async findOne(id: number): Promise<Todo> {
    const item = await this.todos.findById(id);
    if (!item) {
      throw new NotFoundException(`Todo #${id} not found`);
    }
    return item;
  }

  @Span("todos.create")
  @Transactional()
  create(
    dto: Pick<TodoItem, "title"> & { readonly completed?: boolean },
  ): Promise<Todo> {
    return this.todos.save({
      title: dto.title,
      completed: dto.completed ?? false,
    });
  }

  @Span("todos.update")
  @Transactional()
  async update(id: number, dto: UpdateTodoDto): Promise<Todo> {
    const existing = await this.findOne(id);
    return this.todos.save({
      id: existing.id,
      title: dto.title ?? existing.title,
      completed: dto.completed ?? existing.completed,
    });
  }

  @Span("todos.remove")
  @Transactional()
  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.todos.deleteById(id);
  }

  getTemplate(): Todo {
    const template = new Todo();
    template.id = 0;
    template.title = "Try Bunest Playground";
    template.completed = false;
    return template;
  }
}

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

@Module({
  imports: [
    OrmModule.forRoot({
      type: "sqlite",
      database: ":memory:",
      synchronize: true,
      autoLoadEntities: true,
      autoRegisterRepositories: true,
    }),
    ObservabilityModule.forRoot({
      tracing: {
        serviceName: "bunest-playground",
        registerGlobalInterceptor: true,
        global: true,
      },
      metrics: {
        path: "/metrics",
        registerGlobalInterceptor: true,
        global: true,
      },
      health: {
        livenessPath: "/health",
        readinessPath: "/ready",
        global: true,
      },
    }),
    DevtoolsModule.forRoot({
      path: "/_devtools",
      global: true,
    }),
  ],
  controllers: [TodosController],
  providers: [TodosService],
})
export class AppModule {}

export function configurePlaygroundApp(app: BunestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Bunest Interactive Playground")
    .setDescription(
      "All-in-one showcase: Decorator-First @Entity + @bunest/orm SQLite synchronize + Swagger + Health + Prometheus Metrics + Devtools",
    )
    .setVersion("0.1.0")
    .addTag("todos")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("/docs", app, document);
}
