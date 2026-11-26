import { afterEach, describe, expect, it } from "bun:test";
import {
  dirname,
  ensureDir,
  join,
  removePath,
} from "@bunest/core";
import {
  BUILTIN_ARCHITECTURE_RULES,
  BUILTIN_TYPEGEN_PLUGINS,
  BunestStaticAnalyzer,
  CUSTOM_MACROS_REGISTRY_SYMBOL,
  CUSTOM_ORM_OPERATORS_SYMBOL,
  GLOBAL_MACRO_DEFAULTS_SYMBOL,
  aiToolsTypegenPlugin,
  analyzeProjectDiagnostics,
  authzTypegenPlugin,
  buildDelombokEdit,
  defineDiagnosticRule,
  defineTypegenPlugin,
  generateBunestTypes,
  getRepositoryDerivedCompletions,
  i18nTypegenPlugin,
  jobsTypegenPlugin,
  noRepositoryInControllerRule,
  parseDerivedMethodName,
  requireGuardOnMutationsRule,
  resolveClassMacroMembers,
  runCheckCommand,
  runDelombokCommand,
  runTypegenCommand,
  workflowsTypegenPlugin,
  type CliIO,
} from "../src";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

async function createTempProject(
  files: Record<string, string>,
  prefix = "bunest-magic-",
): Promise<string> {
  const dir = join(TMP_DIR, `${prefix}${crypto.randomUUID().slice(0, 8)}`);
  await ensureDir(dir);
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await ensureDir(dirname(abs));
    await Bun.write(abs, content);
  }
  return dir;
}

function createCapturedIO(cwd: string): {
  io: CliIO;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      cwd,
      stdout: (m) => stdout.push(m),
      stderr: (m) => stderr.push(m),
    },
  };
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

