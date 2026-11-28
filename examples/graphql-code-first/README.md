# GraphQL Code-First (`23-graphql-code-first`)

Bunest counterpart of NestJS's [`sample/23-graphql-code-first`](https://github.com/nestjs/nest/tree/master/sample/23-graphql-code-first), powered by zero-dependency `@bunest/graphql` + `@bunest/graphql/apollo`:

- **Code-First Schema**: `@ObjectType()`, `@InputType()`, `@ArgsType()`, `@Field()`, and automatic SDL generation
- **Resolvers**: `@Resolver(() => Recipe)`, `@Query`, `@Mutation`, `@ResolveField`, and `@Subscription` with `PubSub`
- **DTO Validation**: `@bunest/validation/validator` decorators validated by `ValidationPipe` on GraphQL mutation inputs
- **GraphiQL Explorer**: Enabled at `GET /graphql`

## Run

```bash
bun run --cwd examples/graphql-code-first dev
bun run --cwd examples/graphql-code-first test
```
