import { afterEach, describe, expect, it } from "bun:test";
import {
  dirname,
  ensureDir,
  join,
  mkdirSyncPath,
  removePath,
  statPath,
  writeTextSync,
} from "@bunest/core";
import { SchemaExplorer } from "../../swagger/src/index";
import {
  BunestStaticAnalyzer,
  BunestTypegenScanner,
  bunestMetadataPlugin,
  emitBunestDeclaration,
  generateBunestTypes,
  generateMetadataFile,
  parseCliArgs,
  runCli,
  runDevServer,
  runGraphCommand,
  transformControllerMetadataSource,
  transformDtoMetadataSource,
  validateGeneratedDeclaration,
  type CliIO,
  type StaticGraphJsonOutput,
} from "../src";
import { emitClientRouteTypes } from "../src/typegen";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

function createTempProject(
  prefix: string,
  files: Record<string, string>,
): string {
  const dir = join(TMP_DIR, `${prefix}-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSyncPath(dir, { recursive: true });
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSyncPath(dirname(abs), { recursive: true });
    writeTextSync(abs, content);
  }
  return dir;
}

function createCapturedIO(cwd?: string): {
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
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    },
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await statPath(p);
    return true;
  } catch {
    return false;
  }
}

const DECORATORS_STUB = `
export function Module(_o?: any): ClassDecorator { return () => {}; }
export function AutoModule(_o?: any): ClassDecorator { return () => {}; }
export function Global(): ClassDecorator { return () => {}; }
export function Injectable(_o?: any): ClassDecorator { return () => {}; }
export function Controller(_p?: any): ClassDecorator { return () => {}; }
export function Inject(_t?: any): ParameterDecorator { return () => {}; }
export function Optional(): ParameterDecorator { return () => {}; }
export function InjectRepository(_e?: any): ParameterDecorator { return () => {}; }
export function InjectConfig(_k?: any): ParameterDecorator { return () => {}; }
export function InjectQueue(_q?: any): ParameterDecorator { return () => {}; }
export function forwardRef<T>(fn: () => T): T { return fn(); }
export function getRepositoryToken(entity: unknown): string { return String(entity); }
export function Get(_p?: any): MethodDecorator { return () => {}; }
export function Post(_p?: any): MethodDecorator { return () => {}; }
export function Patch(_p?: any): MethodDecorator { return () => {}; }
export function Body(..._args: any[]): ParameterDecorator { return () => {}; }
export function Query(..._args: any[]): ParameterDecorator { return () => {}; }
export function Param(..._args: any[]): ParameterDecorator { return () => {}; }
export function UseStandardSchema(_s?: any): MethodDecorator { return () => {}; }
export function SerializeOptions(_o?: any): MethodDecorator { return () => {}; }
export class StandardSchemaValidationPipe { constructor(_s?: any) {} }
`;

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// 1. Static DI Analyzer v2 (BUNEST008 - BUNEST011)
// ============================================================================
describe("Static DI Analyzer v2 (BUNEST008–011)", () => {
  it("BUNEST008: flags interface & type-alias constructor params without @Inject across @Injectable/@Controller and avoids false positives", async () => {
    const cwd = createTempProject("bunest-diag-008", {
      "src/decorators.ts": DECORATORS_STUB,
      "src/contracts.ts": `
        export interface PaymentGateway {
          charge(amount: number): Promise<void>;
        }
        export type AuditSink = { write(entry: string): void };
        export interface MergedToken { ping(): string; }
        export class MergedToken { ping() { return "pong"; } }
        export abstract class AbstractRepo { abstract findAll(): string[]; }
        export class ConfigService {}
        export class ClsService {}
        export class Reflector {}
        export const PAYMENT_TOKEN = Symbol("PAYMENT_TOKEN");
      `,
      "src/bad.service.ts": `
        import { Injectable, Controller, Inject, Optional, InjectRepository, InjectConfig, InjectQueue } from "./decorators";
        import { PaymentGateway, AbstractRepo, MergedToken, ConfigService, ClsService, Reflector, PAYMENT_TOKEN } from "./contracts";
        import type { AuditSink } from "./contracts";

        interface LocalMailer {
          send(to: string): void;
        }
        type LocalClock = () => number;

        @Injectable()
        export class BadBillingService {
          constructor(
            private readonly gateway: PaymentGateway,
            private readonly sink: AuditSink,
            private readonly mailer: LocalMailer,
            private readonly clock: LocalClock,
          ) {}
        }

        @Controller("good")
        export class GoodBillingController {
          constructor(
            @Inject(PAYMENT_TOKEN) private readonly gateway: PaymentGateway,
            @Optional() private readonly optionalMailer?: LocalMailer,
            private readonly repo: AbstractRepo = null as unknown as AbstractRepo,
            private readonly merged: MergedToken = new MergedToken(),
            private readonly config: ConfigService = new ConfigService(),
            private readonly cls: ClsService = new ClsService(),
            private readonly reflector: Reflector = new Reflector(),
            @InjectRepository("User") private readonly userRepo?: PaymentGateway,
            @InjectConfig("app") private readonly appCfg?: AuditSink,
            @InjectQueue("mail") private readonly mailQ?: LocalMailer,
          ) {}
        }

        @Controller("bad")
        export class BadBillingController {
          constructor(private readonly gateway: PaymentGateway) {}
        }
      `,
      "src/app.module.ts": `
        import { Module } from "./decorators";
        import { BadBillingService, GoodBillingController, BadBillingController } from "./bad.service";
        import { AbstractRepo, MergedToken, PAYMENT_TOKEN } from "./contracts";

        @Module({
          controllers: [GoodBillingController, BadBillingController],
          providers: [
            BadBillingService,
            AbstractRepo,
            MergedToken,
            { provide: PAYMENT_TOKEN, useValue: {} },
          ],
        })
        export class AppModule {}
      `,
    });

    const analyzer = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" });
    const snap = analyzer.analyze();

    const b008 = snap.diagnostics.filter((d) => d.code === "BUNEST008");
    // 4 in BadBillingService (PaymentGateway, AuditSink, LocalMailer, LocalClock) + 1 in BadBillingController (PaymentGateway)
    expect(b008).toHaveLength(5);
    for (const d of b008) {
      expect(d.severity).toBe("error");
      expect(d.suggestion).toBeDefined();
      expect(d.suggestion).toContain("@Inject(");
      expect(d.message).toContain("abstract class");
      expect(d.location.line).toBeGreaterThan(0);
    }
    expect(b008.some((d) => d.message.includes("PaymentGateway") && d.message.includes("BadBillingService"))).toBe(true);
    expect(b008.some((d) => d.message.includes("AuditSink") && d.message.includes("type alias"))).toBe(true);
    expect(b008.some((d) => d.message.includes("LocalMailer") && d.message.includes("interface"))).toBe(true);
    expect(b008.some((d) => d.message.includes("LocalClock") && d.message.includes("type alias"))).toBe(true);
    expect(b008.some((d) => d.message.includes("BadBillingController"))).toBe(true);

    // GoodBillingController must produce ZERO BUNEST008 diagnostics
    expect(b008.some((d) => d.message.includes("GoodBillingController"))).toBe(false);

    // AuditSink was imported with `import type` — BUNEST008 supersedes BUNEST004 (no duplicate noisy BUNEST004)
    const b004 = snap.diagnostics.filter((d) => d.code === "BUNEST004");
    expect(b004.some((d) => d.message.includes("AuditSink"))).toBe(false);

    // Verify CLI `bunest check --format json` surfaces BUNEST008 with `suggestion`
    const checkCap = createCapturedIO(cwd);
    const checkRes = await runCli(["check", "--format", "json"], checkCap.io);
    expect(checkRes.exitCode).toBe(1);
    const checkJson = JSON.parse(checkCap.stdout.join("\n")) as {
      diagnostics: Array<{ code: string; severity: string; suggestion?: string }>;
    };
    const jsonB008 = checkJson.diagnostics.filter((d) => d.code === "BUNEST008");
    expect(jsonB008).toHaveLength(5);
    expect(jsonB008[0]?.suggestion).toContain("@Inject(");
  });

  it("BUNEST009: flags unprovided @Inject(TOKEN) string/symbol tokens and skips provided, imported, @Global, @Optional, and well-known framework tokens", () => {
    const cwd = createTempProject("bunest-diag-009", {
      "src/decorators.ts": DECORATORS_STUB,
      "src/tokens.ts": `
        export const PROVIDED_SYM = Symbol("PROVIDED_SYM");
        export const MISSING_SYM = Symbol("MISSING_SYM");
        export const SHARED_CONST_TOKEN = "SHARED_STRING_KEY";
        export const GLOBAL_TOKEN = Symbol("GLOBAL_TOKEN");
        export const REQUEST = "REQUEST";
        export const HTTP_ADAPTER_HOST = "HTTP_ADAPTER_HOST";
        export const CACHE_MANAGER = "CACHE_MANAGER";
        export class Reflector {}
        export class ModuleRef {}
        export class ClsService {}
        export class ConfigService {}
        export class UserEntity {}
      `,
      "src/shared.module.ts": `
        import { Module, Global } from "./decorators";
        import { SHARED_CONST_TOKEN, GLOBAL_TOKEN } from "./tokens";

        @Module({
          providers: [{ provide: SHARED_CONST_TOKEN, useValue: { ok: true } }],
          exports: [SHARED_CONST_TOKEN],
        })
        export class SharedModule {}

        @Global()
        @Module({
          providers: [{ provide: GLOBAL_TOKEN, useValue: "global" }],
          exports: [GLOBAL_TOKEN],
        })
        export class GlobalConfigModule {}
      `,
      "src/consumer.service.ts": `
        import { Injectable, Inject, Optional, InjectRepository, InjectConfig, InjectQueue, getRepositoryToken } from "./decorators";
        import {
          PROVIDED_SYM,
          MISSING_SYM,
          GLOBAL_TOKEN,
          REQUEST,
          HTTP_ADAPTER_HOST,
          CACHE_MANAGER,
          Reflector,
          ModuleRef,
          ClsService,
          ConfigService,
          UserEntity,
        } from "./tokens";

        @Injectable()
        export class ConsumerService {
          constructor(
            // Positive cases -> MUST emit BUNEST009
            @Inject("UNREGISTERED_STR_TOKEN") private readonly badStr: unknown,
            @Inject(MISSING_SYM) private readonly badSym: unknown,

            // Negative cases -> MUST NOT emit BUNEST009
            @Inject("LOCAL_STR_TOKEN") private readonly okLocalStr: unknown,
            @Inject(PROVIDED_SYM) private readonly okLocalSym: unknown,
            @Inject("SHARED_STRING_KEY") private readonly okImportedAlias: unknown,
            @Inject(GLOBAL_TOKEN) private readonly okGlobal: unknown,
            @Optional() @Inject("OPTIONAL_MISSING") private readonly okOpt: unknown,
            @Inject(REQUEST) private readonly req: unknown,
            @Inject(HTTP_ADAPTER_HOST) private readonly adapterHost: unknown,
            @Inject(CACHE_MANAGER) private readonly cache: unknown,
            @Inject(Reflector) private readonly reflector: unknown,
            @Inject(ModuleRef) private readonly modRef: unknown,
            @Inject(ClsService) private readonly cls: unknown,
            @Inject(ConfigService) private readonly cfg: unknown,
            @Inject(getRepositoryToken(UserEntity)) private readonly repoToken: unknown,
            @InjectRepository(UserEntity) private readonly repoDec: unknown,
            @InjectConfig("db") private readonly cfgDec: unknown,
            @InjectQueue("emails") private readonly qDec: unknown,
          ) {}
        }
      `,
      "src/app.module.ts": `
        import { Module } from "./decorators";
        import { SharedModule, GlobalConfigModule } from "./shared.module";
        import { ConsumerService } from "./consumer.service";
        import { PROVIDED_SYM } from "./tokens";

        @Module({
          imports: [SharedModule, GlobalConfigModule],
          providers: [
            ConsumerService,
            { provide: "LOCAL_STR_TOKEN", useValue: 123 },
            { provide: PROVIDED_SYM, useValue: 456 },
          ],
        })
        export class AppModule {}
      `,
    });

    const snap = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" }).analyze();
    const b009 = snap.diagnostics.filter((d) => d.code === "BUNEST009");

    expect(b009).toHaveLength(2);
    expect(b009.every((d) => d.severity === "warning")).toBe(true);
    expect(b009.some((d) => d.message.includes('"UNREGISTERED_STR_TOKEN"'))).toBe(true);
    expect(b009.some((d) => d.message.includes("MISSING_SYM"))).toBe(true);
    expect(b009.every((d) => Boolean(d.suggestion))).toBe(true);
  });

  it("BUNEST010: detects direct, transitive, and self circular @Module({ imports }) cycles while allowing forwardRef(() => ...)", () => {
    const cwd = createTempProject("bunest-diag-010", {
      "src/decorators.ts": DECORATORS_STUB,
      "src/mod-a.module.ts": `
        import { Module } from "./decorators";
        import { ModB } from "./mod-b.module";
        @Module({ imports: [ModB] })
        export class ModA {}
      `,
      "src/mod-b.module.ts": `
        import { Module } from "./decorators";
        import { ModC } from "./mod-c.module";
        @Module({ imports: [ModC] })
        export class ModB {}
      `,
      "src/mod-c.module.ts": `
        import { Module } from "./decorators";
        import { ModA } from "./mod-a.module";
        @Module({ imports: [ModA] })
        export class ModC {}
      `,
      "src/safe-x.module.ts": `
        import { Module, forwardRef } from "./decorators";
        import { SafeY } from "./safe-y.module";
        @Module({ imports: [forwardRef(() => SafeY)] })
        export class SafeX {}
      `,
      "src/safe-y.module.ts": `
        import { Module, forwardRef } from "./decorators";
        import { SafeX } from "./safe-x.module";
        @Module({ imports: [forwardRef(() => SafeX)] })
        export class SafeY {}
      `,
    });

    const snap = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" }).analyze();
    const b010 = snap.diagnostics.filter((d) => d.code === "BUNEST010");

    expect(b010).toHaveLength(1);
    expect(b010[0]!.severity).toBe("error");
    expect(b010[0]!.message).toContain("ModA -> ModB -> ModC -> ModA");
    expect(b010[0]!.message).toContain("forwardRef(() => ModB)");
    expect(b010[0]!.suggestion).toContain("forwardRef");

    // SafeX <-> SafeY uses forwardRef, so zero BUNEST010 for them
    expect(b010.some((d) => d.message.includes("SafeX"))).toBe(false);
  });

  it("BUNEST011: flags @Module({ exports }) items not in providers or imports (mirroring BUNEST_E007) while allowing valid exports and transitive re-exports", () => {
    const cwd = createTempProject("bunest-diag-011", {
      "src/decorators.ts": DECORATORS_STUB,
      "src/services.ts": `
        import { Injectable } from "./decorators";
        @Injectable() export class OwnedService {}
        @Injectable() export class ExportedFromChildService {}
        @Injectable() export class PrivateInChildService {}
        @Injectable() export class OrphanService {}
      `,
      "src/leaf.module.ts": `
        import { Module } from "./decorators";
        import { ExportedFromChildService, PrivateInChildService } from "./services";
        @Module({
          providers: [ExportedFromChildService, PrivateInChildService],
          exports: [ExportedFromChildService],
        })
        export class LeafModule {}
      `,
      "src/unimported.module.ts": `
        import { Module } from "./decorators";
        @Module({})
        export class UnimportedModule {}
      `,
      "src/broken.module.ts": `
        import { Module } from "./decorators";
        import { LeafModule } from "./leaf.module";
        import { UnimportedModule } from "./unimported.module";
        import {
          OwnedService,
          ExportedFromChildService,
          PrivateInChildService,
          OrphanService,
        } from "./services";

        @Module({
          imports: [LeafModule],
          providers: [OwnedService],
          exports: [
            // Valid exports:
            OwnedService,
            LeafModule,
            ExportedFromChildService,
            // Invalid exports -> MUST emit BUNEST011:
            OrphanService,
            PrivateInChildService,
            UnimportedModule,
            "MISSING_EXPORT_TOKEN",
          ],
        })
        export class BrokenModule {}
      `,
    });

    const snap = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" }).analyze();
    const b011 = snap.diagnostics.filter((d) => d.code === "BUNEST011");

    expect(b011).toHaveLength(4);
    expect(b011.every((d) => d.severity === "error")).toBe(true);
    expect(b011.every((d) => d.message.includes("BUNEST_E007"))).toBe(true);
    expect(b011.some((d) => d.message.includes('"OrphanService"'))).toBe(true);
    expect(b011.some((d) => d.message.includes('"PrivateInChildService"'))).toBe(true);
    expect(b011.some((d) => d.message.includes('"UnimportedModule"'))).toBe(true);
    expect(b011.some((d) => d.message.includes('"MISSING_EXPORT_TOKEN"'))).toBe(true);

    // Valid exports MUST NOT be flagged
    expect(b011.some((d) => d.message.includes('"OwnedService"'))).toBe(false);
    expect(b011.some((d) => d.message.includes('"LeafModule"'))).toBe(false);
    expect(b011.some((d) => d.message.includes('"ExportedFromChildService"'))).toBe(false);
  });
});

// ============================================================================
// 2. Offline HTML DI Graph Visualizer + --cycles-only
// ============================================================================
describe("Offline HTML DI Graph Visualizer (bunest graph --format html)", () => {
  it("generates zero-CDN interactive HTML with pan/zoom, search, inspector, routes, and red BUNEST002 + BUNEST010 cycle highlighting", async () => {
    const cwd = createTempProject("bunest-graph-html", {
      "src/decorators.ts": DECORATORS_STUB,
      "src/alpha/alpha.service.ts": `
        import { Injectable } from "../decorators";
        import { BetaService } from "../beta/beta.service";
        @Injectable()
        export class AlphaService {
          constructor(private readonly beta: BetaService) {}
        }
      `,
      "src/alpha/alpha.controller.ts": `
        import { Controller, Get } from "../decorators";
        import { AlphaService } from "./alpha.service";
        @Controller("alpha")
        export class AlphaController {
          constructor(private readonly alpha: AlphaService) {}
          @Get("status")
          status(): { ok: boolean } { return { ok: true }; }
        }
      `,
      "src/alpha/alpha.module.ts": `
        import { Module } from "../decorators";
        import { BetaModule } from "../beta/beta.module";
        import { AlphaService } from "./alpha.service";
        import { AlphaController } from "./alpha.controller";
        @Module({
          imports: [BetaModule],
          controllers: [AlphaController],
          providers: [AlphaService],
          exports: [AlphaService],
        })
        export class AlphaModule {}
      `,
      "src/beta/beta.service.ts": `
        import { Injectable } from "../decorators";
        import { AlphaService } from "../alpha/alpha.service";
        @Injectable()
        export class BetaService {
          constructor(private readonly alpha: AlphaService) {}
        }
      `,
      "src/beta/beta.module.ts": `
        import { Module } from "../decorators";
        import { AlphaModule } from "../alpha/alpha.module";
        import { BetaService } from "./beta.service";
        @Module({
          imports: [AlphaModule],
          providers: [BetaService],
          exports: [BetaService],
        })
        export class BetaModule {}
      `,
      "src/healthy/healthy.service.ts": `
        import { Injectable } from "../decorators";
        @Injectable()
        export class HealthyService {}
      `,
      "src/healthy/healthy.module.ts": `
        import { Module } from "../decorators";
        import { HealthyService } from "./healthy.service";
        @Module({ providers: [HealthyService], exports: [HealthyService] })
        export class HealthyModule {}
      `,
    });

    const cap = createCapturedIO(cwd);
    const cliRes = await runCli(["graph", "--format", "html"], cap.io);
    expect(cliRes.exitCode).toBe(0);
    const html = cap.stdout.join("\n");

    // Self-contained offline HTML structure (ZERO external CDN/network references!)
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<svg id="di-svg"');
    expect(html).toContain('id="graph-search"');
    expect(html).toContain('id="module-filter"');
    expect(html).toContain('id="cycles-only-toggle"');
    expect(html).toContain('id="inspector"');
    expect(html).toContain('id="zoom-in"');
    expect(html).toContain('id="zoom-reset"');
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);

    // Cycle highlighting for BOTH BUNEST002 (provider) and BUNEST010 (module) cycles
    expect(html).toContain("dg-cycle-node");
    expect(html).toContain("dg-edge-cycle");
    expect(html).toContain("arrow-cycle");
    expect(html).toContain("BUNEST002");
    expect(html).toContain("BUNEST010");
    expect(html).toContain("AlphaModule");
    expect(html).toContain("BetaModule");
    expect(html).toContain("AlphaService");
    expect(html).toContain("BetaService");
    // Discovered controller routes are embedded for click-to-inspect
    expect(html).toContain("/alpha/status");
    expect(html).toContain("AlphaController");

    // `--cycles-only --format json` isolates cyclic nodes/edges and omits HealthyModule/HealthyService
    const cycRes = await runGraphCommand({
      cwd,
      format: "json",
      cyclesOnly: true,
      silent: true,
    });
    expect(cycRes.exitCode).toBe(0);
    const parsed = JSON.parse(cycRes.output) as StaticGraphJsonOutput;
    expect(parsed.cyclesOnly).toBe(true);
    expect(parsed.cycles.length).toBeGreaterThanOrEqual(1);
    expect(parsed.moduleCycles?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(parsed.modules.map((m) => m.name)).toEqual(["AlphaModule", "BetaModule"]);
    expect(parsed.providers.some((p) => p.name === "HealthyService")).toBe(false);
    expect(parsed.providers.some((p) => p.name === "AlphaService")).toBe(true);
    expect(parsed.providers.some((p) => p.name === "BetaService")).toBe(true);
  });
});

// ============================================================================
// 3. Standard Schema Typegen Inference + dev.ts clientTypes Wiring
// ============================================================================
describe("Standard Schema Typegen Inference & dev.ts clientTypes Wiring", () => {
  it("infers body, query, params, and response types from inline Standard Schema DSL, createSchemaDto, and external StandardSchemaV1 schemas", async () => {
    const cwd = createTempProject("bunest-typegen-stdschema", {
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            module: "Preserve",
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            verbatimModuleSyntax: true,
            strict: true,
            noEmit: true,
          },
        },
        null,
        2,
      ),
      "src/decorators.ts": DECORATORS_STUB,
      "src/schemas.ts": `
        export interface StandardSchemaV1<Input = unknown, Output = Input> {
          readonly "~standard": {
            readonly version: 1;
            readonly vendor: string;
            readonly validate: (value: unknown) => { value: Output } | { issues: ReadonlyArray<{ message: string }> };
            readonly types?: { readonly input: Input; readonly output: Output };
          };
        }

        declare const s: any;
        declare function createSchemaDto<T>(schema: T): any;

        export const CreateUserSchema = s.object({
          email: s.string().email(),
          name: s.string().optional(),
          role: s.enum(["admin", "member"]).default("member"),
          tags: s.array(s.string()),
        });

        export const ListUsersQuerySchema = s.object({
          page: s.number().default(1),
          search: s.string().nullable().optional(),
        });

        export const UserParamsSchema = s.object({
          id: s.string(),
        });

        export const IdSchema = s.string();

        export const UserResponseSchema = s.object({
          id: s.string(),
          email: s.string(),
          role: s.enum(["admin", "member"]).default("member"),
        });

        export class CreateUserDto extends createSchemaDto(CreateUserSchema) {}

        // External / custom Standard Schema (no s.* DSL call)
        export const ExternalWebhookSchema: StandardSchemaV1<
          { event: string; retries?: number },
          { event: string; retries: number }
        > = {
          "~standard": {
            version: 1,
            vendor: "custom",
            validate: (v) => ({ value: v as { event: string; retries: number } }),
          },
        };
      `,
      "src/users.controller.ts": `
        import {
          Body,
          Controller,
          Get,
          Param,
          Patch,
          Post,
          Query,
          UseStandardSchema,
          StandardSchemaValidationPipe,
        } from "./decorators";
        import {
          CreateUserSchema,
          ListUsersQuerySchema,
          UserParamsSchema,
          IdSchema,
          UserResponseSchema,
          CreateUserDto,
          ExternalWebhookSchema,
        } from "./schemas";

        @Controller("users")
        export class UsersController {
          @Post()
          @UseStandardSchema(UserResponseSchema)
          create(@Body(CreateUserSchema) payload: unknown) {
            return payload;
          }

          @Get()
          list(@Query(ListUsersQuerySchema) query) {
            return query;
          }

          @Get(":id")
          @UseStandardSchema(UserResponseSchema)
          findOne(@Param(UserParamsSchema) params: unknown) {
            return params;
          }

          @Patch(":id")
          update(
            @Param("id", IdSchema) id: unknown,
            @Body({ schema: CreateUserSchema }) body: unknown,
          ) {
            return { id, body };
          }

          @Post("dto")
          createFromDto(@Body() dto: CreateUserDto): { ok: boolean } {
            return { ok: Boolean(dto) };
          }

          @Post("webhook")
          @UseStandardSchema(ExternalWebhookSchema)
          webhook(@Body(new StandardSchemaValidationPipe(ExternalWebhookSchema)) payload: unknown) {
            return payload;
          }
        }
      `,
    });

    const scanner = new BunestTypegenScanner({
      cwd,
      sourceRoot: "src",
      include: ["routes"],
    });
    const scan = await scanner.scan();

    const byKey = new Map(scan.routes.map((r) => [`${r.method} ${r.path}`, r]));

    // POST /users: @Body(CreateUserSchema) + @UseStandardSchema(UserResponseSchema)
    const createRoute = byKey.get("POST /users")!;
    expect(createRoute).toBeDefined();
    expect(createRoute.bodyTypeText).toContain("email: string");
    expect(createRoute.bodyTypeText).toContain("name?: string");
    // `.default("member")` is optional in INPUT body, required in OUTPUT response!
    expect(createRoute.bodyTypeText).toContain('role?: "admin" | "member"');
    expect(createRoute.bodyTypeText).toContain("tags: string[]");
    expect(createRoute.responseTypeText).toContain("id: string");
    expect(createRoute.responseTypeText).toContain('role: "admin" | "member"');
    expect(createRoute.responseTypeText).not.toContain("role?:");

    // GET /users: @Query(ListUsersQuerySchema) even with omitted TS annotation
    const listRoute = byKey.get("GET /users")!;
    expect(listRoute.queryTypeText).toContain("page?: number");
    expect(listRoute.queryTypeText).toContain("search?: string | null");

    // GET /users/:id: @Param(UserParamsSchema)
    const findOneRoute = byKey.get("GET /users/:id")!;
    expect(findOneRoute.paramsTypeText).toContain("id: string");
    expect(findOneRoute.responseTypeText).toContain("email: string");

    // PATCH /users/:id: @Param("id", IdSchema) + @Body({ schema: CreateUserSchema })
    const updateRoute = byKey.get("PATCH /users/:id")!;
    expect(updateRoute.paramsTypeText).toBe("{ id: string }");
    expect(updateRoute.bodyTypeText).toContain("email: string");

    // POST /users/webhook: exported StandardSchemaV1<In, Out> wrapped in new StandardSchemaValidationPipe(...)
    const webhookRoute = byKey.get("POST /users/webhook")!;
    expect(webhookRoute.bodyTypeText).toBe(
      "StandardSchemaInferInput<typeof ExternalWebhookSchema>",
    );
    expect(webhookRoute.responseTypeText).toBe(
      "StandardSchemaInferOutput<typeof ExternalWebhookSchema>",
    );

    // Emit both bunest.d.ts and standalone frontend client types
    const dts = emitBunestDeclaration(scan, {
      cwd,
      outputPath: join(cwd, ".bunest/types/bunest.d.ts"),
    });
    expect(validateGeneratedDeclaration(dts)).toBe(true);
    expect(dts).toContain('"POST /users"');
    expect(dts).toContain("email: string");

    const clientTs = emitClientRouteTypes(scan, {
      cwd,
      outputPath: join(cwd, "apps/web/src/routes.ts"),
    });
    expect(validateGeneratedDeclaration(clientTs)).toBe(true);
    expect(clientTs).not.toContain("@bunest/core");
    expect(clientTs).toContain("export interface AppRoutes");
    expect(clientTs).toContain("email: string");

    // Also test portable `StandardSchemaInferInput/Output<typeof Schema>` fallback when schema has no DSL or explicit type args
    const portableDir = createTempProject("bunest-typegen-portable-std", {
      "src/decorators.ts": DECORATORS_STUB,
      "src/ext.schema.ts": `
        export const CreateWidgetSchema = makeExternalValidator();
        export const WidgetOutSchema = makeExternalValidator();
        declare function makeExternalValidator(): { readonly "~standard": { readonly version: 1; readonly types?: { readonly input: { title: string }; readonly output: { id: string; title: string } } } };
      `,
      "src/widgets.controller.ts": `
        import { Body, Controller, Post, UseStandardSchema } from "./decorators";
        import { CreateWidgetSchema, WidgetOutSchema } from "./ext.schema";
        @Controller("widgets")
        export class WidgetsController {
          @Post()
          @UseStandardSchema(WidgetOutSchema)
          create(@Body(CreateWidgetSchema) body: unknown) {
            return body;
          }
        }
      `,
    });
    const genRes = await generateBunestTypes({
      cwd: portableDir,
      sourceRoot: "src",
      clientTypes: "apps/web/src/routes.ts",
    });
    const portableClient = await Bun.file(genRes.clientTypes!.outputPath).text();
    expect(validateGeneratedDeclaration(portableClient)).toBe(true);
    expect(portableClient).not.toContain("@bunest/core");
    expect(portableClient).toContain("type StandardSchemaInferInput<T>");
    expect(portableClient).toContain("type StandardSchemaInferOutput<T>");
    expect(portableClient).toContain("StandardSchemaInferInput<typeof CreateWidgetSchema>");
    expect(portableClient).toContain("StandardSchemaInferOutput<typeof WidgetOutSchema>");
  });

  it("wires typegen.clientTypes from bunest.json and CLI flags into runDevServer() -> startTypegenWatcher()", async () => {
    const cwd = createTempProject("bunest-dev-client-types", {
      "bunest.json": JSON.stringify(
        {
          sourceRoot: "src",
          typegen: {
            enabled: true,
            clientTypes: "apps/web/src/generated-routes.ts",
          },
        },
        null,
        2,
      ),
      "src/decorators.ts": DECORATORS_STUB,
      "src/items.controller.ts": `
        import { Controller, Get } from "./decorators";
        @Controller("items")
        export class ItemsController {
          @Get()
          list(): Array<{ id: string }> { return []; }
        }
      `,
      "src/main.ts": `export const booted = true;\n`,
    });

    // CLI parser accepts `--client-types` for `dev`
    const parsedDev = parseCliArgs(["dev", "--client-types", "web/routes.ts"]);
    expect(parsedDev.command).toBe("dev");
    expect(parsedDev.flags["client-types"]).toBe("web/routes.ts");

    // 1) Picks up `typegen.clientTypes` automatically from bunest.json
    const cap = createCapturedIO(cwd);
    const devRes = await runDevServer(
      {
        cwd,
        entry: "src/main.ts",
        silent: true,
        spawn: async () => ({ exitCode: 0 }),
      },
      cap.io,
    );

    expect(devRes.exitCode).toBe(0);
    expect(devRes.typegen?.clientTypes).toBeDefined();
    expect(devRes.typegen?.clientTypes?.relativePath).toBe(
      "apps/web/src/generated-routes.ts",
    );
    const clientFile = join(cwd, "apps/web/src/generated-routes.ts");
    expect(await fileExists(clientFile)).toBe(true);
    const clientCode = await Bun.file(clientFile).text();
    expect(clientCode).toContain('"GET /items"');
    expect(clientCode).not.toContain("@bunest/core");

    // 2) Explicit `options.clientTypes` overrides bunest.json
    const overrideRes = await runDevServer(
      {
        cwd,
        entry: "src/main.ts",
        clientTypes: "apps/mobile/src/api.ts",
        silent: true,
        spawn: async () => ({ exitCode: 0 }),
      },
      cap.io,
    );
    expect(overrideRes.exitCode).toBe(0);
    expect(overrideRes.typegen?.clientTypes?.relativePath).toBe(
      "apps/mobile/src/api.ts",
    );
    expect(await fileExists(join(cwd, "apps/mobile/src/api.ts"))).toBe(true);
  });
});

// ============================================================================
// 4. Metadata Plugin Union & Generic Preservation for Swagger
// ============================================================================
describe("Metadata Plugin Union & Generic Preservation for Swagger", () => {
  it("preserves non-literal class unions and generic type arguments in transformDtoMetadataSource & transformControllerMetadataSource while falling back safely for erased interfaces", () => {
    const dtoSource = `
      export class DogDto {
        barkVolume!: number;
      }
      export class CatDto {
        livesLeft!: number;
      }
      export class UserDto {
        id!: string;
        email!: string;
      }
      export class OrderDto {
        orderId!: string;
      }
      export class MetaDto {
        requestId!: string;
      }
      export interface ErasedA { a: string; }
      export interface ErasedB { b: number; }

      export class ApiResponse<T> {
        statusCode!: number;
        data!: T;
      }

      export class PaginatedResponse<T> {
        total!: number;
        items!: T[];
      }

      export class Envelope<TData, TMeta> {
        payload!: TData;
        meta!: TMeta;
      }

      export class PetOwnerDto {
        pet!: DogDto | CatDto;
        backupPet?: DogDto | CatDto | null;
        pets!: (DogDto | CatDto)[];
        tagOrPet!: string | DogDto;
        wrappedUser!: ApiResponse<UserDto>;
        ordersPage!: PaginatedResponse<OrderDto[]>;
        wrappedUnion!: ApiResponse<DogDto | CatDto>;
        envelope!: Envelope<UserDto, MetaDto>;
        erasedUnion!: ErasedA | ErasedB;
      }
    `;

    const dtoRes = transformDtoMetadataSource(dtoSource, "pet-owner.dto.ts", {
      swagger: true,
      graphql: true,
    });
    expect(dtoRes.modified).toBe(true);

    const apiResp = dtoRes.classes.find((c) => c.name === "ApiResponse")!;
    expect(apiResp.typeParameters).toEqual(["T"]);
    expect(apiResp.properties.find((p) => p.name === "data")?.genericParamRef).toBe("T");

    const owner = dtoRes.classes.find((c) => c.name === "PetOwnerDto")!;
    const byProp = new Map(owner.properties.map((p) => [p.name, p]));

    // Non-literal unions are preserved via __union(...) instead of collapsing to Object!
    expect(byProp.get("pet")?.typeExpr).toBe("() => __union([() => DogDto, () => CatDto])");
    expect(byProp.get("pet")?.unionTypeExprs).toEqual(["() => DogDto", "() => CatDto"]);

    expect(byProp.get("backupPet")?.nullable).toBe(true);
    expect(byProp.get("backupPet")?.required).toBe(false);
    expect(byProp.get("backupPet")?.typeExpr).toBe("() => __union([() => DogDto, () => CatDto])");

    expect(byProp.get("pets")?.isArray).toBe(true);
    expect(byProp.get("pets")?.typeExpr).toBe("() => __union([() => DogDto, () => CatDto])");

    expect(byProp.get("tagOrPet")?.typeExpr).toBe("() => __union([() => String, () => DogDto])");

    // Generic wrappers preserve their type arguments via __generic(...)!
    expect(byProp.get("wrappedUser")?.typeExpr).toBe("() => __generic(ApiResponse, [() => UserDto])");
    expect(byProp.get("wrappedUser")?.genericWrapperExpr).toBe("ApiResponse");
    expect([...(byProp.get("wrappedUser")?.genericTypeArgs ?? [])]).toEqual([
      { rawType: "UserDto", typeExpr: "() => UserDto", isArray: false },
    ]);

    expect(byProp.get("ordersPage")?.typeExpr).toBe(
      "() => __generic(PaginatedResponse, [() => [OrderDto]])",
    );
    expect([...(byProp.get("ordersPage")?.genericTypeArgs ?? [])]).toEqual([
      { rawType: "OrderDto[]", typeExpr: "() => [OrderDto]", isArray: true },
    ]);

    expect(byProp.get("wrappedUnion")?.typeExpr).toBe(
      "() => __generic(ApiResponse, [() => __union([() => DogDto, () => CatDto])])",
    );

    expect(byProp.get("envelope")?.typeExpr).toBe(
      "() => __generic(Envelope, [() => UserDto, () => MetaDto])",
    );

    // Erased interface union safely falls back to Object (no runtime ReferenceError)
    expect(byProp.get("erasedUnion")?.typeExpr).toBe("Object");
    expect(dtoRes.code).not.toContain("() => ErasedA");
    expect(dtoRes.code).not.toContain("() => ErasedB");
    expect(dtoRes.code).toContain('Symbol.for("bunest:swagger:generic_type_params")');
    expect(dtoRes.code).toContain('Symbol.for("bunest:swagger:union_type_meta")');
    expect(dtoRes.code).toContain('Symbol.for("bunest:swagger:generic_type_meta")');

    // Controller return types preserve unions & generics too!
    const ctrlSource = `
      import { DogDto, CatDto, ApiResponse, PaginatedResponse, UserDto, OrderDto } from "./pet-owner.dto";
      @Controller("pets")
      export class PetsController {
        @Get("one")
        async getPet(): Promise<DogDto | CatDto> {
          return new DogDto();
        }
        @Get("user")
        async getUser(): Promise<ApiResponse<UserDto>> {
          return new ApiResponse();
        }
        @Get("orders")
        async getOrders(): Promise<PaginatedResponse<OrderDto[]>> {
          return new PaginatedResponse();
        }
      }
    `;
    const ctrlRes = transformControllerMetadataSource(
      ctrlSource,
      "pets.controller.ts",
      { swagger: true },
    );
    expect(ctrlRes.modified).toBe(true);
    const methods = new Map(
      ctrlRes.controllers[0]!.methods.map((m) => [m.name, m]),
    );
    expect(methods.get("getPet")?.returnTypeExpr).toBe(
      "() => __union([() => DogDto, () => CatDto])",
    );
    expect(methods.get("getUser")?.returnTypeExpr).toBe(
      "() => __generic(ApiResponse, [() => UserDto])",
    );
    expect(methods.get("getOrders")?.returnTypeExpr).toBe(
      "() => __generic(PaginatedResponse, [() => [OrderDto]])",
    );
  });

  it("integrates end-to-end with real Bun.build({ plugins: [bunestMetadataPlugin()] }), @bunest/swagger SchemaExplorer, and static generateMetadataFile()", async () => {
    const tmpDir = createTempProject("bunest-meta-union-generic-e2e", {
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
          },
        },
        null,
        2,
      ),
      "src/models.dto.ts": `
        export class DogDto {
          barkVolume!: number;
        }
        export class CatDto {
          livesLeft!: number;
        }
        export class UserDto {
          id!: string;
          email!: string;
        }
        export class OrderDto {
          orderId!: string;
          total!: number;
        }
        export class ApiResponse<T> {
          statusCode!: number;
          data!: T;
        }
        export class PaginatedResponse<T> {
          total!: number;
          items!: T[];
        }
        export class DashboardDto {
          featuredPet!: DogDto | CatDto;
          userEnvelope!: ApiResponse<UserDto>;
          ordersPage!: PaginatedResponse<OrderDto[]>;
        }
      `,
      "src/dashboard.controller.ts": `
        import { DogDto, CatDto, ApiResponse, UserDto } from "./models.dto";
        function Controller(_p?: string): ClassDecorator { return () => {}; }
        function Get(_p?: string): MethodDecorator { return () => {}; }

        @Controller("dashboard")
        export class DashboardController {
          @Get("pet")
          async getPet(): Promise<DogDto | CatDto> {
            return new DogDto();
          }

          @Get("user")
          async getUser(): Promise<ApiResponse<UserDto>> {
            return new ApiResponse();
          }
        }
      `,
      "src/index.ts": `
        export * from "./models.dto";
        export * from "./dashboard.controller";
      `,
    });

    // 1) Real Bun.build with bunestMetadataPlugin() -> run REAL @bunest/swagger SchemaExplorer!
    const buildRes = await Bun.build({
      entrypoints: [join(tmpDir, "src/index.ts")],
      outdir: join(tmpDir, "dist"),
      target: "bun",
      format: "esm",
      plugins: [bunestMetadataPlugin({ swagger: true })],
    });
    expect(buildRes.success).toBe(true);

    const built = (await import(
      `${Bun.pathToFileURL(buildRes.outputs[0]!.path).href}?t=${Date.now()}`
    )) as {
      DogDto: new (...args: any[]) => any;
      CatDto: new (...args: any[]) => any;
      UserDto: new (...args: any[]) => any;
      OrderDto: new (...args: any[]) => any;
      ApiResponse: new (...args: any[]) => any;
      PaginatedResponse: new (...args: any[]) => any;
      DashboardDto: new (...args: any[]) => any;
      DashboardController: new (...args: any[]) => any;
    };

    const explorer = new SchemaExplorer();
    const dashSchemaName = explorer.registerDtoSchema(built.DashboardDto);
    expect(dashSchemaName).toBe("DashboardDto");

    const schemas = explorer.getSchemas();
    expect(schemas.DogDto).toBeDefined();
    expect(schemas.CatDto).toBeDefined();
    expect(schemas.UserDto).toBeDefined();
    expect(schemas.OrderDto).toBeDefined();

    // featuredPet -> oneOf referencing DogDto & CatDto
    const dashSchema = schemas.DashboardDto as {
      properties: Record<string, any>;
    };
    expect(dashSchema.properties.featuredPet).toBeDefined();
    const featuredPetSchema = dashSchema.properties.featuredPet.$ref
      ? schemas[dashSchema.properties.featuredPet.$ref.split("/").pop()!]
      : dashSchema.properties.featuredPet;
    expect((featuredPetSchema as { oneOf?: unknown[] }).oneOf).toEqual([
      { $ref: "#/components/schemas/DogDto" },
      { $ref: "#/components/schemas/CatDto" },
    ]);

    // userEnvelope -> ApiResponse<UserDto> preserves `statusCode: number` AND `data: $ref UserDto`!
    const userEnvRef = dashSchema.properties.userEnvelope.$ref as string;
    expect(userEnvRef).toContain("ApiResponseOfUserDto");
    const userEnvSchema = schemas[userEnvRef.split("/").pop()!] as {
      properties: Record<string, any>;
    };
    expect(userEnvSchema.properties.statusCode).toMatchObject({ type: "number" });
    expect(userEnvSchema.properties.data).toEqual({
      $ref: "#/components/schemas/UserDto",
    });

    // ordersPage -> PaginatedResponse<OrderDto[]> preserves `total: number` AND `items: array of $ref OrderDto`!
    const ordersPageRef = dashSchema.properties.ordersPage.$ref as string;
    expect(ordersPageRef).toContain("PaginatedResponse");
    const ordersPageSchema = schemas[ordersPageRef.split("/").pop()!] as {
      properties: Record<string, any>;
    };
    expect(ordersPageSchema.properties.total).toMatchObject({ type: "number" });
    expect(ordersPageSchema.properties.items).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/OrderDto" },
    });

    // Controller @ApiResponse metadata resolves union & generic models too!
    const SWAGGER_API_RESPONSES = Symbol.for("bunest:swagger:api_responses");
    const getPetResponses = Reflect.getOwnMetadata(
      SWAGGER_API_RESPONSES,
      built.DashboardController.prototype.getPet,
    ) as Array<{ status?: number; type?: unknown }>;
    expect(getPetResponses).toHaveLength(1);
    const petModel =
      typeof getPetResponses[0]!.type === "function"
        ? (getPetResponses[0]!.type as () => Function)()
        : undefined;
    expect(petModel).toBeDefined();
    expect(
      (petModel as unknown as Record<symbol, unknown>)[
        Symbol.for("bunest:swagger:union_type_meta")
      ],
    ).toBeDefined();

    const getUserResponses = Reflect.getOwnMetadata(
      SWAGGER_API_RESPONSES,
      built.DashboardController.prototype.getUser,
    ) as Array<{ status?: number; type?: unknown }>;
    expect(getUserResponses).toHaveLength(1);
    const userModel =
      typeof getUserResponses[0]!.type === "function"
        ? (getUserResponses[0]!.type as () => Function)()
        : undefined;
    expect(userModel).toBeDefined();
    expect(
      (userModel as unknown as Record<symbol, unknown>)[
        Symbol.for("bunest:swagger:generic_type_meta")
      ],
    ).toBeDefined();

    // 2) Static generateMetadataFile() emits valid metadata.ts loadable at runtime with union + generic symbols
    const genMeta = await generateMetadataFile({
      rootDir: tmpDir,
      pathToSource: "src",
      outDir: "src",
      filename: "metadata.ts",
      esmCompatible: false,
    });
    expect(genMeta.modelsCount).toBeGreaterThanOrEqual(7);
    expect(genMeta.controllersCount).toBe(1);
    expect(genMeta.code).toContain("const __union =");
    expect(genMeta.code).toContain("const __generic =");

    const loadedMetaMod = (await import(
      `${Bun.pathToFileURL(genMeta.outputPath).href}?t=${Date.now()}`
    )) as { default: () => Promise<Record<string, any>> };
    const loadedMeta = await loadedMetaMod.default();
    const models = loadedMeta["@nestjs/swagger"].models as Array<
      [Promise<unknown>, Record<string, Record<string, { type?: () => Function }>>]
    >;
    const dashEntry = models.find(([, map]) => "DashboardDto" in map)![1].DashboardDto!;
    const resolvedUnionModel = dashEntry.featuredPet!.type!();
    const resolvedGenericModel = dashEntry.userEnvelope!.type!();
    expect(
      (resolvedUnionModel as unknown as Record<symbol, unknown>)[
        Symbol.for("bunest:swagger:union_type_meta")
      ],
    ).toBeDefined();
    expect(
      (resolvedGenericModel as unknown as Record<symbol, unknown>)[
        Symbol.for("bunest:swagger:generic_type_meta")
      ],
    ).toBeDefined();
  });
});
