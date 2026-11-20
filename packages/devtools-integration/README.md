# @bunest/devtools-integration

Drop-in 1:1 `@nestjs/devtools-integration` (v12) migration facade for Bunest, powered natively by `@bunest/observability` with zero external runtime dependencies.

## Features

- **Drop-In `@nestjs/devtools-integration` Parity**: Replace `@nestjs/devtools-integration` imports with `@bunest/devtools-integration` verbatim.
- **Application Graph Introspection**: Inspect modules, providers, controllers, routes, and dependency edges via `DevtoolsService` (`getGraph`, `getRoutes`, `toMermaidGraph`, `getSerializedGraph`).
- **Graph Publishing**: Publish serialized application graphs with `GraphPublisher.publish()`.
- **Sync & Async Registration**: `DevtoolsModule.register()`, `registerAsync()`, `forRoot()`, and `forRootAsync()`.

## Installation

```bash
bun add @bunest/devtools-integration
```

## Quick Start

```ts
import { Module } from "@bunest/common";
import { DevtoolsModule } from "@bunest/devtools-integration";

@Module({
  imports: [
    DevtoolsModule.register({
      http: process.env.NODE_ENV !== "production",
    }),
  ],
})
export class AppModule {}
```

## Key Exports

- **Module & Services**: `DevtoolsModule` (`register`, `registerAsync`, `forRoot`, `forRootAsync`), `DevtoolsService`, `GraphPublisher`
- **Tokens**: `DEVTOOLS_OPTIONS`
- **Types**: `DevtoolsModuleOptions`, `DevtoolsModuleAsyncOptions`, `DevtoolsOptionsFactory`, `PublishGraphOptions`, `GraphPublisherResponse`, `DevtoolsApplicationGraph`, `DevtoolsModuleNode`, `DevtoolsProviderNode`, `DevtoolsControllerNode`, `DevtoolsRouteNode`, `DevtoolsGraphEdge`, `DevtoolsTarget`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
