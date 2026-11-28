# GraphQL Federation v2 (`31-graphql-federation-code-first`)

Bunest counterpart of NestJS's [`sample/31-graphql-federation-code-first`](https://github.com/nestjs/nest/tree/master/sample/31-graphql-federation-code-first) and [`sample/32-graphql-federation-schema-first`](https://github.com/nestjs/nest/tree/master/sample/32-graphql-federation-schema-first):

- **Users Subgraph (`src/users-subgraph/`)**: Code-first `ApolloFederationDriver` with `@Directive('@key(fields: "id")')` and `@ResolveReference()`
- **Posts Subgraph (`src/posts-subgraph/`)**: `ApolloFederationDriver` extending `User` with `bio` and serving `Post` entities
- **Apollo Federation Gateway (`src/gateway/`)**: `ApolloGatewayDriver` + `IntrospectAndCompose` + `RemoteGraphQLDataSource` forwarding authorization headers across subgraphs

## Run

```bash
bun run --cwd examples/graphql-federation dev
bun run --cwd examples/graphql-federation test
```
