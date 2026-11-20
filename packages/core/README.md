# @bunest/core

Core dependency injection container, module graph, lifecycle manager, AOP aspect weaver, continuation-local storage, and application factory for Bunest.

## Features

- **Application Factory**: `BunestFactory` (aliased as `NestFactory`) creates HTTP applications (`BunestApplication`), standalone contexts (`BunestApplicationContext`), and microservices (`BunestMicroserviceApplication`).
- **DI Container & Scopes**: `DIContainer`, `ModuleRef`, `ModulesContainer`, `RequestContainer`, `ContextIdFactory`, `LazyModuleLoader`, and strict circular/scope-leak diagnostics.
- **Discovery & Graph Inspection**: `DiscoveryModule`, `DiscoveryService`, `MetadataScanner`, `GraphInspector`, `SerializedGraph`, `PartialGraphHost`, and interactive `repl()`.
- **Routing & Continuation-Local Storage**: Hierarchical `RouterModule`, `CoreMiddlewareConsumer`, and built-in `ClsModule` / `ClsService` / `@WithCls()` powered by `AsyncLocalStorage`.
- **Service-Layer AOP**: Method aspect weaving (`weaveInstanceMethodAspects`, `weaveProxyMethodAspects`) used across Bunest modules (`@Cacheable`, `@WithLock`, `@EmitEvent`, etc.).

## Installation

```bash
bun add @bunest/core @bunest/common reflect-metadata
```

## Quick Start

```ts
import "reflect-metadata";
import { Controller, Get, Module } from "@bunest/common";
import { BunestFactory } from "@bunest/core";

@Controller("hello")
class HelloController {
  @Get()
  sayHello() {
    return { message: "Hello from Bunest!" };
  }
}

@Module({
  controllers: [HelloController],
})
class AppModule {}

const app = await BunestFactory.create(AppModule);
await app.listen(3000);
```

## Key Exports

- **Application & Factory**: `BunestFactory` (`NestFactory`), `BunestApplication` (`NestApplication`), `BunestApplicationContext` (`NestApplicationContext`), `BunestMicroserviceApplication`, `ApplicationConfig`, `HttpAdapterHost`, `BaseExceptionFilter`, `ExternalContextCreator`
- **DI & Module System**: `DIContainer` (`NestContainer`), `ModuleRef`, `ModulesContainer`, `RequestContainer`, `ModuleScanner`, `ModuleNode`, `LazyModuleLoader`, `ContextIdFactory`, `createContextId`, `LifecycleManager`, `CoreMiddlewareConsumer`, `RouterModule`
- **Discovery & Inspection**: `DiscoveryModule`, `DiscoveryService`, `MetadataScanner`, `GraphInspector`, `SerializedGraph`, `PartialGraphHost`, `InitializeOnPreviewAllowlist`, `repl`, `createReplContext`
- **CLS & AOP**: `ClsModule`, `ClsService`, `ClsMiddleware`, `ClsInterceptor`, `@WithCls()`, `WithClsAspect`, `CLS_ID`, `CLS_MODULE_OPTIONS`, `weaveInstanceMethodAspects`, `weaveProxyMethodAspects`
- **Core Exceptions**: `CoreBootstrapException`, `CircularDependencyException`, `UnknownDependencyException`, `AmbiguousProviderException`, `DuplicateProviderException`, `InvalidModuleException`, `InvalidExportException`, `ScopeLeakException`
- **Re-exports**: Full `@bunest/common` surface, public `@bunest/http` APIs (`AbstractHttpAdapter`, `BunHttpAdapter`, `ServeStaticModule`, etc.), and `SchemaValidationPipe` from `@bunest/validation`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
