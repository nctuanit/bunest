# Contributing to Bunest

Thank you for contributing to **Bunest**! This guide covers local setup, TypeScript/Bun decorator rules, PR quality gates, and the Architecture Decision Record (ADR) process.

## 1. Prerequisites & Local Setup

- **Bun:** `>= 1.4.3` (pinned in CI alongside `latest`)
- **OS:** Linux, macOS, or Windows (all three are tested in CI)

```bash
# Install all workspace dependencies
bun install

# Typecheck with Bun's native checker and TypeScript 7
bun run typecheck
bunx tsc --noEmit

# Run the complete unit, integration, and E2E test suite
bun test

# Run tests with coverage
bun run test:coverage

# Build every package in the monorepo
bun run build

# Run the release verification gate (metadata, dist artifacts, zero cycles, CLI smoke test)
bun run verify:release
```

## 2. Critical TypeScript & Legacy Decorator Rules

Bunest uses **Legacy TypeScript Decorators** (`experimentalDecorators: true` + `emitDecoratorMetadata: true`) with **`verbatimModuleSyntax: true`** (see `docs/adr/ADR-002.md` and `tsconfig.base.json`).

Follow these four rules in every package, example, and test:

1. **Import `"reflect-metadata"` first** at application entrypoints (before loading decorated classes).
2. **Value-import DI & DTO classes** referenced in decorated constructors or route handlers so Bun emits `design:paramtypes` at runtime:
   ```ts
   import { CreateUserDto } from "./create-user.dto";
   import { UsersService } from "./users.service";
   ```
3. **Always `import type` interfaces and type aliases.** Because Bun's transpiler operates file-by-file, value-importing an `interface` referenced in a decorated signature preserves a runtime import that fails at runtime/build time. `verbatimModuleSyntax: true` enforces this automatically via `bun check`.
4. **Decorate optional constructor parameters on `@Injectable()` classes** with `@Optional() @Inject(TOKEN)`:
   ```ts
   @Injectable()
   export class MyService {
     constructor(
       @Optional()
       @Inject(MY_SERVICE_OPTIONS)
       private readonly options: MyServiceOptions = {},
     ) {}
   }
   ```
   Without `@Optional()`, Bun emits `design:paramtypes: [Object]`, causing DI bootstrap to fail fast with `UnknownDependencyException`.

## 3. Architecture & Dependency Rules

- **Zero circular runtime dependencies** inside any `packages/*/src/` directory and across the monorepo package graph (`bun run verify:release` enforces both automatically).
- **Zero `Reflect.getMetadata()` calls on the HTTP hot path:** read metadata once at bootstrap and precompile route/parameter/enhancer execution plans.
- **Inheritance-safe metadata:** always use copy-on-write helpers in `MetadataRegistry` so subclass decorators never mutate parent class metadata.
- **Bun-native core:** do not add Express, Fastify, or Node HTTP server adapters to core packages.

## 4. Pull Request Rules

1. **Keep PRs focused:** one logical change per PR; avoid mixing large refactors with new features.
2. **Tests & docs required:** every public API addition or behavior change must include unit/integration tests and updated docs/examples + `CHANGELOG.md` entry.
3. **ADR for breaking or architectural changes:** propose changes affecting core contracts in `docs/adr/ADR-NNN.md` (Context, Decision, Consequences, Migration).
4. **All CI gates must pass:** `bun run typecheck`, `bunx tsc --noEmit`, `bun test`, `bun run build`, and `bun run verify:release`.
5. **No unexplained benchmark regressions:** when touching hot paths (`@bunest/http`, `@bunest/core`, `@bunest/validation`), run `bun run bench` and include before/after numbers in the PR description.

## 5. Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(core): add request-scoped factory multi-providers`
- `fix(security): validate HMAC CryptoKey hash algorithm`
- `docs(adr): clarify controller default path normalization`
- `test(http): add SSE disconnect abort regression test`
- `chore(release): normalize package publish metadata`
