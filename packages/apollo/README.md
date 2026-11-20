# @bunest/apollo

Bun-native Apollo GraphQL drivers (`ApolloDriver`, `ApolloFederationDriver`, `ApolloGatewayDriver`) with full `@nestjs/apollo` API parity and zero external Apollo npm runtime dependencies.

## Features

- **`ApolloDriver`**: Runs on `@bunest/graphql` and native `Bun.serve` with full Apollo Server plugin lifecycle hooks (`serverWillStart`, `requestDidStart`, `parsingDidStart`, `validationDidStart`, `didResolveOperation`, `responseForOperation`, `executionDidStart`, `didEncounterErrors`, `willSendResponse`), `@Plugin()` discovery (`PluginsExplorerService`), GraphiQL landing page, batched HTTP requests, Automatic Persisted Queries, CSRF prevention, and automatic `HttpException` mapping.
- **`ApolloFederationDriver`**: Builds Apollo Federation v2 Subgraphs (`_service { sdl }`, `_entities`, `@ResolveReference`) via `@bunest/graphql`'s `GraphQLFederationFactory`.
- **`ApolloGatewayDriver`**: Multi-subgraph schema composition and query forwarding over native `fetch()` (`ApolloGateway`, `IntrospectAndCompose`, `RemoteGraphQLDataSource`), with live `transformSchema` support.
- **Apollo Error Classes**: `ApolloError`, `AuthenticationError`, `ForbiddenError`, `UserInputError`, and `ValidationError`.
- **Server Access**: `getApolloServer(app)` retrieves the live `BunestApolloServer` instance (`executeOperation`, `start`, `stop`, `schema`).

## Installation

```bash
bun add @bunest/apollo @bunest/graphql graphql
```

## Quick Start

```ts
import { Module } from "@bunest/common";
import { GraphQLModule, Query, Resolver } from "@bunest/graphql";
import { ApolloDriver, type ApolloDriverConfig } from "@bunest/apollo";

@Resolver()
export class HealthResolver {
  @Query(() => String)
  health(): string {
    return "ok";
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
    }),
  ],
  providers: [HealthResolver],
})
export class AppModule {}
```

## Key Exports

- **Drivers**: `ApolloBaseDriver`, `ApolloDriver`, `ApolloFederationDriver`, `ApolloGatewayDriver`
- **Server & Federation**: `BunestApolloServer`, `ApolloGateway`, `IntrospectAndCompose`, `RemoteGraphQLDataSource`, `ApolloFederationDefinitionsFactory`, `getApolloServer`, `createApolloSchema`, `unwrapResolverError`, `HeaderMap`
- **Plugins & Decorators**: `@Plugin()`, `PLUGIN_METADATA`, `PluginsExplorerService`, `ApolloServerPluginDrainHttpServer`, `ApolloServerPluginLandingPageLocalDefault`, `ApolloServerPluginLandingPageDisabled`, `GraphiQLPlaygroundPlugin`, `GraphiQLHTMLFactory`
- **Errors & Constants**: `ApolloError`, `AuthenticationError`, `ForbiddenError`, `UserInputError`, `ValidationError`, `ApolloServerErrorCode`
- **Utilities**: `createAsyncIterator`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
