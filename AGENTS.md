# AGENTS.md — Bunest framework repository

Instructions for AI coding agents (Antigravity, Claude Code, Cursor, Codex, …) working **on the Bunest framework itself**.
For apps built *with* Bunest, `bunest new` scaffolds a separate app-level `AGENTS.md`.

## Repository map

- `packages/*` — 19 publishable `@bunest/*` packages (source in `src/`, tests in `test/`). Public API = `package.json#exports`.
- `tests/` — cross-package specs (`nestjs-conformance/`, security fuzz, concurrency/leak, API parity).
- `examples/`, `apps/playground` — runnable reference apps. `apps/vscode-bunest` — VS Code extension.
- `docs/` — guides and ADRs (`docs/adr/`). ADRs are binding contracts; read the relevant one before changing architecture.
- `scripts/` — release gates (`verify-release.ts`), type audits, AI docs generator (`ai-docs.ts`).

## Hard rules (enforced by `bun run verify:release`)

1. **Zero external runtime deps** in every package (`ADR-017`). Use Bun APIs (`Bun.serve`, `Bun.SQL`, `Bun.RedisClient`, `Bun.password`, `Bun.CryptoHasher`, …).
2. **No `node:*` imports** anywhere except the two quarantined adapters in `packages/core/src/common/runtime/`. No `setImmediate`.
3. **No circular runtime imports**, and the cross-package dependency graph must stay a DAG.
4. **Legacy decorators** (`experimentalDecorators` + `emitDecoratorMetadata`), `verbatimModuleSyntax: true`:
   value-import DI classes/DTOs/entities, `import type` only for interfaces/type aliases.
5. **No RxJS**: interceptors return `Promise<T>`.

## Conventions

- **NestJS conformance (`tests/nestjs-conformance/`)**: never add `.skip`, never weaken or delete an upstream
  assertion. To un-skip a `// BUNEST_BUG:` test, fix `packages/*/src`, remove the `.skip` and the comment, then run
  `bun run conformance:gate --update`. If a test truly conflicts with an ADR, stop and ask (do not adapt silently).

- Bootstrap/routing errors must carry a stable `BUNEST_E*` code. Add new codes to
  `packages/core/src/errors/error-catalog.ts` (with ordered `fixes`), then run `bun run ai:docs`.
- Generated files — never edit by hand: `docs/errors.md`, `llms.txt`, `llms-full.txt` (`bun run ai:docs`).
- New public exports go through the package `src/index.ts` (or subpath index) and need a test.
- Keep error messages actionable: say what failed, where (module/class/param), and how to fix.

## Verification loop (run before declaring a task done)

```bash
bun run typecheck                                  # bun check, must be 0 errors
bun test <path-or-filter>                          # targeted tests first, then the full suite
bun run ai:docs --check                            # generated AI docs are fresh
bun run conformance:gate                           # conformance skips never increase, 0 fail
bun run build && bun run verify:release            # before release-affecting changes
```

App-style one-shot check (compact output for agents):

```bash
bun packages/cli/src/cli.ts verify <test-filter> --reporter=agent
```

## Where to look

| Task | Start here |
| --- | --- |
| DI / module graph | `packages/core/src/di/di-container.ts`, `packages/core/src/module/module-scanner.ts` |
| HTTP pipeline / routing | `packages/core/src/http/` |
| Validation | `packages/validation/src/` |
| ORM / repositories | `packages/orm/src/declarative-repository.ts`, `packages/orm/src/driver/` |
| CLI commands | `packages/cli/src/runner.ts`, `packages/cli/src/commands/` |
| Static diagnostics (`BUNEST*`) | `packages/cli/src/analyzer/diagnostics.ts` |
