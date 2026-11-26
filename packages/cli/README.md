# @bunest/cli

Bun-native CLI (`bunest`) for scaffolding projects, generating schematics, running dev watch mode, starting builds, inspecting environment info, and launching interactive REPL sessions.

## Features

- **Project Scaffolding & Schematics**: Create new Bunest projects (`bunest new`) and generate controllers, services, modules, guards, pipes, interceptors, filters, and resources (`bunest generate`).
- **Build & Dev Workflows**: Run development watch mode (`bunest dev`), production builds (`bunest build`), application startup (`bunest start`), library installation (`bunest add`), upgrades (`bunest upgrade`), and deployments (`bunest deploy`).
- **Interactive REPL & Diagnostics**: Launch an interactive DI-aware REPL (`bunest repl`) and print runtime/workspace info (`bunest info`).
- **Metadata Plugin**: `bunestMetadataPlugin` and `generateMetadataFile` extract controller and DTO metadata at build time for OpenAPI/Swagger and validation tooling.

## Installation

```bash
bun add -d @bunest/cli
```

## Quick Start

```bash
# Scaffold a new Bunest project
bunx bunest new my-app

# Generate a new resource schematic
bunx bunest generate resource users

# Start development server with watch mode
bunx bunest dev

# Build for production
bunx bunest build
```

## P0 DX Workflows

```bash
# Scaffold a REST + SQLite starter project
bunx bunest new orders-api --preset rest-sqlite

# Generate a CRUD resource with .http request scenarios and regression spec
bunx bunest generate resource orders --with-scenario

# Run dev server — prints the actual bound Listening URL once app.listen() succeeds (with port fallback)
bunx bunest dev

# Verify typecheck, static diagnostics, and tests; fail if a test filter matches 0 tests
bunx bunest verify orders --require-tests --reporter=agent

# Inspect Bunest environment and offline-resolved package versions (pretty or JSON)
bunx bunest info --format json

# Explain a route's owning module, pipeline, DI graph, and quick fixes
bunx bunest explain route "POST /orders" --format json

# Explain a BUNEST_E* error code directly from the terminal (same catalog as MCP)
bunx bunest explain error BUNEST_E001 --format json

# Snapshot static-scanned HTTP routes and @Body() DTO validation contracts
bunx bunest routes snapshot --body --out routes-base.json

# Diff two route snapshots with @Body() contract analysis and optional replay evidence
bunx bunest routes diff routes-base.json routes-head.json --body --evidence evidence.json --format pretty

# Diff current static-scanned HTTP routes against a saved base manifest
bunx bunest routes diff --base routes-base.json --body --format pretty

# Generate sanitized regression tests from a .http or RequestScenarioV1 JSON file
bunx bunest test-from-request src/orders/orders.http --dry-run --format diff
```

Programmatic usage:

```ts
import { runCli } from "@bunest/cli";

const result = await runCli(["info"]);
console.log(result.exitCode);
```

## Key Exports

- **CLI Runner & Parser**: `runCli`, `parseCliArgs`, `HELP_TEXT`, `CLI_VERSION`
- **Commands**: `createProject`, `generateSchematic`, `buildProject`, `runDevServer`, `runStartCommand`, `addLibrary`, `upgradeProject`, `deployProject`, `runReplCommand`, `getEnvironmentInfo`, `formatEnvironmentInfo`
- **Configuration**: `loadCliConfiguration`, `resolveProjectConfiguration`, `resolveEntryFile`, `AVAILABLE_BUILDERS`, `DEFAULT_CONFIGURATION`
- **Metadata Plugin**: `bunestMetadataPlugin`, `generateMetadataFile`, `transformControllerMetadataSource`, `transformDtoMetadataSource`
- **Templates & Utilities**: `buildProjectTemplateFiles`, `buildSchematicFiles`, `resolveSchematicType`, `SCHEMATIC_ALIASES`, `writePlannedFiles`, `FileCollisionError`, `parseSchematicName`, `validateProjectName`, `resolveSafeChildPath`, `toCamelCase`, `toKebabCase`, `toPascalCase`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