describe("Extensible Typegen Plugin API & 5 Built-in Ecosystem Plugins", () => {
  it("runs all 5 built-in ecosystem plugins (i18n, jobs, workflows, authz, ai-tools) automatically and emits clean registries", async () => {
    expect(BUILTIN_TYPEGEN_PLUGINS).toHaveLength(5);
    expect(BUILTIN_TYPEGEN_PLUGINS.map((p) => p.name)).toEqual([
      i18nTypegenPlugin.name,
      jobsTypegenPlugin.name,
      workflowsTypegenPlugin.name,
      authzTypegenPlugin.name,
      aiToolsTypegenPlugin.name,
    ]);

    const cwd = await createTempProject({
      "locales/en.json": JSON.stringify({
        welcome: "Hello {name}",
        orders: {
          created: "Order {{orderId}} created by {actor}",
          count: {
            one: "{{count}} order",
            other: "{{count}} orders",
          },
        },
      }),
      "locales/en/billing.yaml": `invoice:\n  paid: "Invoice {{invoiceId}} paid"\n`,
      "i18n/fr.toml": `[auth]\nfailed = "Login failed for {email}"\n`,
      "i18n/de.jsonc": `{\n  // comment in jsonc\n  "common": { "ok": "OK" },\n}\n`,
      "src/stubs.ts": `export interface Job<T> { data: T; }
export function Processor(_q: unknown): ClassDecorator { return () => {}; }
export function Queue(_q: unknown): ClassDecorator { return () => {}; }
export function Process(_j?: unknown): MethodDecorator { return () => {}; }
export function Workflow(_w?: unknown): ClassDecorator { return () => {}; }
export function defineWorkflow<I = unknown, O = unknown>(_cfg: unknown) { return _cfg; }
export function RequirePermissions(..._p: unknown[]): MethodDecorator { return () => {}; }
export function Permissions(_p: unknown): MethodDecorator { return () => {}; }
export function CheckPolicies(..._p: unknown[]): MethodDecorator { return () => {}; }
export function AiTool(_cfg?: unknown): MethodDecorator { return () => {}; }
export function McpTool(_cfg?: unknown): MethodDecorator { return () => {}; }
export function defineTool<I = unknown, O = unknown>(_cfg: unknown) { return _cfg; }
`,
      "src/jobs/email.processor.ts": `import { Process, Processor, type Job } from "../stubs";

export interface WelcomeJobData {
  to: string;
}

@Processor("emails")
export class EmailProcessor {
  @Process("send-welcome")
  async sendWelcome(_job: Job<WelcomeJobData>): Promise<boolean> {
    return true;
  }
}
`,
      "src/workflows/order.workflow.ts": `import { Workflow, defineWorkflow } from "../stubs";

export interface OrderInput { orderId: string; }
export interface OrderOutput { shipped: boolean; }

@Workflow("order-fulfillment")
export class OrderFulfillmentWorkflow {
  async execute(_input: OrderInput): Promise<OrderOutput> {
    return { shipped: true };
  }
}

export const payoutWorkflow = defineWorkflow<{ amount: number }, { txId: string }>({
  name: "merchant-payout",
});
`,
      "src/auth/orders.controller.ts": `import { CheckPolicies, Permissions, RequirePermissions } from "../stubs";

class CanRefundOrder {}

export class OrdersAuthController {
  @RequirePermissions("orders:read", "orders:write")
  list() {}

  @Permissions(["orders:delete"])
  remove() {}

  @CheckPolicies(CanRefundOrder)
  refund() {}
}
`,
      "src/ai/tools.ts": `import { AiTool, McpTool, defineTool } from "../stubs";

export interface SearchDocsInput { query: string; }
export interface SearchDocsOutput { hits: string[]; }

export class SupportAgent {
  @AiTool({ name: "search_docs", description: "Search docs" })
  async searchDocs(_input: SearchDocsInput): Promise<SearchDocsOutput> {
    return { hits: [] };
  }

  @McpTool("ping_health")
  async ping(): Promise<string> {
    return "ok";
  }
}

export const calcTool = defineTool<{ expr: string }, number>({
  name: "evaluate_math",
  description: "Evaluates math",
});
`,
    });

    const result = await generateBunestTypes({ cwd, loadBunestConfig: false });
    const dts = result.content;

    // 1. i18n
    expect(dts).toContain('declare module "@bunest/core/i18n"');
    expect(dts).toContain("interface BunestI18nRegistry");
    expect(dts).toContain(
      '"orders.created": { readonly actor: string | number; readonly orderId: string | number };',
    );
    expect(dts).toContain('"orders.count": { readonly count: number };');
    expect(dts).toContain('"welcome": { readonly name: string | number };');
    expect(dts).toContain(
      '"billing.invoice.paid": { readonly invoiceId: string | number };',
    );
    expect(dts).toContain('"auth.failed": { readonly email: string | number };');
    expect(dts).toContain('"common.ok": Record<string, never>;');

    // 2. jobs
    expect(dts).toContain('declare module "@bunest/jobs"');
    expect(dts).toContain("interface BunestQueueRegistry");
    expect(dts).toContain('"emails": {');
    expect(dts).toContain(
      'readonly "send-welcome": { readonly data: WelcomeJobData; readonly result: boolean };',
    );

    // 3. workflows
    expect(dts).toContain('declare module "@bunest/workflows"');
    expect(dts).toContain("interface BunestWorkflowRegistry");
    expect(dts).toContain(
      '"order-fulfillment": { readonly input: OrderInput; readonly output: OrderOutput };',
    );
    expect(dts).toContain('"merchant-payout": {');

    // 4. authz
    expect(dts).toContain('declare module "@bunest/security/authz"');
    expect(dts).toContain("interface BunestPermissionRegistry");
    expect(dts).toContain('"orders:read": true;');
    expect(dts).toContain('"orders:write": true;');
    expect(dts).toContain('"orders:delete": true;');
    expect(dts).toContain('"CanRefundOrder": true;');

    // 5. ai-tools
    expect(dts).toContain('declare module "@bunest/ai"');
    expect(dts).toContain("interface BunestAiToolRegistry");
    expect(dts).toContain(
      '"search_docs": { readonly input: SearchDocsInput; readonly output: SearchDocsOutput; readonly description: "Search docs"; };',
    );
    expect(dts).toContain('"ping_health":');
    expect(dts).toContain('"evaluate_math":');

    // Summary includes plugin counts cleanly
    expect(result.summary.plugins?.i18n).toBe(6);
    expect(result.summary.plugins?.jobs).toBe(1);
    expect(result.summary.plugins?.workflows).toBe(2);
    expect(result.summary.plugins?.authz).toBe(4);
    expect(result.summary.plugins?.["ai-tools"]).toBe(3);

    // Selective `include` filters built-in plugins cleanly
    const onlyI18n = await generateBunestTypes({
      cwd,
      include: ["i18n"],
      dryRun: true,
      loadBunestConfig: false,
    });
    expect(onlyI18n.content).toContain("BunestI18nRegistry");
    expect(onlyI18n.content).not.toContain("BunestQueueRegistry");
    expect(onlyI18n.content).not.toContain("BunestAiToolRegistry");
  });

  it("supports custom async defineTypegenPlugin() wired via bunest.config.ts and runTypegenCommand()", async () => {
    const cwd = await createTempProject({
      "src/flags.ts": `export const FEATURE_FLAGS = ["dark-mode", "beta-checkout"] as const;\n`,
      "bunest.config.ts": `export default {
  typegen: {
    plugins: [
      {
        name: "feature-flags",
        async scan(ctx: any) {
          const flags: string[] = [];
          for (const sf of ctx.sourceFiles) {
            const text = sf.getFullText();
            if (text.includes("FEATURE_FLAGS")) {
              flags.push("dark-mode", "beta-checkout");
            }
          }
          return flags;
        },
        emit(flags: string[]) {
          if (flags.length === 0) return "";
          return [
            'declare module "@acme/flags" {',
            "  interface FeatureFlagRegistry {",
            ...flags.map((f) => \`    \${JSON.stringify(f)}: boolean;\`),
            "  }",
            "}",
          ].join("\\n");
        },
      },
    ],
  },
};
`,
    });

    const directPlugin = defineTypegenPlugin({
      name: "direct-plugin",
      scan: () => ["directKey"],
      emit: (keys) =>
        `declare module "@acme/direct" {\n  interface DirectRegistry {\n    ${keys[0]}: true;\n  }\n}`,
    });

    const { io } = createCapturedIO(cwd);
    const cmdRes = await runTypegenCommand({ cwd, silent: true }, io);
    expect(cmdRes.exitCode).toBe(0);
    expect(cmdRes.result.content).toContain('declare module "@acme/flags"');
    expect(cmdRes.result.content).toContain('"dark-mode": boolean;');
    expect(cmdRes.result.content).toContain('"beta-checkout": boolean;');

    const withDirect = await generateBunestTypes({
      cwd,
      plugins: [directPlugin],
      dryRun: true,
    });
    expect(withDirect.content).toContain('declare module "@acme/flags"');
    expect(withDirect.content).toContain('declare module "@acme/direct"');
  });
});

