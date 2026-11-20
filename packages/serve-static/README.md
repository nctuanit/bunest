# @bunest/serve-static

Drop-in 1:1 NestJS `@nestjs/serve-static` (v12) migration facade for **Bunest**, powered natively by `@bunest/http` and `Bun.file()` with zero external runtime dependencies.

## Features

- **Drop-In `@nestjs/serve-static` Parity**: Replace `@nestjs/serve-static` imports with `@bunest/serve-static` verbatim.
- **Native `Bun.file()` Streaming**: Serves static assets and SPA fallback files directly through `@bunest/http` without Express or Fastify middleware.
- **Flexible Configuration**: Supports synchronous `forRoot()` and asynchronous `forRootAsync()`, multiple mount points, `serveRoot`, `exclude`, `renderPath`, and `Cache-Control` `maxAge`.
- **Pluggable Loaders**: Includes `BunStaticLoader`, `AbstractLoader`, and `NoopLoader`.

## Installation

```bash
bun add @bunest/serve-static
```

## Quick Start

```ts
import { join } from "node:path";
import { Module } from "@bunest/common";
import { ServeStaticModule } from "@bunest/serve-static";

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), "public"),
      serveRoot: "/static",
      exclude: ["/api/(.*)"],
    }),
  ],
})
export class AppModule {}
```

## Key Exports

- **Module & Loaders**: `ServeStaticModule` (`forRoot`, `forRootAsync`), `BunStaticLoader`, `AbstractLoader`, `NoopLoader`, `serveStaticProviders`
- **Constants**: `SERVE_STATIC_MODULE_OPTIONS`, `DEFAULT_ROOT_PATH`, `DEFAULT_RENDER_PATH`, `DEFAULT_EXPRESS_RENDER_PATH`, `DEFAULT_FASTIFY_RENDER_PATH`, `BUNEST_APPLICATION_CONFIG_TOKEN`, `BUNEST_HTTP_ADAPTER_HOST_TOKEN`
- **Static Asset Utilities**: `createStaticAssetsMount`, `tryServeStaticAsset`, `parseMaxAgeSeconds`
- **Types**: `ServeStaticModuleOptions`, `ServeStaticModuleAsyncOptions`, `ServeStaticModuleOptionsFactory`, `ExtendedStaticAssetsOptions`, `StaticAssetsMount`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
