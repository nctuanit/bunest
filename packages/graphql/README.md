# @bunest/graphql

Code-first and schema-first GraphQL module for Bunest with `@nestjs/graphql` API parity, PubSub and `graphql-ws` subscriptions, DataLoader batching, query depth limiting, Federation v2 schema building, and GraphiQL explorer.

## Features

- **Code-First & Schema-First**: Build schemas from TypeScript decorators (`@ObjectType()`, `@InputType()`, `@ArgsType()`, `@InterfaceType()`, `@Field()`, `@Resolver()`, `@Query()`, `@Mutation()`, `@Subscription()`, `@ResolveField()`) or SDL type definitions (`GraphQLDefinitionsFactory`, `GraphQLTypesLoader`).
- **Subscriptions & WebSockets**: Native `PubSub` + `withFilter()`, `GqlSubscriptionService`, and `GraphQLWsHandler` (`graphql-transport-ws`).
- **DataLoader & Execution Context**: Built-in `BunestDataLoader` for N+1 batching plus `GqlExecutionContext` and `GqlArgumentsHost` for guards, interceptors, pipes, and exception filters.
- **Security & Tooling**: Query depth limiting (`createDepthLimitRule`), GraphiQL HTML explorer (`renderGraphiqlHtml`), schema transforms (`transformSchema`), mapped types (`PartialType`, `PickType`, `OmitType`, `IntersectionType`), and Federation v2 support (`GraphQLFederationFactory`, `@ResolveReference()`).

## Installation

```bash
bun add @bunest/graphql graphql
```

## Quick Start

```ts
import { Module } from "@bunest/common";
import {
  Args,
  Field,
  GraphQLModule,
  ID,
  ObjectType,
  Query,
  Resolver,
} from "@bunest/graphql";

@ObjectType()
export class Book {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;
}

@Resolver(() => Book)
export class BooksResolver {
  @Query(() => Book, { nullable: true })
  book(@Args("id", { type: () => ID }) id: string): Book {
    return { id, title: "Bunest in Action" };
  }
}

@Module({
  imports: [GraphQLModule.forRoot({ autoSchemaFile: true })],
  providers: [BooksResolver],
})
export class AppModule {}
```

## Key Exports

- **Module & Schema Factories**: `GraphQLModule` (`forRoot`, `forRootAsync`), `GraphQLService`, `GraphQLSchemaHost`, `GraphQLSchemaFactory`, `GraphQLSchemaBuilderModule`, `GraphQLFactory`, `GraphQLFederationFactory`, `GraphQLDefinitionsFactory`, `GraphQLFederationDefinitionsFactory`, `GraphQLTypesLoader`, `AbstractGraphQLDriver`
- **Resolver & Type Decorators**: `@Resolver()`, `@Query()`, `@Mutation()`, `@Subscription()`, `@ResolveField()`, `@ResolveProperty()`, `@ResolveReference()`, `@Args()`, `@Parent()`, `@Root()`, `@Context()`, `@Info()`, `@ObjectType()`, `@InputType()`, `@ArgsType()`, `@InterfaceType()`, `@Field()`, `@HideField()`, `@Directive()`, `@Extensions()`, `@Scalar()`, `@UseFieldMiddleware()`, `registerEnumType`, `createUnionType`
- **Mapped Types & Scalars**: `PartialType`, `PickType`, `OmitType`, `IntersectionType`, `ID`, `Int`, `Float`, `GraphQLISODateTime`, `GraphQLTimestamp`, `GraphQLScalarType`
- **Subscriptions, DataLoader & Context**: `PubSub`, `withFilter`, `GqlSubscriptionService`, `GraphQLWsHandler`, `BunestDataLoader`, `GqlExecutionContext`, `GqlArgumentsHost`, `createDepthLimitRule`, `renderGraphiqlHtml`, `transformSchema`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
