# GraphQL & Apollo

Bunest provides full `@nestjs/graphql` v14 and `@nestjs/apollo` parity natively on Bun:

- **`@bunest/graphql`** (**142/142** exports) — Code-first and schema-first GraphQL, `@Resolver`, `@Query`, `@Mutation`, `@Subscription`, `@ResolveField`, `@ObjectType`, `@InputType`, `@InterfaceType`, `createUnionType`, `@Scalar`, `@Directive`, `@UseFilters`, `BunestDataLoader`, Federation v2 Subgraph, and SSE + `graphql-ws` subscriptions.
- **`@bunest/apollo`** (**20/20** exports) — Bun-native `ApolloDriver`, `ApolloFederationDriver` (Federation v2 Subgraph), and `ApolloGatewayDriver` (multi-subgraph gateway).

## Installation

```bash
bun add @bunest/graphql @bunest/apollo graphql
```

## Code-First Quick Start

Register `GraphQLModule.forRoot()` with `ApolloDriver`:

@@filename(app.module.ts)
```ts
import { Module } from "@bunest/core";
import { GraphQLModule } from "@bunest/graphql";
import { ApolloDriver, type ApolloDriverConfig } from "@bunest/apollo";
import { BooksResolver } from "./books.resolver";

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      path: "/graphql",
    }),
  ],
  providers: [BooksResolver],
})
export class AppModule {}
```

Define object types and resolvers using familiar decorators:

@@filename(books.resolver.ts)
```ts
import { Args, Field, ID, ObjectType, Query, Resolver } from "@bunest/graphql";

@ObjectType()
export class Book {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;
}

@Resolver(() => Book)
export class BooksResolver {
  @Query(() => [Book])
  books(): Book[] {
    return [{ id: "1", title: "Bunest in Action" }];
  }

  @Query(() => Book, { nullable: true })
  book(@Args("id") id: string): Book | null {
    return id === "1" ? { id: "1", title: "Bunest in Action" } : null;
  }
}
```

## Federation v2 & DataLoader

- Use `ApolloFederationDriver` for subgraphs (`@Directive('@key(fields: "id")')`, `@ResolveReference()`) and `ApolloGatewayDriver` to compose multiple subgraphs into a unified gateway.
- Batch N+1 field lookups with `BunestDataLoader` scoped per request.
- Stream real-time updates over either `graphql-ws` WebSockets or HTTP Server-Sent Events (SSE).
