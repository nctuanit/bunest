import { afterAll, beforeAll, expect, it } from "bun:test";
import { printSchema } from "../../../../../packages/graphql/src";
import { Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  Field,
  GraphQLModule,
  GraphQLSchemaHost,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  type ReturnTypeFunc,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@ObjectType()
class Todo {
  @Field()
  title!: string;
}

@ObjectType()
class AddTodoPayload {
  @Field(() => Todo)
  todo!: Todo;

  @Field((() => "Query") as unknown as ReturnTypeFunc)
  query!: object;
}

@Resolver()
class TodosResolver {
  private readonly todosList: Todo[] = [{ title: "first" }];

  @Query(() => [Todo])
  todos(): Todo[] {
    return this.todosList;
  }

  @Query(() => Number)
  todoCount(): number {
    return this.todosList.length;
  }

  @Mutation(() => AddTodoPayload)
  addTodo(@Args("title") title: string): AddTodoPayload {
    const todo = { title };
    this.todosList.push(todo);
    return { todo, query: {} };
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      autoSchemaFile: true,
    }),
  ],
  providers: [TodosResolver],
})
class MutationPayloadQueryModule {}

describeConformance(
  "Code-first mutation payload query",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/code-first-mutation-payload-query.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo code-first mutation payload root Query exposure E2E to native @bunest/graphql over zero-socket HTTP requests.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MutationPayloadQueryModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it("should expose the root Query type on the mutation payload", () => {
      const { schema } = app.get(GraphQLSchemaHost);
      expect(printSchema(schema)).toContain(
        "type AddTodoPayload {\n  todo: Todo!\n  query: Query!\n}",
      );
    });

    it("should resolve root queries through the mutation payload", async () => {
      const { body } = await request(app)
        .post("/graphql")
        .send({
          query: `
            mutation {
              addTodo(title: "second") {
                todo { title }
                query {
                  todoCount
                  todos { title }
                }
              }
            }
          `,
        })
        .expect(200);

      expect(body).toEqual({
        data: {
          addTodo: {
            todo: { title: "second" },
            query: {
              todoCount: 2,
              todos: [{ title: "first" }, { title: "second" }],
            },
          },
        },
      });
    });
  },
);
