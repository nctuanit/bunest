import { afterEach, describe, expect, it } from "bun:test";
import { ensureDir, join, removePath, statPath } from "@bunest/core";
import {
  BunestTypegenScanner,
  emitBunestDeclaration,
  generateBunestTypes,
  parseCliArgs,
  runCli,
  runDevServer,
  runStartCommand,
  runTypegenCommand,
  sanitizeTypeText,
  startTypegenWatcher,
  validateGeneratedDeclaration,
  type CliIO,
  type DevServerResult,
  type StartCommandResult,
  type TypegenCommandResult,
} from "../src";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(TMP_DIR, `${prefix}${crypto.randomUUID().slice(0, 8)}`);
  await ensureDir(dir);
  tempDirs.push(dir);
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

async function createSampleBunestApp(rootDir: string): Promise<void> {
  await ensureDir(join(rootDir, "src/cats"));
  await ensureDir(join(rootDir, "src/config"));
  await ensureDir(join(rootDir, "src/orders"));

  await Bun.write(
    join(rootDir, "tsconfig.json"),
    JSON.stringify(
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
        include: ["src/**/*.ts", ".bunest/types/**/*.d.ts"],
      },
      null,
      2,
    ),
  );

  await Bun.write(
    join(rootDir, ".env.example"),
    "PORT=3000\nDATABASE_URL=mongodb://localhost:27017/app\n# secret comment\nJWT_SECRET=changeme\n",
  );

  await Bun.write(
    join(rootDir, "src/decorators.stub.ts"),
    `export function Schema(_opts?: Record<string, unknown>): ClassDecorator { return () => {}; }
export function Prop(_opts?: unknown): PropertyDecorator { return () => {}; }
export function Controller(_prefix?: unknown): ClassDecorator { return () => {}; }
export function Get(_path?: string): MethodDecorator { return () => {}; }
export function Post(_path?: string): MethodDecorator { return () => {}; }
export function Param(_key?: string): ParameterDecorator { return () => {}; }
export function Query(_key?: string): ParameterDecorator { return () => {}; }
export function Body(): ParameterDecorator { return () => {}; }
export function OnEvent(_name: string | string[]): MethodDecorator { return () => {}; }
export function EmitEvent(_name: string): MethodDecorator { return () => {}; }
export function MessagePattern(_pattern: unknown): MethodDecorator { return () => {}; }
export function EventPattern(_pattern: unknown): MethodDecorator { return () => {}; }
export function Payload(): ParameterDecorator { return () => {}; }
export function Ctx(): ParameterDecorator { return () => {}; }
export function CommandHandler(_cmd: unknown): ClassDecorator { return () => {}; }
export function QueryHandler(_q: unknown): ClassDecorator { return () => {}; }
export function Module(_meta: unknown): ClassDecorator { return () => {}; }
export function registerAs<T>(ns: string, factory: () => T) { return factory; }
export const SchemaFactory = { createForClass: (_cls: unknown) => ({}) };
export const MongooseModule = {
  forRoot: (_uri: string, _opts?: Record<string, unknown>) => ({}),
  forFeature: (_models: unknown[], _conn?: string) => ({}),
};
`,
  );

  await Bun.write(
    join(rootDir, "src/cats/cat.schema.ts"),
    `import { Prop, Schema, SchemaFactory } from "../decorators.stub";

@Schema({ timestamps: true })
export class Cat {
  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  age!: number;
}

export const CatSchema = SchemaFactory.createForClass(Cat);
`,
  );

  await Bun.write(
    join(rootDir, "src/config/database.config.ts"),
    `import { registerAs } from "../decorators.stub";

export const databaseConfig = registerAs("database", () => ({
  host: "localhost",
  port: 5432,
  ssl: false,
}));
`,
  );

  await Bun.write(
    join(rootDir, "src/orders/orders.dto.ts"),
    `export class CreateOrderDto {
  sku!: string;
  quantity!: number;
}

export interface OrderResult {
  id: string;
  total: number;
}

export interface OrderCreatedPayload {
  orderId: string;
  amount: number;
}

export class PlaceOrderCommand {
  constructor(public readonly sku: string) {}
}

export class GetOrderQuery {
  constructor(public readonly id: string) {}
}
`,
  );

  await Bun.write(
    join(rootDir, "src/orders/orders.controller.ts"),
    `import {
  Body,
  CommandHandler,
  Controller,
  Ctx,
  EmitEvent,
  EventPattern,
  Get,
  MessagePattern,
  OnEvent,
  Param,
  Payload,
  Post,
  Query,
  QueryHandler,
} from "../decorators.stub";
import {
  CreateOrderDto,
  GetOrderQuery,
  PlaceOrderCommand,
  type OrderCreatedPayload,
  type OrderResult,
} from "./orders.dto";

@Controller("orders")
export class OrdersController {
  @Get(":id")
  async findOne(
    @Param("id") id: string,
    @Query("expand") expand?: boolean,
  ): Promise<OrderResult> {
    return { id, total: expand ? 10 : 0 };
  }

  @Post()
  @EmitEvent("order.placed")
  async create(@Body() dto: CreateOrderDto): Promise<OrderResult> {
    return { id: dto.sku, total: dto.quantity };
  }

  @OnEvent("order.created")
  handleOrderCreated(_payload: OrderCreatedPayload): void {}

  @MessagePattern("orders.calculate")
  async calculate(@Payload() dto: CreateOrderDto, @Ctx() _ctx: unknown): Promise<OrderResult> {
    return { id: dto.sku, total: dto.quantity * 100 };
  }

  @EventPattern("orders.archived")
  onArchived(@Payload() payload: OrderCreatedPayload): void {
    void payload;
  }
}

@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler {
  async execute(cmd: PlaceOrderCommand): Promise<OrderResult> {
    return { id: cmd.sku, total: 1 };
  }
}

@QueryHandler(GetOrderQuery)
export class GetOrderHandler {
  async execute(q: GetOrderQuery): Promise<OrderResult | null> {
    return { id: q.id, total: 1 };
  }
}
`,
  );

  await Bun.write(
    join(rootDir, "src/app.module.ts"),
    `import { Module, MongooseModule } from "./decorators.stub";
import { Cat, CatSchema } from "./cats/cat.schema";

export class PaymentGateway {
  charge(amount: number): boolean {
    return amount > 0;
  }
}

@Module({
  imports: [
    MongooseModule.forRoot("mongodb://localhost/app", { connectionName: "analytics" }),
    MongooseModule.forFeature([{ name: Cat.name, schema: CatSchema }], "analytics"),
  ],
  providers: [
    { provide: "PAYMENT_GATEWAY", useClass: PaymentGateway },
  ],
})
export class AppModule {}
`,
  );

  await Bun.write(
    join(rootDir, "src/main.ts"),
    `console.log("bunest app started");\n`,
  );
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("@bunest/cli ts-morph Global Typegen & Dev Mode Integration", () => {
  it("scans all 7 Bunest registries via ts-morph and emits deterministic .bunest/types/bunest.d.ts", async () => {
    const workdir = await makeTempDir("bunest-typegen-full-");
    await createSampleBunestApp(workdir);

    const result = await generateBunestTypes({ cwd: workdir });

    expect(result.changed).toBe(true);
    expect(result.upToDate).toBe(false);
    expect(result.relativePath).toBe(".bunest/types/bunest.d.ts");
    expect(await fileExists(result.outputPath)).toBe(true);

    expect(result.summary).toEqual({
      models: 1,
      connections: 1,
      configNamespaces: 1,
      envKeys: 3,
      events: 2,
      messagePatterns: 1,
      eventPatterns: 1,
      routes: 2,
      commands: 1,
      queries: 1,
      tokens: 1,
      classMacros: 0,
    });

    const dts = await Bun.file(result.outputPath).text();
    // Imports use `import type` (verbatimModuleSyntax safe)
    expect(dts).toContain('import type { ConfigType } from "@bunest/core/config";');
    expect(dts).toContain(
      'import type { Cat } from "../../src/cats/cat.schema";',
    );
    expect(dts).toContain(
      'import type { databaseConfig } from "../../src/config/database.config";',
    );
    expect(dts).toContain(
      'import type { PaymentGateway } from "../../src/app.module";',
    );

    // Module augmentations
    expect(dts).toContain('declare module "@bunest/mongoose"');
    expect(dts).toContain("Cat: Cat;");
    expect(dts).toContain("analytics: true;");

    expect(dts).toContain('declare module "@bunest/core/config"');
    expect(dts).toContain("PORT: string;");
    expect(dts).toContain("DATABASE_URL: string;");
    expect(dts).toContain("database: ConfigType<typeof databaseConfig>;");

    expect(dts).toContain('declare module "@bunest/messaging/events"');
    expect(dts).toContain('"order.created": OrderCreatedPayload;');
    expect(dts).toContain('"order.placed": OrderResult;');

    expect(dts).toContain('declare module "@bunest/microservices"');
    expect(dts).toContain(
      '"orders.calculate": { readonly request: CreateOrderDto; readonly response: OrderResult };',
    );
    expect(dts).toContain('"orders.archived": OrderCreatedPayload;');

    expect(dts).toContain('declare module "@bunest/core"');
    expect(dts).toContain('"GET /orders/:id"');
    expect(dts).toContain("readonly params: { id: string };");
    expect(dts).toContain("readonly query: { expand?: boolean };");
    expect(dts).toContain('"POST /orders"');
    expect(dts).toContain("readonly body: CreateOrderDto;");
    expect(dts).toContain('"PAYMENT_GATEWAY": PaymentGateway;');

    expect(dts).toContain('declare module "@bunest/messaging/cqrs"');
    expect(dts).toContain(
      "PlaceOrderCommand: { readonly command: PlaceOrderCommand; readonly result: OrderResult };",
    );
    expect(dts).toContain(
      "GetOrderQuery: { readonly query: GetOrderQuery; readonly result: OrderResult | null };",
    );

    // Global convenience namespace
    expect(dts).toContain("declare global {");
    expect(dts).toContain("namespace Bunest {");
    expect(dts).toContain("export {};");

    // Running a second time is a no-op (changed: false, upToDate: true)
    const second = await generateBunestTypes({ cwd: workdir });
    expect(second.changed).toBe(false);
    expect(second.upToDate).toBe(true);
  });

  it("supports CLI `bunest typegen`, `--check`, `--dry-run`, and skips unused module augmentations", async () => {
    const workdir = await makeTempDir("bunest-typegen-cli-");
    await ensureDir(join(workdir, "src"));
    await Bun.write(
      join(workdir, "src/health.controller.ts"),
      `function Controller(_p?: string): ClassDecorator { return () => {}; }
function Get(_p?: string): MethodDecorator { return () => {}; }
@Controller("health")
export class HealthController {
  @Get()
  check(): { ok: boolean } { return { ok: true }; }
}
`,
    );

    const parsed = parseCliArgs(["typegen", "--check", "-o", ".bunest/gen"]);
    expect(parsed.command).toBe("typegen");
    expect(parsed.flags.check).toBe(true);
    expect(parsed.flags.outdir).toBe(".bunest/gen");

    // --check fails with exitCode 1 before file exists
    const staleCap = createCapturedIO(workdir);
    const staleRes = await runCli(["typegen", "--check"], staleCap.io);
    expect(staleRes.exitCode).toBe(1);
    expect(staleCap.stderr.join("\n")).toContain("Out-of-date");

    // --dry-run does not write to disk
    const dryCap = createCapturedIO(workdir);
    const dryRes = await runCli(["tg", "--dry-run"], dryCap.io);
    expect(dryRes.exitCode).toBe(0);
    expect(await fileExists(join(workdir, ".bunest/types/bunest.d.ts"))).toBe(
      false,
    );

    // Real run writes file and ONLY emits @bunest/common (no phantom @bunest/mongoose!)
    const genCap = createCapturedIO(workdir);
    const genRes = await runCli(["typegen"], genCap.io);
    expect(genRes.exitCode).toBe(0);
    const out = genRes.output as TypegenCommandResult;
    expect(out.result.changed).toBe(true);
    expect(out.result.content).toContain('declare module "@bunest/core"');
    expect(out.result.content).not.toContain(
      'declare module "@bunest/mongoose"',
    );
    expect(out.result.content).not.toContain('declare module "@bunest/core/config"');

    // --check now passes with exitCode 0
    const okCap = createCapturedIO(workdir);
    const okRes = await runCli(["typegen", "--check"], okCap.io);
    expect(okRes.exitCode).toBe(0);
    expect(okCap.stdout.join("\n")).toContain("Up-to-date");
  });

  it("integrates live ts-morph typegen automatically into `bunest dev` and `bunest start --watch` (with `--no-typegen` opt-out)", async () => {
    const workdir = await makeTempDir("bunest-typegen-dev-");
    await createSampleBunestApp(workdir);

    // 1. `runDevServer` runs initial typegen before spawning `bun --watch` and cleans up watcher on exit
    const devCap = createCapturedIO(workdir);
    let dtsExistedBeforeSpawn = false;
    const devRes: DevServerResult = await runDevServer(
      {
        cwd: workdir,
        entry: "src/main.ts",
        port: 4000,
        spawn: async () => {
          dtsExistedBeforeSpawn = await fileExists(
            join(workdir, ".bunest/types/bunest.d.ts"),
          );
          return { exitCode: 0 };
        },
      },
      devCap.io,
    );
    expect(devRes.exitCode).toBe(0);
    expect(dtsExistedBeforeSpawn).toBe(true);
    expect(devRes.typegen?.summary.models).toBe(1);
    expect(devRes.typegen?.summary.routes).toBe(2);
    expect(devCap.stdout.join("\n")).toContain("[typegen]");

    // 2. `runDevServer` respects `typegen: false` (--no-typegen)
    const optOutDir = await makeTempDir("bunest-typegen-dev-off-");
    await ensureDir(join(optOutDir, "src"));
    await Bun.write(join(optOutDir, "src/main.ts"), `console.log("ok");\n`);
    const devOffRes = await runDevServer({
      cwd: optOutDir,
      typegen: false,
      spawn: async () => ({ exitCode: 0 }),
    });
    expect(devOffRes.typegen).toBeUndefined();
    expect(await fileExists(join(optOutDir, ".bunest/types/bunest.d.ts"))).toBe(
      false,
    );

    // 3. `runStartCommand({ watch: true })` automatically enables live typegen too
    const startDir = await makeTempDir("bunest-typegen-start-");
    await createSampleBunestApp(startDir);
    const startRes: StartCommandResult = await runStartCommand({
      cwd: startDir,
      watch: true,
      silent: true,
      spawn: async () => ({ exitCode: 0 }),
    });
    expect(startRes.exitCode).toBe(0);
    expect(startRes.typegen?.summary.models).toBe(1);
    expect(await fileExists(join(startDir, ".bunest/types/bunest.d.ts"))).toBe(
      true,
    );

    // 4. Incremental refresh & live watcher updates when new schema/controller is added
    const watchDir = await makeTempDir("bunest-typegen-watch-");
    await createSampleBunestApp(watchDir);
    const watcher = await startTypegenWatcher({
      cwd: watchDir,
      debounceMs: 30,
      silent: true,
    });
    try {
      expect(watcher.initialResult.summary.models).toBe(1);
      const dogPath = join(watchDir, "src/cats/dog.schema.ts");
      await Bun.write(
        dogPath,
        `import { Prop, Schema } from "../decorators.stub";
@Schema()
export class Dog {
  @Prop()
  breed!: string;
}
`,
      );
      const updated = await watcher.regenerate([dogPath]);
      expect(updated.changed).toBe(true);
      expect(updated.summary.models).toBe(2);
      expect(updated.content).toContain("Dog: Dog;");
    } finally {
      await watcher.close();
    }

    // 5. Watch command honors AbortSignal cleanly
    const ac = new AbortController();
    ac.abort();
    const watchCmdRes = await runTypegenCommand({
      cwd: watchDir,
      watch: true,
      silent: true,
      signal: ac.signal,
    });
    expect(watchCmdRes.exitCode).toBe(0);
    expect(watchCmdRes.watch).toBe(true);

    // 6. Direct scanner incremental refresh test
    const scanner = new BunestTypegenScanner({
      cwd: watchDir,
      sourceRoot: "src",
    });
    expect(scanner.scan().models.map((m) => m.name)).toEqual(["Cat", "Dog"]);
  });

  it("sanitizes partial mid-keystroke types, validates generated .d.ts, and supports in-memory .env overrides", async () => {
    // Valid complex TypeScript types stay intact
    expect(sanitizeTypeText("string")).toBe("string");
    expect(sanitizeTypeText("Array<{ id: number; name: string }>")).toBe(
      "Array<{ id: number; name: string }>",
    );
    expect(sanitizeTypeText("(current: number) => Promise<string>")).toBe(
      "(current: number) => Promise<string>",
    );
    expect(sanitizeTypeText('Pick<User, "id" | "email">')).toBe(
      'Pick<User, "id" | "email">',
    );
    expect(sanitizeTypeText("`user.${string}`")).toBe("`user.${string}`");

    // Malformed / half-typed fragments fall back safely to "unknown"
    expect(sanitizeTypeText("}")).toBe("unknown");
    expect(sanitizeTypeText("string |")).toBe("unknown");
    expect(sanitizeTypeText("Array<")).toBe("unknown");
    expect(sanitizeTypeText(": string")).toBe("unknown");
    expect(sanitizeTypeText("")).toBe("unknown");

    // Declaration validator catches malformed empty type annotations
    expect(
      validateGeneratedDeclaration(
        'declare module "./a" {\n  interface Foo { getId(): number; }\n}\nexport {};\n',
      ),
    ).toBe(true);
    expect(
      validateGeneratedDeclaration(
        'declare module "./a" {\n  interface Foo { getPhone(): }; }\n}\nexport {};\n',
      ),
    ).toBe(false);

    // Scanner handles partial field edits + unsaved in-memory .env buffer cleanly
    const dir = await makeTempDir("bunest-live-env-");
    const entityPath = join(dir, "src/user.entity.ts");
    const envPath = join(dir, ".env");
    await Bun.write(envPath, "PORT=3000\n");
    await Bun.write(
      entityPath,
      `@Data()
export class UserEntity {
  id!: number;
  email!: string;
}
`,
    );

    const scanner = new BunestTypegenScanner({ cwd: dir, sourceRoot: "src" });

    // Simulate half-typed field `phone:` without saving to disk
    scanner
      .getProject()
      .getSourceFile(entityPath)!
      .replaceWithText(`@Data()
export class UserEntity {
  id!: number;
  email!: string;
  phone:
}
`);
    scanner.updateEnvFileContent(envPath, "PORT=3000\nSTRIPE_SECRET=sk_live_1\n");

    const scan = scanner.scan();
    expect(scan.envKeys.map((e) => e.key)).toContain("STRIPE_SECRET");
    const dts = emitBunestDeclaration(scan, {
      cwd: dir,
      outputPath: join(dir, ".bunest/types/bunest.d.ts"),
    });
    expect(validateGeneratedDeclaration(dts)).toBe(true);
    expect(dts).toContain("getPhone(): unknown;");
    expect(dts).toContain("STRIPE_SECRET: string;");
    expect(dts).not.toContain("getPhone(): };");

    // Clearing in-memory .env override reverts back to disk .env
    scanner.clearEnvFileOverride(envPath);
    const revertedScan = scanner.scan();
    expect(revertedScan.envKeys.map((e) => e.key)).toEqual(["PORT"]);
  });

  it("emits typed id: Key, createdAt, updatedAt, deletedAt declarations for @BaseEntity<Key>() and integrates with @Data/@Builder", async () => {
    const dir = await makeTempDir("bunest-base-entity-");
    await Bun.write(
      join(dir, "src/post.entity.ts"),
      `function BaseEntity<Key = number>(_opts?: any): ClassDecorator { return () => {}; }
function Column(): PropertyDecorator { return () => {}; }
function Data(): ClassDecorator { return () => {}; }
function Builder(): ClassDecorator { return () => {}; }
function FieldNameConstants(): ClassDecorator { return () => {}; }

@BaseEntity<string>({ idStrategy: "uuid" })
@Data()
@Builder()
@FieldNameConstants()
export class PostEntity {
  @Column()
  title!: string;
}

@BaseEntity<bigint>({ tableName: "audit_logs", deletedAt: false })
export class AuditLogEntity {
  @Column()
  action!: string;
}
`,
    );

    const res = await generateBunestTypes({
      cwd: dir,
      sourceRoot: "src",
      loadBunestConfig: false,
      silent: true,
    });

    expect(res.content).toContain("interface PostEntity {");
    expect(res.content).toContain("    id: string;");
    expect(res.content).toContain("    createdAt: Date;");
    expect(res.content).toContain("    updatedAt: Date;");
    expect(res.content).toContain("    deletedAt?: Date | null;");
    expect(res.content).toContain("    getId(): string;");
    expect(res.content).toContain("    getCreatedAt(): Date;");
    expect(res.content).toContain("    getUpdatedAt(): Date;");
    expect(res.content).toContain("    getDeletedAt(): Date | null | undefined;");
    expect(res.content).toContain(
      'export const Fields: { readonly id: "id"; readonly title: "title"; readonly createdAt: "createdAt"; readonly updatedAt: "updatedAt"; readonly deletedAt: "deletedAt" };',
    );
    // `of(props)` makes auto-generated base fields optional while keeping `title` required
    expect(res.content).toContain(
      "export function of(props: { id?: string; title: string; createdAt?: Date; updatedAt?: Date; deletedAt?: Date | null }): PostEntity;",
    );

    // Second entity: bigint Key + deletedAt: false
    expect(res.content).toContain("interface AuditLogEntity {");
    const auditStart = res.content.indexOf("interface AuditLogEntity {");
    const auditSection = res.content.slice(
      auditStart,
      res.content.indexOf("  }", auditStart) + 3,
    );
    expect(auditSection).toContain("    id: bigint;");
    expect(auditSection).toContain("    createdAt: Date;");
    expect(auditSection).toContain("    updatedAt: Date;");
    expect(auditSection).not.toContain("deletedAt");
  });
});
