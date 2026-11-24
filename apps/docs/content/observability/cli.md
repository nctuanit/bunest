# CLI

**`@bunest/cli`** is Bunest's zero-dependency command-line interface for scaffolding projects, generating NestJS-style schematics, running watch-mode dev servers, bundling production builds with `Bun.build()`, launching the interactive DI REPL, and inspecting your environment.

## Installation

```bash
bun add -d @bunest/cli
# or run directly with bunx:
bunx @bunest/cli --help
```

## Commands

| Command                                    | Description                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `bunest new <name>`                        | Scaffold a new Bunest TypeScript project with `tsconfig.json`, `@bunest/validation`, and `bun:test` setup                          |
| `bunest generate <schematic> <name>` (`g`) | Generate controllers, services, modules, DTOs, guards, pipes, interceptors, filters, middleware, endpoints, or full CRUD resources |
| `bunest dev`                               | Run your application in Bun watch mode (`--port`, `--entry`) with live `.d.ts` typegen                                             |
| `bunest build`                             | Bundle your application for production via `Bun.build()` (`--minify`, `--outfile`)                                                 |
| `bunest typegen`                           | Scan routes, DI tokens, class macros, custom macros/presets, and ecosystem registries into `.bunest/types/bunest.d.ts`             |
| `bunest check`                             | Run static DI, ORM derived-query, Class Macro, and custom architecture diagnostics (`BUNEST_ARCH*`)                                |
| `bunest delombok`                          | Expand built-in & custom Class Macros/presets into explicit TypeScript methods                                                     |
| `bunest repl`                              | Start an interactive DI REPL against your compiled `AppModule`                                                                     |
| `bunest info`                              | Print Bunest, Bun runtime, and OS environment diagnostics                                                                          |

## Quick Reference

```bash
# Scaffold a new API
bunx @bunest/cli new my-api

# Generate a full CRUD resource (module + controller + service + DTOs + spec)
bunx @bunest/cli g resource users

# Generate a controller without spec file
bunx @bunest/cli g co orders --no-spec

# Generate typed ambient registries (.bunest/types/bunest.d.ts)
bunx @bunest/cli typegen

# Run static project & custom architecture diagnostics
bunx @bunest/cli check

# Run dev server
bunx @bunest/cli dev --port 3000

# Production bundle with Bun.build()
bunx @bunest/cli build --minify
```

## Project Configuration (`bunest.config.ts`)

Introduced in **[ADR-018](/architecture/adrs)**, `defineBunestConfig()` (exported from `@bunest/core`) configures Class Macro defaults/presets/plugins, custom ORM query operators, AOP pointcuts, typegen plugins, architecture diagnostic rules, and unified `Bun.plugin` stages from a single typed `bunest.config.ts` file (loaded automatically by `@bunest/cli` via native Bun `import()`):

@@filename(bunest.config.ts)

```ts
import { defineBunestConfig } from "@bunest/core";
import {
  noRepositoryInControllerRule,
  requireGuardOnMutationsRule,
} from "@bunest/cli";
import { Auditable } from "./src/macros/auditable.macro";

export default defineBunestConfig({
  macros: {
    defaults: {
      accessors: { fluent: false, chain: true },
      toString: { maskValue: "[REDACTED]" },
      builder: { toBuilder: true },
    },
    presets: {
      DomainEntity: ["Data", "Builder", "FieldNameConstants"],
    },
    plugins: [Auditable.macroDefinition],
  },
  orm: {
    defaultScopes: ["softDelete", "tenant"],
    queryOperators: [
      {
        suffix: "Matches",
        arity: 1,
        description: "Full-text match predicate",
      },
    ],
  },
  typegen: {
    enabled: true,
    outDir: ".bunest/types",
    fileName: "bunest.d.ts",
    include: ["routes", "macros", "i18n", "jobs", "workflows", "authz", "ai"],
  },
  diagnostics: {
    rules: [noRepositoryInControllerRule, requireGuardOnMutationsRule],
  },
  plugin: {
    classMacros: true,
    autoModuleManifest: true,
    swaggerMetadata: true,
    ormCircularSafe: true,
  },
});
```

