# VS Code Extension

The official **Bunest IDE Extension** (`apps/vscode-bunest`) brings Spring-Tools-grade developer experience to **VS Code**, **Cursor**, and **Antigravity IDE**.

## Installation

Download the latest `.vsix` package from GitHub Releases and install it via the CLI:

```bash
code --install-extension vscode-bunest-<version>.vsix
```

Or build and package it directly from the monorepo:

```bash
bun run --cwd apps/vscode-bunest package
```

## Key Features

### 1. Live typegen for repositories

As you edit a repository, the extension updates type suggestions in the editor.

### 2. Declarative Repository Autocomplete & SQL Preview

Inside any `@Repository(Entity)` class extending `CrudRepository<Entity, ID>`:

- **Method name completion**: Suggests valid Spring Data-style derived finder segments (`findBy`, `findAllBy`, `countBy`, `existsBy`, `deleteBy`, `And`, `Or`, `OrderBy`, `Asc`, `Desc`, `Containing`, `Between`, `IsNull`, ...).
- **Inline SQL preview**: Hover over any derived finder method to inspect the exact parameterized SQL statement that `@bunest/orm` will compile at bootstrap.

### 3. Route Explain & Quick Fixes

- Run **Bunest: Explain Route** (or click the CodeLens above a route handler) to inspect the route's owning module, execution pipeline, DI graph, and actionable quick fixes.
- For older code migrating off removed Lombok-style decorators, see [Migrating from class macros](/recipes/class-macros).

### 4. Static Diagnostics (`BUNEST*`)

Catches common mistakes right inside the editor before you even run `bun test`:

- `import type` accidentally used on a DI class, DTO, or ORM entity (which breaks `emitDecoratorMetadata`).
- Missing `@Injectable()` or unregistered providers in `@Module()`.
- Invalid derived finder property names in `@Repository()`.

### 5. Interactive DI Graph & HTTP Studio

- **DI & Module Graph**: Open **Bunest: Show Dependency Graph** to visually explore module imports, exports, providers, and scopes.
- **HTTP Studio & Save as Test**: Click the CodeLens **Run Request** link directly above `@Get`, `@Post`, `@Put`, `@Patch`, or `@Delete` handlers to fire a live request against your local dev server, inspect the JSON response inline, and save it as a sanitized regression test.
