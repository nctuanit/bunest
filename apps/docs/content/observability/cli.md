# CLI

**`@bunest/cli`** is Bunest's zero-dependency command-line interface for scaffolding projects, generating NestJS-style schematics, running watch-mode dev servers, bundling production builds with `Bun.build()`, launching the interactive DI REPL, and inspecting your environment.

## Installation

```bash
bun add -d @bunest/cli
# or run directly with bunx:
bunx @bunest/cli --help
```

## Commands

| Command | Description |
|---|---|
| `bunest new <name>` | Scaffold a new Bunest TypeScript project with `tsconfig.json`, `reflect-metadata`, and `bun:test` setup |
| `bunest generate <schematic> <name>` (`g`) | Generate controllers, services, modules, DTOs, guards, pipes, interceptors, filters, middleware, endpoints, or full CRUD resources |
| `bunest dev` | Run your application in Bun watch mode (`--port`, `--entry`) |
| `bunest build` | Bundle your application for production via `Bun.build()` (`--minify`, `--outfile`) |
| `bunest repl` | Start an interactive DI REPL against your compiled `AppModule` |
| `bunest info` | Print Bunest, Bun runtime, and OS environment diagnostics |

## Quick Reference

```bash
# Scaffold a new API
bunx @bunest/cli new my-api

# Generate a full CRUD resource (module + controller + service + DTOs + spec)
bunx @bunest/cli g resource users

# Generate a controller without spec file
bunx @bunest/cli g co orders --no-spec

# Run dev server
bunx @bunest/cli dev --port 3000

# Production bundle with Bun.build()
bunx @bunest/cli build --minify
```

## Build-Time Metadata Plugin (`bunestMetadataPlugin`)

Exported from `@bunest/cli`, `bunestMetadataPlugin()` plugs directly into `Bun.build({ plugins: [bunestMetadataPlugin()] })` to emit Swagger/DTO property reflection metadata at bundle time.
