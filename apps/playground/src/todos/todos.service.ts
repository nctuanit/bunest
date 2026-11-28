import {
  Injectable,
  NotFoundException,
  type OnApplicationBootstrap,
} from "@bunest/core";
import { Span } from "@bunest/observability";
import { Transactional } from "@bunest/orm";
import { Todo, type TodoItem } from "./todo.entity";
import { TodoRepository } from "./todo.repository";
import { UpdateTodoDto } from "./update-todo.dto";

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
