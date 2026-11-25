# VS Code Extension

The official **Bunest IDE Extension** (`apps/vscode-bunest`) brings Spring-Tools and Lombok-grade developer experience to **VS Code**, **Cursor**, and **Antigravity IDE**.

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

### 1. Live Zero-Save Typegen for Macros & Repositories

As you type `@Data()`, `@Builder()`, `@With()`, or declarative `@OrmRepository()` finder methods, the extension synthesizes ambient `.d.ts` definitions in real time—giving you full TypeScript autocomplete and type checking **without saving or running a build step**.

### 2. Declarative Repository Autocomplete & SQL Preview

Inside any `@OrmRepository(Entity)` class extending `CrudRepository<Entity, ID>`:

- **Method name completion**: Suggests valid Spring Data-style derived finder segments (`findBy`, `findAllBy`, `countBy`, `existsBy`, `deleteBy`, `And`, `Or`, `OrderBy`, `Asc`, `Desc`, `Containing`, `Between`, `IsNull`, ...).
- **Inline SQL preview**: Hover over any derived finder method to inspect the exact parameterized SQL statement that `@bunest/orm` will compile at bootstrap.

### 3. Class Macro Hover & Delombok

- Hover over `@Data()`, `@Value()`, `@Builder()`, `@Getter()`, `@Setter()`, or `@With()` to inspect all generated methods and signatures.
- Run **Bunest: Preview Delombok** from the Command Palette to view the expanded equivalent TypeScript code side-by-side.

### 4. Static Diagnostics (`BUNEST*`)

Catches common mistakes right inside the editor before you even run `bun test`:

- `import type` accidentally used on a DI class, DTO, or ORM entity (which breaks `emitDecoratorMetadata`).
- Missing `@Injectable()` or unregistered providers in `@Module()`.
- Conflicting class macro combinations (e.g., `@Value()` combined with `@Setter()`).
- Invalid derived finder property names in `@OrmRepository()`.

### 5. Interactive DI Graph & Inline HTTP Runner

- **DI & Module Graph**: Open **Bunest: Show Dependency Graph** to visually explore module imports, exports, providers, and scopes.
- **Inline HTTP Runner**: Click the CodeLens **Run Request** link directly above `@Get`, `@Post`, `@Put`, `@Patch`, or `@Delete` handlers to fire a live request against your local dev server and inspect the JSON response inline.
