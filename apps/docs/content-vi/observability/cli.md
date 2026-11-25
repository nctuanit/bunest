# CLI

**`@bunest/cli`** là giao diện dòng lệnh không phụ thuộc bên ngoài (zero-dependency) của Bunest dùng để khởi tạo dự án, sinh mã theo kiểu NestJS (schematics), chạy dev server chế độ watch, đóng gói bản production bằng `Bun.build()`, khởi chạy DI REPL tương tác và kiểm tra môi trường.

## Cài đặt

```bash
bun add -d @bunest/cli
# hoặc chạy trực tiếp bằng bunx:
bunx @bunest/cli --help
```

## Các lệnh

| Lệnh | Mô tả |
| --- | --- |
| `bunest new <name>` | Khởi tạo dự án Bunest TypeScript mới kèm cấu hình `tsconfig.json`, `@bunest/validation` và `bun:test` |
| `bunest generate <schematic> <name>` (`g`) | Sinh controller, service, module, DTO, guard, pipe, interceptor, filter, middleware, endpoint hoặc toàn bộ CRUD resource |
| `bunest dev` | Chạy ứng dụng ở chế độ watch của Bun (`--port`, `--entry`) kèm sinh kiểu `.d.ts` trực tiếp |
| `bunest build` | Đóng gói ứng dụng cho môi trường production qua `Bun.build()` (`--minify`, `--outfile`) |
| `bunest typegen` | Quét route, DI token, class macro, macro/preset tùy chỉnh và các registry hệ sinh thái vào `.bunest/types/bunest.d.ts` |
| `bunest check` | Chạy phân tích tĩnh cho DI, derived-query của ORM, Class Macro và các quy tắc kiến trúc tùy chỉnh (`BUNEST_ARCH*`) |
| `bunest delombok` | Khai triển các Class Macro/preset tích hợp sẵn và tùy chỉnh thành các phương thức TypeScript tường minh |
| `bunest repl` | Khởi chạy DI REPL tương tác trên `AppModule` đã biên dịch của bạn |
| `bunest info` | In thông tin chẩn đoán về Bunest, Bun runtime và hệ điều hành |

## Tham khảo nhanh

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

## Cấu hình dự án (`bunest.config.ts`)

Được giới thiệu trong **[ADR-018](/architecture/adrs)**, `defineBunestConfig()` (export từ `@bunest/core`) cấu hình mặc định/preset/plugin cho Class Macro, toán tử truy vấn ORM tùy chỉnh, AOP pointcut, plugin typegen, quy tắc kiểm tra kiến trúc và các giai đoạn `Bun.plugin` hợp nhất từ một tệp `bunest.config.ts` có định kiểu đầy đủ (được `@bunest/cli` tự động nạp qua `import()` gốc của Bun):

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

## Pipeline `Bun.plugin` hợp nhất (`createBunestPlugin`)

`createBunestPlugin(options?)` và `registerBunestPlugin(options?)` thay thế các plugin `onLoad` riêng lẻ dễ xung đột bằng **một pipeline chuyển đổi 5 giai đoạn có thể kết hợp**, dùng được cả trong preload runtime `Bun.plugin(...)` lẫn `Bun.build({ plugins: [createBunestPlugin()] })`:

| Giai đoạn | Tùy chọn (mặc định) | Nhiệm vụ |
| --- | --- | --- |
| **1. `classMacros`** | `classMacros: true` | Quét AST các class dùng macro/preset tích hợp sẵn hoặc tùy chỉnh và chèn thêm `registerMacroFields(ClassName, [...])` để các trường chưa khởi tạo (`email!: string;`) hoạt động mà không cần khai báo thủ công `fields: [...]` |
| **2. `autoModuleManifest`** | `autoModuleManifest: true` | Ở chế độ build (`expandAutoModuleGlobs`), mở rộng `@AutoModule({ scan })` qua `Bun.Glob` thành mảng tĩnh `manifest: [() => import("./...")]` cho `bun build --compile` |
| **3. `swaggerMetadata`** | `swaggerMetadata: true` | Sinh metadata phản chiếu OpenAPI/DTO & controller (tái sử dụng các phép biến đổi của `bunestMetadataPlugin`) |
| **4. `userTransforms`** | `transforms: [...]` | Chạy các hook tùy chỉnh `{ name, filter?, transform(source, filePath) }` từ options hoặc `bunest.config.ts` |
| **5. `ormCircularSafe`** | `ormCircularSafe: true` | Biên dịch TypeScript qua `Bun.Transpiler` (`experimentalDecorators`, `emitDecoratorMetadata`, `verbatimModuleSyntax`) kèm viết lại metadata entity vòng lặp an toàn với TDZ |

