import { afterEach, describe, expect, it } from "bun:test";
import {
  defineBunestConfig,
  dirname,
  ensureDir,
  join,
  removePath,
  resolve,
} from "@bunest/core";
import {
  CUSTOM_MACROS_REGISTRY_SYMBOL,
  CUSTOM_ORM_OPERATORS_SYMBOL,
  GLOBAL_MACRO_DEFAULTS_SYMBOL,
  applyBunestConfigRuntime,
  createBunestPlugin,
  findBunestConfigPath,
  loadBunestConfig,
  transformBunestSource,
  transformBunestSourceAsync,
  transformCircularMetadataJs,
} from "../src";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(TMP_DIR, `${prefix}${crypto.randomUUID().slice(0, 8)}`);
  await ensureDir(dir);
  tempDirs.push(dir);
  return dir;
}

async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await ensureDir(dirname(abs));
    await Bun.write(abs, content);
  }
}

function resetGlobalRegistries(): void {
  const g = globalThis as unknown as Record<symbol, unknown>;
  delete g[GLOBAL_MACRO_DEFAULTS_SYMBOL];
  const macroMap = g[CUSTOM_MACROS_REGISTRY_SYMBOL];
  if (macroMap instanceof Map) macroMap.clear();
  const opMap = g[CUSTOM_ORM_OPERATORS_SYMBOL];
  if (opMap instanceof Map) opMap.clear();
}