## Unified `Bun.plugin` Pipeline (`createBunestPlugin`)

`createBunestPlugin(options?)` and `registerBunestPlugin(options?)` replace separate conflicting `onLoad` plugins with **one composable 5-stage transform pipeline** usable in both `Bun.plugin(...)` runtime preloads and `Bun.build({ plugins: [createBunestPlugin()] })`:

| Stage | Option (default) | Responsibility |
| --- | --- | --- |
| **1. `classMacros`** | `classMacros: true` | AST-scans classes using built-in or custom macros/presets and appends `registerMacroFields(ClassName, [...])` so zero-initializer fields (`email!: string;`) work with zero manual `fields: [...]` |
| **2. `autoModuleManifest`** | `autoModuleManifest: true` | In build mode (`expandAutoModuleGlobs`), expands `@AutoModule({ scan })` via `Bun.Glob` into static `manifest: [() => import("./...")]` arrays for `bun build --compile` |
| **3. `swaggerMetadata`** | `swaggerMetadata: true` | Emits OpenAPI/DTO & controller reflection metadata (reusing `bunestMetadataPlugin` transforms) |
| **4. `userTransforms`** | `transforms: [...]` | Runs custom `{ name, filter?, transform(source, filePath) }` hooks from options or `bunest.config.ts` |
| **5. `ormCircularSafe`** | `ormCircularSafe: true` | Transpiles TypeScript via `Bun.Transpiler` (`experimentalDecorators`, `emitDecoratorMetadata`, `verbatimModuleSyntax`) with TDZ-safe circular-entity metadata rewriting |

@@filename(preload.ts)

```ts
import { registerBunestPlugin } from "@bunest/cli";

// Register in bunfig.toml (`preload = ["./preload.ts"]`) for runtime & tests:
registerBunestPlugin();
```

For programmatic testing or custom build scripts, `@bunest/cli` also exports `transformBunestSource(source, filePath, options?)`, `transformBunestSourceAsync(...)`, and the legacy standalone `bunestMetadataPlugin()`.

## Custom Class Macros, Presets & Global Defaults

Define reusable, single-source Class Macros in `@bunest/core` with **`defineClassMacro()`** and **`defineMacroPreset()`**. Every registered macro is stored on `globalThis[Symbol.for("bunest:custom_macros:registry")]` and drives runtime execution, `.d.ts` typegen, VS Code Hover/CodeLens, and `bunest delombok` from one definition:

@@filename(auditable.macro.ts)

```ts
import {
  Builder,
  Data,
  FieldNameConstants,
  defineClassMacro,
  defineMacroPreset,
  setGlobalMacroDefaults,
} from "@bunest/core";

// Project-wide defaults inherited by all built-in macros (per-class options always win)
setGlobalMacroDefaults({
  toString: { maskValue: "[REDACTED]" },
  builder: { toBuilder: true },
});

// Single-source custom macro (fields default-initialized without breaking `new`)
export const Auditable = defineClassMacro({
  name: "Auditable",
  fields: [
    { name: "createdAt", type: "Date", readonly: true, defaultValue: () => new Date() },
    { name: "updatedAt", type: "Date", defaultValue: () => new Date() },
  ],
  methods: {
    touch: {
      signature: "(): this",
      impl(self) {
        self.updatedAt = new Date();
        return this;
      },
      delombokBody: "this.updatedAt = new Date();\nreturn this;",
    },
  },
  statics: {
    auditFields: {
      signature: "(): readonly string[]",
      impl: () => ["createdAt", "updatedAt"],
    },
  },
});

// Reusable preset composing built-in macros (auto-infers composedNames for static arrays)
export const DomainEntity = defineMacroPreset(
  "DomainEntity",
  [Data(), Builder({ toBuilder: true }), FieldNameConstants()],
  ["Data", "Builder", "FieldNameConstants"],
);
```

## Extensible Typegen Plugins (`defineTypegenPlugin`)