describe("Custom Macros, Presets & Global Defaults across Typegen, Hover & Delombok", () => {
  it("expands presets, custom macros, and global defaults in typegen, resolveClassMacroMembers, and runDelombokCommand", async () => {
    const cwd = await createTempProject({
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
        name: "Auditable",
        fields: [
          { name: "createdAt", type: "Date", readonly: true },
          { name: "updatedBy", type: "string", optional: true },
        ],
        methods: {
          markUpdated: {
            signature: "(actor: string): this",
            delombokBody: "this.updatedBy = actor;\\nreturn this;",
          },
        },
        statics: {
          auditSchemaVersion: {
            signature: "(): number",
            delombokBody: "return 2;",
          },
        },
        typegen(ctx: any) {
          return [
            {
              kind: "instance",
              name: "auditTag",
              signature: \`auditTag(): "\${ctx.className}"\`,
            },
          ];
        },
      },
    ],
  },
};
`,
      "src/product.model.ts": `function DomainEntity(): ClassDecorator { return () => {}; }
function Auditable(): ClassDecorator { return () => {}; }

@DomainEntity()
@Auditable()
export class Product {
  id!: number;
  title!: string;
}
`,
    });

    // 1. Typegen emits preset-expanded members + defaults + custom macro members
    const tg = await generateBunestTypes({ cwd });
    expect(tg.content).toContain("interface Product {");
    expect(tg.content).toContain("getId(): number;");
    expect(tg.content).toContain("toBuilder(): ProductBuilder;");
    expect(tg.content).toContain("readonly createdAt: Date;");
    expect(tg.content).toContain("updatedBy?: string;");
    expect(tg.content).toContain("markUpdated(actor: string): this;");
    expect(tg.content).toContain('auditTag(): "Product";');
    expect(tg.content).toContain("interface ProductBuilder {");
    expect(tg.content).toContain("withTitle(value: string): this;");
    expect(tg.content).toContain("namespace Product {");
    expect(tg.content).toContain('export const KEYS: { readonly ID: "id"; readonly TITLE: "title" };');
    expect(tg.content).toContain("export function auditSchemaVersion(): number;");

    // 2. Analyzer + resolveClassMacroMembers (Hover / CodeLens)
    const analyzer = new BunestStaticAnalyzer({
      cwd,
      sourceRoot: "src",
      macroPresets: { DomainEntity: ["Data", "Builder", "FieldNameConstants"] },
    });
    const snap = analyzer.analyze();
    expect(snap.scan.classMacros).toHaveLength(1);
    const productMacro = snap.scan.classMacros[0]!;
    const members = resolveClassMacroMembers(productMacro);
    const memberNames = new Set(members.map((m) => m.name));
    expect(memberNames.has("getId")).toBe(true);
    expect(memberNames.has("toBuilder")).toBe(true);
    expect(memberNames.has("KEYS")).toBe(true);
    expect(memberNames.has("createdAt")).toBe(true);
    expect(memberNames.has("markUpdated")).toBe(true);
    expect(memberNames.has("auditSchemaVersion")).toBe(true);
    expect(memberNames.has("auditTag")).toBe(true);

    // 3. Delombok expands both preset `@DomainEntity()` and custom `@Auditable()`
    const delombokRes = await runDelombokCommand({
      cwd,
      target: "Product",
      dryRun: true,
      silent: true,
    });
    expect(delombokRes.exitCode).toBe(0);
    expect(delombokRes.changed).toBe(true);
    expect(delombokRes.updated).not.toContain("@DomainEntity()");
    expect(delombokRes.updated).not.toContain("@Auditable()");
    expect(delombokRes.updated).toContain("static of(");
    expect(delombokRes.updated).toContain("static readonly KEYS =");
    expect(delombokRes.updated).toContain("readonly createdAt: Date;");
    expect(delombokRes.updated).toContain("markUpdated(actor: string): this {");
    expect(delombokRes.updated).toContain("this.updatedBy = actor;");
    expect(delombokRes.updated).toContain("static auditSchemaVersion(): number {");
    expect(delombokRes.updated).toContain("return 2;");

    // Also verify buildDelombokEdit with targeted single decorator expansion
    const sf = analyzer.getSourceFile(join(cwd, "src/product.model.ts"))!;
    const cls = sf.getClass("Product")!;
    const onlyAuditable = buildDelombokEdit({
      sourceFile: sf,
      classDecl: cls,
      macro: productMacro,
      targetDecorator: "Auditable",
    });
    expect(onlyAuditable.changed).toBe(true);
    expect(onlyAuditable.updated).toContain("@DomainEntity()");
    expect(onlyAuditable.updated).not.toContain("@Auditable()");
    expect(onlyAuditable.updated).toContain("markUpdated(actor: string): this {");
  });
});

describe("Custom Architecture Diagnostic Rules & bunest check integration", () => {
  it("runs built-in BUNEST_ARCH001 & BUNEST_ARCH002 + custom quick-fix rules via analyzeProjectDiagnostics and runCheckCommand", async () => {
    expect(BUILTIN_ARCHITECTURE_RULES["no-repository-in-controller"]).toBe(
      noRepositoryInControllerRule,
    );
    expect(BUILTIN_ARCHITECTURE_RULES["require-guard-on-mutations"]).toBe(
      requireGuardOnMutationsRule,
    );

    const cwd = await createTempProject({
      "bunest.config.ts": `export default {
  diagnostics: {
    presetRules: ["no-repository-in-controller", "require-guard-on-mutations"],
    rules: [
      {
        code: "ACME_NO_TODO_CLASS",
        severity: "warning",
        description: "Disallow Todo-prefixed service names",
        check(ctx: any) {
          const hits = [];
          for (const sf of ctx.sourceFiles) {
            for (const cls of sf.getClasses()) {
              const nameNode = cls.getNameNode();
              const name = cls.getName();
              if (name && nameNode && name.startsWith("Todo")) {
                const start = nameNode.getStart();
                const end = nameNode.getEnd();
                const pos = sf.getLineAndColumnAtPos(start);
                hits.push({
                  message: \`Rename temporary class "\${name}"\`,
                  location: {
                    filePath: sf.getFilePath(),
                    line: pos.line,
                    column: pos.column,
                    endLine: pos.line,
                    endColumn: pos.column + name.length,
                    start,
                    end,
                  },
                  fix: {
                    description: "Remove Todo prefix",
                    start,
                    end,
                    newText: name.slice(4),
                  },
                });
              }
            }
          }
          return hits;
        },
      },
    ],
  },
};
`,
      "src/stubs.ts": `export function Controller(_p?: string): ClassDecorator { return () => {}; }
export function Injectable(): ClassDecorator { return () => {}; }
export function Get(_p?: string): MethodDecorator { return () => {}; }
export function Post(_p?: string): MethodDecorator { return () => {}; }
export function Delete(_p?: string): MethodDecorator { return () => {}; }
export function UseGuards(..._g: unknown[]): ClassDecorator & MethodDecorator { return () => {}; }
export function Public(): ClassDecorator & MethodDecorator { return () => {}; }
export class AuthGuard {}
`,
      "src/users.repository.ts": `import { Injectable } from "./stubs";
@Injectable()
export class UsersRepository {}
`,
      "src/users.service.ts": `import { Injectable } from "./stubs";
@Injectable()
export class TodoBillingService {}
`,
      "src/users.controller.ts": `import { AuthGuard, Controller, Delete, Get, Post, Public, UseGuards } from "./stubs";
import { UsersRepository } from "./users.repository";

@Controller("users")
export class UsersController {
  constructor(private readonly usersRepo: UsersRepository) {}

  @Get()
  list() {}

  @Post()
  createUnprotected() {}

  @Post("public-signup")
  @Public()
  signup() {}

  @Delete(":id")
  @UseGuards(AuthGuard)
  removeProtected() {}
}
`,
    });

    const { io } = createCapturedIO(cwd);
    const checkRes = await runCheckCommand({ cwd, silent: true }, io);
    const codes = new Set(checkRes.diagnostics.map((d) => d.code));

    expect(codes.has("BUNEST_ARCH001")).toBe(true);
    expect(codes.has("BUNEST_ARCH002")).toBe(true);
    expect(codes.has("ACME_NO_TODO_CLASS")).toBe(true);
    // BUNEST_ARCH002 is an error so exitCode === 1
    expect(checkRes.exitCode).toBe(1);

    // Ensure @Get(), @Public(), and @UseGuards() routes were NOT flagged by BUNEST_ARCH002
    const arch002 = checkRes.diagnostics.filter((d) => d.code === "BUNEST_ARCH002");
    expect(arch002).toHaveLength(1);
    expect(arch002[0]!.message).toContain("createUnprotected");

    // Verify `bunest check --fix` applies custom rule quick-fix edit
    const fixRes = await runCheckCommand({ cwd, fix: true, silent: true }, io);
    expect(fixRes.fixedCount).toBeGreaterThanOrEqual(1);
    const updatedService = await Bun.file(join(cwd, "src/users.service.ts")).text();
    expect(updatedService).toContain("export class BillingService");
    expect(updatedService).not.toContain("TodoBillingService");

    // Verify direct analyzeProjectDiagnostics() with defineDiagnosticRule()
    const customRule = defineDiagnosticRule({
      code: "CUSTOM_DIRECT_001",
      severity: "info",
      description: "Direct test rule",
      check(ctx) {
        const first = ctx.sourceFiles[0];
        if (!first) return [];
        return [
          {
            message: "Direct diagnostic hit",
            location: {
              filePath: first.getFilePath(),
              line: 1,
              column: 1,
              endLine: 1,
              endColumn: 2,
              start: 0,
              end: 1,
            },
          },
        ];
      },
    });
    const analyzer = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" });
    const snap = analyzer.analyze();
    const directDiags = analyzeProjectDiagnostics({
      sourceFiles: analyzer.getScanner().getTrackedSourceFiles(),
      scan: snap.scan,
      moduleGraph: snap.moduleGraph,
      repositoryDiagnostics: [],
      entities: snap.entities,
      repositories: snap.repositories,
      customRules: [customRule],
    });
    expect(directDiags.some((d) => d.code === "CUSTOM_DIRECT_001")).toBe(true);
  });
});

describe("Repository Query Analyzer: Custom ORM Operators, Scopes, @Projection & Pagination", () => {
  it("recognizes custom ORM query operators, @SoftDelete, @TenantScoped, @IgnoreScope, @Projection, findPageBy*, and findCursorBy*", async () => {
    // Register custom operators in global ORM registry (as @bunest/orm's registerQueryOperator does)
    const g = globalThis as unknown as Record<symbol, unknown>;
    g[CUSTOM_ORM_OPERATORS_SYMBOL] = new Map([
      [
        "Matches",
        {
          suffix: "Matches",
          arity: 1,
          description: "Matches column against regular expression",
          toSql(ctx: {
            quotedColumn: string;
            dialect: string;
            nextPlaceholder: () => string;
          }) {
            const p = ctx.nextPlaceholder();
            return {
              sql:
                ctx.dialect === "postgres"
                  ? `${ctx.quotedColumn} ~ ${p}`
                  : `${ctx.quotedColumn} REGEXP ${p}`,
            };
          },
        },
      ],
      [
        "JsonContains",
        {
          suffix: "JsonContains",
          arity: 1,
          description: "Checks JSON array/object containment",
          toSql(ctx: {
            quotedColumn: string;
            dialect: string;
            nextPlaceholder: () => string;
          }) {
            const p = ctx.nextPlaceholder();
            return {
              sql:
                ctx.dialect === "postgres"
                  ? `${ctx.quotedColumn} @> ${p}::jsonb`
                  : `json_extract(${ctx.quotedColumn}, '$') LIKE ${p}`,
            };
          },
        },
      ],
    ]);

    const cwd = await createTempProject({
      "src/article.entity.ts": `function Entity(_n?: string): ClassDecorator { return () => {}; }
function PrimaryGeneratedColumn(): PropertyDecorator { return () => {}; }
function Column(_o?: any): PropertyDecorator { return () => {}; }

@Entity("articles")
export class ArticleEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column()
  bio!: string;

  @Column()
  tags!: string;

  @Column()
  published!: boolean;

  @Column({ name: "deleted_at" })
  deletedAt?: Date;

  @Column({ name: "tenant_id" })
  tenantId!: string;
}
`,
      "src/article.repository.ts": `import { ArticleEntity } from "./article.entity";
function Repository(_e?: any): ClassDecorator { return () => {}; }
function SoftDelete(_o?: any): ClassDecorator { return () => {}; }
function TenantScoped(_o?: any): ClassDecorator { return () => {}; }
function IgnoreScope(..._names: string[]): MethodDecorator { return () => {}; }
function Projection(..._fields: unknown[]): MethodDecorator { return () => {}; }
abstract class CrudRepository<T, K = number> {}
interface Pageable { page: number; size: number; }
interface Page<T> { items: T[]; total: number; }
interface CursorPageable { cursor?: number; limit: number; }
interface CursorPage<T> { items: T[]; nextCursor: number | null; hasMore: boolean; }

@Repository(ArticleEntity)
@SoftDelete()
@TenantScoped()
export abstract class ArticleRepository extends CrudRepository<ArticleEntity, number> {
  abstract findAllByBioMatchesAndTagsJsonContains(pattern: string, tag: string): Promise<ArticleEntity[]>;

  @Projection("id", "title")
  abstract findByTitle(title: string): Promise<Pick<ArticleEntity, "id" | "title"> | null>;

  @IgnoreScope("softDelete")
  abstract findAllByPublishedIsTrue(): Promise<ArticleEntity[]>;

  @IgnoreScope()
  abstract countByPublishedIsTrue(): Promise<number>;

  abstract findPageByPublishedIsTrue(pageable: Pageable): Promise<Page<ArticleEntity>>;

  abstract findCursorByPublishedIsTrue(cursor: CursorPageable): Promise<CursorPage<ArticleEntity>>;

  @Projection("id", "nonExistentCol")
  abstract findOneByTitle(title: string): Promise<Pick<ArticleEntity, "id"> | null>;
}
`,
    });

    const analyzer = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" });
    const snap = analyzer.analyze();
    const repo = snap.repositories.find((r) => r.className === "ArticleRepository")!;
    expect(repo).toBeDefined();
    expect(repo.scopes?.map((s) => s.name)).toEqual(["softDelete", "tenant"]);

    // 1. Custom operators SQL preview + zero false diagnostics
    const customMethod = repo.methods.find(
      (m) => m.name === "findAllByBioMatchesAndTagsJsonContains",
    )!;
    expect(customMethod.derived?.conditions.map((c) => c.operator)).toEqual([
      "Matches",
      "JsonContains",
    ]);
    expect(customMethod.derived?.sqlByDialect.sqlite).toBe(
      `SELECT * FROM "articles" WHERE "bio" REGEXP ? AND json_extract("tags", '$') LIKE ? AND "deleted_at" IS NULL AND "tenant_id" = ?`,
    );
    expect(customMethod.derived?.sqlByDialect.postgres).toBe(
      `SELECT * FROM "articles" WHERE "bio" ~ $1 AND "tags" @> $2::jsonb AND "deleted_at" IS NULL AND "tenant_id" = $3`,
    );

    // 2. @Projection("id", "title") renders SELECT "id", "title" and passes return type check
    const projMethod = repo.methods.find((m) => m.name === "findByTitle")!;
    expect(projMethod.projectedFields).toEqual(["id", "title"]);
    expect(projMethod.derived?.sqlByDialect.sqlite).toContain(
      'SELECT "id", "title" FROM "articles"',
    );

    // 3. @IgnoreScope("softDelete") omits deleted_at IS NULL while keeping tenant_id
    const ignoreSoftDel = repo.methods.find(
      (m) => m.name === "findAllByPublishedIsTrue",
    )!;
    expect(ignoreSoftDel.derived?.sqlByDialect.sqlite).not.toContain("deleted_at");
    expect(ignoreSoftDel.derived?.sqlByDialect.sqlite).toContain('"tenant_id" = ?');

    // 4. @IgnoreScope() omits ALL scopes
    const ignoreAll = repo.methods.find(
      (m) => m.name === "countByPublishedIsTrue",
    )!;
    expect(ignoreAll.derived?.sqlByDialect.sqlite).toBe(
      `SELECT COUNT(*) AS count FROM "articles" WHERE "published" = 1`,
    );

    // 5. findPageBy* & findCursorBy*
    const pageMethod = repo.methods.find(
      (m) => m.name === "findPageByPublishedIsTrue",
    )!;
    expect(pageMethod.derived?.kind).toBe("findPage");
    expect(pageMethod.derived?.expectedReturnType).toBe(
      "Promise<Page<ArticleEntity>>",
    );
    expect(pageMethod.derived?.sqlByDialect.sqlite).toContain("LIMIT ? OFFSET ?");

    const cursorMethod = repo.methods.find(
      (m) => m.name === "findCursorByPublishedIsTrue",
    )!;
    expect(cursorMethod.derived?.kind).toBe("findCursor");
    expect(cursorMethod.derived?.expectedReturnType).toBe(
      "Promise<CursorPage<ArticleEntity>>",
    );
    expect(cursorMethod.derived?.sqlByDialect.sqlite).toContain(
      'ORDER BY "id" ASC LIMIT ?',
    );

    // 6. Only invalid @Projection("nonExistentCol") should trigger a BUNEST_REPO* diagnostic!
    const repoDiags = snap.diagnostics.filter((d) =>
      String(d.code).startsWith("BUNEST_REPO"),
    );
    expect(repoDiags).toHaveLength(1);
    expect(repoDiags[0]!.code).toBe("BUNEST_REPO001");
    expect(repoDiags[0]!.message).toContain("nonExistentCol");

    // 7. VS Code completions surface custom operators + findPageBy + findCursorBy
    const prefixCompletions = getRepositoryDerivedCompletions(repo, "find");
    expect(prefixCompletions.map((c) => c.label)).toContain("findPageBy");
    expect(prefixCompletions.map((c) => c.label)).toContain("findCursorBy");

    const opCompletions = getRepositoryDerivedCompletions(repo, "findByBio");
    const matchesComp = opCompletions.find((c) => c.label === "Matches");
    expect(matchesComp).toBeDefined();
    expect(matchesComp?.detail).toContain("Matches column against regular expression");

    // 8. parseDerivedMethodName also honors bunestConfig.orm.queryOperators directly
    const parsedDirect = parseDerivedMethodName("findAllByTitleFuzzySearch", {
      tableName: "articles",
      entityName: "ArticleEntity",
      entity: repo.entity,
      dialect: "postgres",
      bunestConfig: {
        orm: {
          queryOperators: [
            {
              suffix: "FuzzySearch",
              arity: 1,
              toSql: (ctx) => ({
                sql: `similarity(${ctx.quotedColumn}, ${ctx.nextPlaceholder()}) > 0.3`,
              }),
            },
          ],
        },
      },
    });
    expect(parsedDirect?.conditions[0]?.operator).toBe("FuzzySearch");
    expect(parsedDirect?.sqlPreview).toBe(
      `SELECT * FROM "articles" WHERE similarity("title", $1) > 0.3`,
    );
  });
});
