# GraphQL Schema-First (`12-graphql-schema-first`)

Bunest counterpart of NestJS's [`sample/12-graphql-schema-first`](https://github.com/nestjs/nest/tree/master/sample/12-graphql-schema-first):

- **SDL Schema (`src/cats/cats.graphql`)**: Loaded directly from `.graphql` SDL via `GraphQLModule.forRoot({ typeDefs })`
- **DI Resolvers**: `@Resolver("Cat")` with `@Query("cats")`, `@Query("cat")`, `@Mutation("createCat")`, and `@ResolveField("owner")`
- **GraphQL Guard**: `CatsGuard` inspecting request context through `GqlExecutionContext.create(context)`

## Run

```bash
bun run --cwd examples/graphql-schema-first dev
bun run --cwd examples/graphql-schema-first test
```