afterEach(async () => {
  resetGlobalRegistries();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("Unified createBunestPlugin() 5-stage transform pipeline", () => {
  it("Stage 1 (classMacros): auto-imports registerMacroFields and appends instance fields for zero-initializer classes, custom macros, and presets", () => {
    const source = `import { Data, Value } from "@bunest/core";

@Data()
export class UserModel {
  id!: number;
  email!: string;
  nickname?: string;
  static version = 1;
  #secret = "hidden";

  constructor(public readonly tenantId: string, plainArg: number) {
    void plainArg;
  }
}

@DomainEntity()
export class OrderModel {
  orderId!: string;
  total!: number;
}
`;

    const res = transformBunestSource(source, "/app/src/models.ts", {
      ormCircularSafe: false,
      swaggerMetadata: false,
      presets: {
        DomainEntity: ["Data", "Builder", "FieldNameConstants"],
      },
    });

    expect(res.modified).toBe(true);
    expect(res.loader).toBe("ts");
    expect(res.stagesApplied).toEqual(["classMacros"]);
    expect(res.registeredMacroClasses).toEqual([
      {
        className: "UserModel",
        fields: ["id", "email", "nickname", "tenantId"],
      },
      {
        className: "OrderModel",
        fields: ["orderId", "total"],
      },
    ]);
    expect(res.code).toContain(
      'import { registerMacroFields } from "@bunest/core";',
    );
    expect(res.code).toContain(
      'registerMacroFields(UserModel, ["id","email","nickname","tenantId"]);',
    );
    expect(res.code).toContain(
      'registerMacroFields(OrderModel, ["orderId","total"]);',
    );
  });

  it("Stage 1 (classMacros): avoids duplicate registerMacroFields import when already imported", () => {
    const source = `import { Data, registerMacroFields } from "@bunest/core";

@Data()
export class Account {
  email!: string;
}
`;
    const res = transformBunestSource(source, "/app/src/account.ts", {
      ormCircularSafe: false,
      swaggerMetadata: false,
    });

    const importMatches = res.code.match(/import\s*\{[^}]*registerMacroFields/g);
    expect(importMatches).toHaveLength(1);
    expect(res.code).toContain('registerMacroFields(Account, ["email"]);');
  });

  it("Stage 2 (autoModuleManifest): expands @AutoModule({ scan }) into static manifest imports via Bun.Glob in build mode", async () => {
    const dir = await makeTempDir("bunest-automod-");
    await writeFiles(dir, {
      "src/app.module.ts": `import { AutoModule } from "@bunest/core";

@AutoModule({ scan: "**/*.service.ts" })
export class AppModule {}
`,
      "src/users/users.service.ts": `export class UsersService {}`,
      "src/orders/orders.service.ts": `export class OrdersService {}`,
      "src/orders/orders.service.spec.ts": `export class IgnoredSpec {}`,
    });

    const modulePath = join(dir, "src/app.module.ts");
    const moduleSource = await Bun.file(modulePath).text();

    // Runtime mode (expandAutoModuleGlobs omitted / false): does not expand
    const runtimeRes = transformBunestSource(moduleSource, modulePath, {
      ormCircularSafe: false,
      swaggerMetadata: false,
    });
    expect(runtimeRes.stagesApplied).not.toContain("autoModuleManifest");
    expect(runtimeRes.code).not.toContain("manifest:");

    // Build mode (expandAutoModuleGlobs: true): injects static manifest array
    const buildRes = transformBunestSource(moduleSource, modulePath, {
      expandAutoModuleGlobs: true,
      ormCircularSafe: false,
      swaggerMetadata: false,
    });
    expect(buildRes.stagesApplied).toContain("autoModuleManifest");
    expect(buildRes.autoModuleManifests).toHaveLength(1);
    expect(buildRes.autoModuleManifests[0]!.className).toBe("AppModule");
    expect(buildRes.autoModuleManifests[0]!.files).toEqual([
      "./orders/orders.service",
      "./users/users.service",
    ]);
    expect(buildRes.code).toContain(
      'manifest: [() => import("./orders/orders.service"), () => import("./users/users.service")]',
    );
    expect(buildRes.code).not.toContain("orders.service.spec");
  });

  it("Stage 3 (swaggerMetadata) + Stage 4 (userTransforms) + Stage 5 (ormCircularSafe): composes cleanly in one pass", async () => {
    const dtoSource = `function Dec(): PropertyDecorator { return () => {}; }
function ClassDec(): ClassDecorator { return () => {}; }

@ClassDec()
export class CreateInvoiceDto {
  /** Total cents */
  @Dec()
  amount!: number;

  @Dec()
  customer!: CustomerRef;
}

class CustomerRef {
  id!: string;
}
`;

    const res = await transformBunestSourceAsync(
      dtoSource,
      "/app/src/create-invoice.dto.ts",
      {
        classMacros: false,
        swaggerMetadata: { swagger: true, introspectComments: true },
        transforms: [
          {
            name: "inject-banner",
            filter: /\.dto\.ts$/,
            transform: async (code) => `// custom-transform-applied\n${code}`,
          },
        ],
        ormCircularSafe: true,
      },
    );

    expect(res.loader).toBe("js");
    expect(res.modified).toBe(true);
    expect(res.stagesApplied).toEqual([
      "swaggerMetadata",
      "userTransforms",
      "ormCircularSafe",
    ]);
    // Stage 3 Swagger metadata was emitted before Stage 5 transpiled it
    expect(res.code).toContain("bunest:swagger:api_properties");
    expect(res.code).toContain("Total cents");
    // Stage 5 wrapped forward reference CustomerRef with TDZ-safe try/catch IIFE
    expect(res.code).toContain(
      '(() => { try { return typeof CustomerRef === "undefined" ? Object : CustomerRef; } catch { return Object; } })()',
    );
  });

  it("Stage 5 standalone transformCircularMetadataJs skips non-metadata JS and rewrites TDZ patterns", () => {
    const plainJs = `const x = typeof Foo === "undefined" ? Object : Foo;`;
    expect(transformCircularMetadataJs(plainJs)).toBe(plainJs);

    const metadataJs = `__legacyMetadataTS("design:type", typeof Post === "undefined" ? Object : Post)`;
    const transformedOnce = transformCircularMetadataJs(metadataJs);
    expect(transformedOnce).toContain(
      '(() => { try { return typeof Post === "undefined" ? Object : Post; } catch { return Object; } })()',
    );
    // Idempotent: a second pass must not double-wrap the TDZ IIFE
    expect(transformCircularMetadataJs(transformedOnce)).toBe(transformedOnce);
  });

  it("integrates with real Bun.build({ plugins: [createBunestPlugin()] }) with zero onLoad conflicts (circular ref + Swagger DTO + @AutoModule manifest + classMacros)", async () => {
    const dir = await makeTempDir("bunest-unified-build-");
    const coreIndex = resolve("packages/core/src/index.ts");

    await writeFiles(dir, {
      "src/core-shim.ts": `export const registered: Array<{ name: string; fields: readonly string[] }> = [];
export function registerMacroFields(target: Function, fields: readonly string[]): void {
  registered.push({ name: target.name, fields });
}
export function Data(): ClassDecorator {
  return () => {};
}
export function AutoModule(meta: Record<string, unknown>): ClassDecorator {
  return (target) => {
    (target as unknown as Record<string, unknown>).__autoMeta = meta;
  };
}
`,
      "src/profile.dto.ts": `import { Data } from "./core-shim";

function FieldDec(): PropertyDecorator { return () => {}; }

@Data()
export class ProfileDto {
  /** User display name */
  @FieldDec()
  displayName!: string;

  @FieldDec()
  avatar!: ForwardAvatar;
}

export class ForwardAvatar {
  url!: string;
}
`,
      "src/workers/mail.worker.ts": `export const workerTag = "mail-worker";`,
      "src/app.module.ts": `import { AutoModule } from "./core-shim";

@AutoModule({ scan: "workers/*.worker.ts" })
export class AppModule {}
`,
      "src/entry.ts": `import { registered } from "./core-shim";
import { ProfileDto } from "./profile.dto";
import { AppModule } from "./app.module";

export { registered, ProfileDto, AppModule };
`,
    });

    const outDir = join(dir, "dist");
    const buildResult = await Bun.build({
      entrypoints: [join(dir, "src/entry.ts")],
      outdir: outDir,
      target: "bun",
      format: "esm",
      plugins: [
        createBunestPlugin({
          coreImportPath: join(dir, "src/core-shim.ts"),
          swaggerMetadata: { swagger: true, introspectComments: true },
          transforms: [
            {
              name: "mark-entry",
              filter: /entry\.ts$/,
              transform: (code) => `${code}\nexport const customTransformRan = true;\n`,
            },
          ],
        }),
      ],
    });

    expect(buildResult.success).toBe(true);
    expect(coreIndex.length).toBeGreaterThan(0);

    const builtMod = (await import(
      `${Bun.pathToFileURL(join(outDir, "entry.js")).href}?t=${Date.now()}`
    )) as {
      registered: Array<{ name: string; fields: readonly string[] }>;
      ProfileDto: Function;
      AppModule: { __autoMeta?: { manifest?: Array<() => Promise<{ workerTag: string }>> } };
      customTransformRan: boolean;
    };

    // Stage 1 ran & registered zero-initializer fields
    expect(builtMod.registered).toEqual([
      { name: "ProfileDto", fields: ["displayName", "avatar"] },
    ]);
    // Stage 2 auto-detected Bun.build mode and injected static manifest
    expect(builtMod.AppModule.__autoMeta?.manifest).toHaveLength(1);
    const loadedWorker = await builtMod.AppModule.__autoMeta!.manifest![0]!();
    expect(loadedWorker.workerTag).toBe("mail-worker");
    // Stage 3 emitted Swagger metadata on ProfileDto
    const swaggerProps = Reflect.getOwnMetadata(
      Symbol.for("bunest:swagger:api_properties"),
      builtMod.ProfileDto,
    ) as Array<{ propertyKey?: string; description?: string }>;
    const displayNameMeta = swaggerProps?.find(
      (p) => p.propertyKey === "displayName",
    );
    expect(displayNameMeta?.description).toBe("User display name");
    // Stage 4 custom transform ran
    expect(builtMod.customTransformRan).toBe(true);
    // Stage 5 prevented ForwardAvatar TDZ crash at module evaluation time!
    expect(typeof builtMod.ProfileDto).toBe("function");
  });
});

describe("bunest.config.ts Loader (loadBunestConfig)", () => {
  it("returns empty config and null configPath when no bunest.config.* exists", async () => {
    const dir = await makeTempDir("bunest-noconfig-");
    expect(findBunestConfigPath(dir)).toBeNull();
    const loaded = await loadBunestConfig(dir);
    expect(loaded).toEqual({ config: {}, configPath: null });
  });

  it("loads bunest.config.ts via native Bun import() and applies macro defaults, custom macros, and ORM operators", async () => {
    const dir = await makeTempDir("bunest-config-ts-");
    await writeFiles(dir, {
      "bunest.config.ts": `export default {
  macros: {
    defaults: {
      builder: { toBuilder: true, setterPrefix: "with" },
      fieldNameConstants: { uppercase: true, innerName: "KEYS" },
    },
    presets: {
      DomainEntity: ["Data", "Builder", "FieldNameConstants"],
    },
    plugins: [
      {
        name: "Timestamped",
        fields: [{ name: "createdAt", type: "Date", readonly: true }],
        methods: {
          touch: {
            signature: "(): this",
            impl(self: any) { return self; },
          },
        },
      },
    ],
  },
  orm: {
    queryOperators: [
      {
        suffix: "Matches",
        arity: 1,
        description: "Regex pattern match",
        toSql(ctx: any) {
          const p = ctx.nextPlaceholder();
          return { sql: \`\${ctx.quotedColumn} REGEXP \${p}\`, params: ctx.args };
        },
      },
    ],
  },
  typegen: {
    outDir: ".bunest/custom-types",
    fileName: "generated.d.ts",
  },
};
`,
    });

    const loaded = await loadBunestConfig(dir);
    expect(loaded.configPath).toBe(join(dir, "bunest.config.ts"));
    expect(loaded.config.typegen?.outDir).toBe(".bunest/custom-types");
    expect(loaded.config.macros?.presets?.DomainEntity).toEqual([
      "Data",
      "Builder",
      "FieldNameConstants",
    ]);

    // Verify runtime registries were populated automatically
    const g = globalThis as unknown as Record<symbol, unknown>;
    const defaults = g[GLOBAL_MACRO_DEFAULTS_SYMBOL] as {
      builder?: { toBuilder?: boolean; setterPrefix?: string };
    };
    expect(defaults?.builder?.toBuilder).toBe(true);
    expect(defaults?.builder?.setterPrefix).toBe("with");

    const customMacros = g[CUSTOM_MACROS_REGISTRY_SYMBOL] as Map<string, { name: string }>;
    expect(customMacros.has("Timestamped")).toBe(true);

    const customOps = g[CUSTOM_ORM_OPERATORS_SYMBOL] as Map<string, { suffix: string; arity: number }>;
    expect(customOps.get("Matches")?.arity).toBe(1);
  });

  it("supports bunest.config.mjs async factory export and applyBunestConfigRuntime()", async () => {
    const dir = await makeTempDir("bunest-config-mjs-");
    await writeFiles(dir, {
      "bunest.config.mjs": `export default async () => ({
  macros: {
    defaults: { accessors: { fluent: true } },
  },
});
`,
    });

    const loaded = await loadBunestConfig(dir, { applyRuntime: false });
    expect(loaded.configPath).toBe(join(dir, "bunest.config.mjs"));
    expect(loaded.config.macros?.defaults?.accessors?.fluent).toBe(true);

    // Since applyRuntime was false, global defaults were not mutated yet
    const g = globalThis as unknown as Record<symbol, unknown>;
    expect(g[GLOBAL_MACRO_DEFAULTS_SYMBOL]).toBeUndefined();

    applyBunestConfigRuntime(loaded.config);
    expect(
      (g[GLOBAL_MACRO_DEFAULTS_SYMBOL] as { accessors?: { fluent?: boolean } })
        ?.accessors?.fluent,
    ).toBe(true);
  });

  it("interoperates with defineBunestConfig for ORM query operators", () => {
    const cfg = defineBunestConfig({
      orm: {
        queryOperators: [
          {
            suffix: "Matches",
            arity: 1,
            description: "Regex match",
          },
        ],
      },
    });
    applyBunestConfigRuntime(cfg);
    const g = globalThis as unknown as Record<symbol, Map<string, unknown>>;
    expect(g[CUSTOM_ORM_OPERATORS_SYMBOL]?.has("Matches")).toBe(true);
  });

  it("injects entity argument from @Repository<TaskEntity, number>() and promotes import type in transformBunestSource + Bun.build", async () => {
    const transformed = transformBunestSource(
      `import type { TaskEntity, ExtraMeta } from "./task.entity";
import { Repository } from "@bunest/orm";

@Repository<TaskEntity, number>()
export abstract class TaskRepository {
  abstract findByTitle(title: string): Promise<TaskEntity | null>;
}

@Repository<TaskEntity, number>({ table: "custom_tasks" })
export abstract class CustomTaskRepository {}
`,
      "/app/src/task.repository.ts",
      { ormCircularSafe: false, swaggerMetadata: false, classMacros: false },
    );

    expect(transformed.modified).toBe(true);
    expect(transformed.code).toContain('import { TaskEntity } from "./task.entity";');
    expect(transformed.code).toContain('import type { ExtraMeta } from "./task.entity";');
    expect(transformed.code).toContain("@Repository<TaskEntity, number>(TaskEntity)");
    expect(transformed.code).toContain(
      '@Repository<TaskEntity, number>({ entity: TaskEntity, table: "custom_tasks" })',
    );

    // End-to-end Bun.build execution with createBunestPlugin()
    const dir = await makeTempDir("bunest-repo-generic-build-");
    await writeFiles(dir, {
      "src/task.entity.ts": `export class TaskEntity { id!: number; title!: string; }\n`,
      "src/repo-dec.ts": `export const seen: unknown[] = [];
export function Repository<TEntity = any, TKey = number>(entity?: unknown): ClassDecorator {
  seen.push(entity);
  return () => {};
}
`,
      "src/task.repository.ts": `import type { TaskEntity } from "./task.entity";
import { Repository } from "./repo-dec";

@Repository<TaskEntity, number>()
export abstract class TaskRepository {
  abstract findByTitle(title: string): Promise<TaskEntity | null>;
}
`,
      "src/main.ts": `import { seen } from "./repo-dec";
import { TaskEntity } from "./task.entity";
import "./task.repository";
console.log(seen.length === 1 && seen[0] === TaskEntity ? "OK" : "FAIL");
`,
    });

    const buildRes = await Bun.build({
      entrypoints: [join(dir, "src/main.ts")],
      outdir: join(dir, "dist"),
      target: "bun",
      format: "esm",
      plugins: [createBunestPlugin()],
    });
    expect(buildRes.success).toBe(true);

    const proc = Bun.spawn([process.execPath, join(dir, "dist/main.js")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout.trim()).toBe("OK");
  });
});
