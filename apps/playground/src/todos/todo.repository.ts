import { Span } from "@bunest/observability";
import { CrudRepository, Repository } from "@bunest/orm";
import { Todo } from "./todo.entity";

@Span({ kind: "CLIENT" })
@Repository(Todo)
export abstract class TodoRepository extends CrudRepository<Todo, number> {
  abstract findAllByCompleted(completed: boolean): Promise<Todo[]>;
}