@@filename(preload.ts)

```ts
import { registerBunestPlugin } from "@bunest/cli";

// Register in bunfig.toml (`preload = ["./preload.ts"]`) for runtime & tests:
registerBunestPlugin();
```

Để kiểm thử theo chương trình hoặc viết script build tùy chỉnh, `@bunest/cli` cũng export `transformBunestSource(source, filePath, options?)`, `transformBunestSourceAsync(...)`, và hàm độc lập cũ `bunestMetadataPlugin()`.

## Class Macro tùy chỉnh, Preset & Mặc định toàn cục

Định nghĩa các Class Macro dùng lại từ một nguồn duy nhất trong `@bunest/core` với **`defineClassMacro()`** và **`defineMacroPreset()`**. Mọi macro đã đăng ký được lưu trên `globalThis[Symbol.for("bunest:custom_macros:registry")]` và điều khiển cả thực thi runtime, sinh kiểu `.d.ts`, VS Code Hover/CodeLens và `bunest delombok` từ một định nghĩa duy nhất:

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

## Plugin Typegen mở rộng (`defineTypegenPlugin`)

Mở rộng `bunest typegen` bằng **`defineTypegenPlugin()`** (`{ name, target?, scan(ctx), emit(data, ctx) }`). Ngoài các target lõi (`routes`, `tokens`, `events`, `config`, `cqrs`, `microservices`, `mongoose`, `macros`), `@bunest/cli` đi kèm **5 plugin hệ sinh thái tích hợp sẵn**:

| Tên export Plugin | Target | Nguồn quét | Ambient Registry được sinh |
| --- | --- | --- | --- |
| `i18nTypegenPlugin` | `i18n` | `locales/**/*` & `i18n/**/*` (`.json`, `.jsonc`, `.yaml`, `.yml`, `.toml`) qua `Bun.Glob` + `Bun.JSONC`/`Bun.YAML`/`Bun.TOML` | `@bunest/core/i18n` → `BunestI18nRegistry` (khóa phân cấp dấu chấm + placeholder `{{param}}`) |
| `jobsTypegenPlugin` | `jobs` | Các decorator `@Processor`, `@Queue`, `@Process` | `@bunest/jobs` → `BunestQueueRegistry` |
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

## Quy tắc chẩn đoán kiến trúc tùy chỉnh (`defineDiagnosticRule`)

Thực thi các ranh giới kiến trúc riêng của đội ngũ ngay trong `bunest check` và VS Code bằng **`defineDiagnosticRule()`** (hỗ trợ tùy chọn quick-fix chỉnh sửa văn bản):

- **`noRepositoryInControllerRule` (`BUNEST_ARCH001`):** Cảnh báo các class `@Controller()` inject trực tiếp dependency `*Repository` thay vì ủy quyền qua tầng Service.
- **`requireGuardOnMutationsRule` (`BUNEST_ARCH002`):** Cảnh báo các handler `@Post`, `@Put`, `@Patch` và `@Delete` thiếu `@UseGuards(...)` hoặc `@Public()`.

Bật các quy tắc preset tích hợp sẵn qua `diagnostics.rules` hoặc `diagnostics.presetRules: ["BUNEST_ARCH001", "BUNEST_ARCH002"]` trong `bunest.config.ts`, hoặc tự đăng ký quy tắc tùy chỉnh:

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
