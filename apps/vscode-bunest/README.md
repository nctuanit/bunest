# Bunest VS Code Extension (`vscode-bunest`)

First-class IDE experience for the **Bunest** framework on VS Code, Cursor, and Antigravity IDE.

## Clean Architecture: Single-Source `@bunest/cli` Engine + Zero-Save Live IDE Typegen

- **`@bunest/cli`** is the single source of truth for **AST analysis, typegen, diagnostics, and codemods**:
  - `bunest dev` / `bunest typegen` — generates `.bunest/types/bunest.d.ts` in terminal/CI.
  - `bunest check [--fix] [--format json]` — runs all 19 static diagnostics in terminal or CI.
  - `bunest generate repository <Entity> [--dialect sqlite|postgres|mysql]` — generates `@bunest/orm` `CrudRepository` from `@Entity()`.
  - `bunest delombok <fileOrClass>` — expands Class Macro decorators into explicit TypeScript.
  - `bunest codemod <derived-to-query|collapse-logger|sync-di|add-provider> <file>` — surgical `magic-string` codemods.
- **`vscode-bunest`** reuses the exact `@bunest/cli` AST & emitter engine in-memory for **zero-save live DX**:
  - **Live Zero-Save Typegen (`bunest.typegen.live`)**: Continuously updates `.bunest/types/bunest.d.ts` from unsaved `.ts`/`.tsx`/`.env*` editor buffers (~120ms debounce) with syntax validation so autocomplete & types update as you type — no `Cmd+S` required (and reverts cleanly if you close without saving).
  - **Declarative Repository IntelliSense**: Chained derived query autocomplete, multi-dialect SQL Hover/CodeLens, `Cmd+Click` method segment → Entity `@Column`.
  - **Class Macros IDE UX**: Hover & CodeLens generated members tables, undoable `WorkspaceEdit` Delombok/Collapse/Sync refactors.
  - **Cross-Jump Navigation**: Events, RPC, Mongoose Models, Config/`.env` (with automatic `[REDACTED]` secret masking), CQRS, DI Tokens, `@Delegate`.
  - **19 Live Diagnostics + Quick Fixes**, **Inline HTTP Request Runner**, **4 Sidebar Explorers**, and **Interactive DI Module Graph Webview**.