Extend `bunest typegen` with **`defineTypegenPlugin()`** (`{ name, target?, scan(ctx), emit(data, ctx) }`). In addition to core targets (`routes`, `tokens`, `events`, `config`, `cqrs`, `microservices`, `mongoose`, `macros`), `@bunest/cli` ships **5 built-in ecosystem plugins**:

| Plugin Export | Target | Scans | Emitted Ambient Registry |
| --- | --- | --- | --- |
| `i18nTypegenPlugin` | `i18n` | `locales/**/*` & `i18n/**/*` (`.json`, `.jsonc`, `.yaml`, `.yml`, `.toml`) via `Bun.Glob` + `Bun.JSONC`/`Bun.YAML`/`Bun.TOML` | `@bunest/core/i18n` → `BunestI18nRegistry` (dot-keys + `{{param}}` placeholders) |
| `jobsTypegenPlugin` | `jobs` | `@Processor`, `@Queue`, `@Process` decorators | `@bunest/jobs` → `BunestQueueRegistry` |
| `workflowsTypegenPlugin` | `workflows` | `@Workflow`, `defineWorkflow({ name })` | `@bunest/workflows` → `BunestWorkflowRegistry` |
| `authzTypegenPlugin` | `authz` | `@RequirePermissions`, `@Permissions`, `@CheckPolicies` | `@bunest/security/authz` → `BunestPermissionRegistry` |
| `aiToolsTypegenPlugin` | `ai` (`ai-tools`) | `@AiTool`, `@McpTool`, `defineTool({ name })` | `@bunest/ai` → `BunestAiToolRegistry` |

@@filename(feature-flags.typegen.ts)

```ts
import { defineTypegenPlugin } from "@bunest/cli";

export const featureFlagsPlugin = defineTypegenPlugin({
  name: "feature-flags",
  target: "flags",
  async scan(ctx) {
    const file = Bun.file(`${ctx.cwd}/flags.json`);
    return (await file.exists()) ? ((await file.json()) as Record<string, boolean>) : {};
  },
  emit(flags) {
    const keys = Object.keys(flags);
    if (keys.length === 0) return "";
    return [
      'declare module "./flags" {',
      "  interface FeatureFlagRegistry {",
      ...keys.map((k) => `    ${JSON.stringify(k)}: boolean;`),
      "  }",
      "}",
    ];
  },
});
```

## Custom Architecture Diagnostic Rules (`defineDiagnosticRule`)

Enforce team-specific architecture boundaries inside `bunest check` and VS Code using **`defineDiagnosticRule()`** (with optional quick-fix text edits):

- **`noRepositoryInControllerRule` (`BUNEST_ARCH001`):** Flags `@Controller()` classes injecting `*Repository` dependencies directly instead of delegating through a Service layer.
- **`requireGuardOnMutationsRule` (`BUNEST_ARCH002`):** Flags `@Post`, `@Put`, `@Patch`, and `@Delete` handlers missing `@UseGuards(...)` or `@Public()`.

Enable built-in preset rules via `diagnostics.rules` or `diagnostics.presetRules: ["BUNEST_ARCH001", "BUNEST_ARCH002"]` in `bunest.config.ts`, or register custom rules:

@@filename(no-raw-fetch.rule.ts)

```ts
import { defineDiagnosticRule } from "@bunest/cli";

export const requireServiceSuffixRule = defineDiagnosticRule({
  code: "TEAM001",
  severity: "warning",
  description: "All @Injectable() domain services should end with Service.",
  check(ctx) {
    const hits = [];
    for (const sf of ctx.sourceFiles) {
      for (const cls of sf.getClasses()) {
        const name = cls.getName();
        const isInjectable = cls.getDecorators().some((d) => d.getName() === "Injectable");
        if (isInjectable && name && !/(Service|Repository|Guard|Pipe|Handler)$/.test(name)) {
          hits.push({
            message: `Injectable class "${name}" should use an explicit role suffix.`,
            location: {
              filePath: sf.getFilePath(),
              line: 1,
              column: 1,
              endLine: 1,
              endColumn: 1,
              start: cls.getStart(),
              end: cls.getEnd(),
            },
          });
        }
      }
    }
    return hits;
  },
});
```
