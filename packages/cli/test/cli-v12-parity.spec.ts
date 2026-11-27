import { afterEach, describe, expect, it } from "bun:test";
import { ensureDir, join, removePath, statPath } from "@bunest/core";
import {
  AVAILABLE_BUILDERS,
  addLibrary,
  buildProject,
  bunestMetadataPlugin,
  createProject,
  deployProject,
  generateMetadataFile,
  generateSchematic,
  loadCliConfiguration,
  parseCliArgs,
  resolveProjectConfiguration,
  runCli,
  runStartCommand,
  transformControllerMetadataSource,
  transformDtoMetadataSource,
  upgradeProject,
  type CliIO,
  type GenerateSchematicResult,
  type SchematicType,
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

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("@bunest/cli v12 Parity — Commands, Schematics, Config Loader & Metadata Plugin", () => {
  it("supports start, add, upgrade/update, and deploy commands with full flags", async () => {
    const workdir = await makeTempDir("bunest-cli-cmds-");
    const entryPath = join(workdir, "src/server.ts");
    await ensureDir(join(workdir, "src"));
    await Bun.write(entryPath, `console.log("boot");\n`);
    await Bun.write(
      join(workdir, "package.json"),
      JSON.stringify(
        {
          name: "cmd-test",
          dependencies: {
            "@bunest/core": "^0.1.0",
            "@bunest/swagger": "^0.1.0",
          },
          devDependencies: {
            "@bunest/testing": "^0.1.0",
          },
        },
        null,
        2,
      ),
    );

    // 1. start command with --watch, --debug, repeatable --env-file, --entryFile, --preserveWatchOutput
    const parsedStart = parseCliArgs([
      "start",
      "-w",
      "-d",
      "0.0.0.0:9229",
      "--env-file",
      ".env",
      "--env-file",
      ".env.local",
      "--entryFile",
      "server",
      "--preserveWatchOutput",
      "--silent",
    ]);
    expect(parsedStart.command).toBe("start");
    expect(parsedStart.flags.watch).toBe(true);
    expect(parsedStart.flags.debug).toBe("0.0.0.0:9229");
    expect(parsedStart.flags["env-file"]).toEqual([".env", ".env.local"]);

    const startCalls: Array<{
      cmd: string[];
      env?: Record<string, string | undefined>;
    }> = [];
    const startRes = await runStartCommand({
      cwd: workdir,
      entryFile: "server",
      watch: true,
      debug: "9229",
      envFile: [".env", ".env.local"],
      preserveWatchOutput: true,
      silent: true,
      spawn: async (cmd, opts) => {
        startCalls.push({ cmd, env: opts.env });
        return { exitCode: 0 };
      },
    });
    expect(startRes.exitCode).toBe(0);
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]?.cmd).toContain("--watch");
    expect(startCalls[0]?.cmd).toContain("--inspect=9229");
    expect(startCalls[0]?.cmd.filter((a) => a === "--env-file")).toHaveLength(
      2,
    );
    expect(startCalls[0]?.env?.BUNEST_PRESERVE_WATCH_OUTPUT).toBe("1");

    // 2. add command (--dry-run + mocked spawn + invalid library rejection)
    const addDryCap = createCapturedIO(workdir);
    const addDryRes = await runCli(
      ["add", "@bunest/swagger", "-d"],
      addDryCap.io,
    );
    expect(addDryRes.exitCode).toBe(0);
    expect(addDryCap.stdout.join("\n")).toContain("bun add @bunest/swagger");

    const addCalls: string[][] = [];
    const addRes = await addLibrary({
      library: "@bunest/orm",
      cwd: workdir,
      spawn: async (cmd) => {
        addCalls.push(cmd);
        return { exitCode: 0 };
      },
    });
    expect(addRes.installed).toBe(true);
    expect(addCalls[0]?.slice(1)).toEqual(["add", "@bunest/orm"]);

    await expect(
      addLibrary({ library: "../evil;rm -rf", cwd: workdir }),
    ).rejects.toThrow(/Invalid library specifier/);

    // 3. upgrade & alias update commands
    const upgCap = createCapturedIO(workdir);
    const upgRes = await runCli(
      ["update", "--dry-run", "-t", "next"],
      upgCap.io,
    );
    expect(upgRes.exitCode).toBe(0);
    expect(upgCap.stdout.join("\n")).toContain("@bunest/core@next");
    expect(upgCap.stdout.join("\n")).toContain("@bunest/swagger@next");

    const upgCalls: string[][] = [];
    const upgReal = await upgradeProject({
      cwd: workdir,
      spawn: async (cmd) => {
        upgCalls.push(cmd);
        return { exitCode: 0 };
      },
    });
    expect(upgReal.upgraded).toBe(true);
    expect(upgReal.packages).toEqual([
      "@bunest/core",
      "@bunest/swagger",
      "@bunest/testing",
    ]);
    expect(upgCalls[0]?.slice(1)).toEqual([
      "update",
      "@bunest/core",
      "@bunest/swagger",
      "@bunest/testing",
    ]);

    // 4. deploy command (dry-run + custom command from bunest.json + compile)
    const deployDryCap = createCapturedIO(workdir);
    const deployDryRes = await runCli(
      ["deploy", "--compile", "-d"],
      deployDryCap.io,
    );
    expect(deployDryRes.exitCode).toBe(0);
    expect(deployDryCap.stdout.join("\n")).toContain("mode=compile");

    await Bun.write(
      join(workdir, "bunest.json"),
      JSON.stringify({ deploy: { command: ["echo", "deployed"] } }),
    );
    const deployCalls: string[][] = [];
    const deployCustom = await deployProject({
      cwd: workdir,
      spawn: async (cmd) => {
        deployCalls.push(cmd);
        return { exitCode: 0 };
      },
    });
    expect(deployCustom.success).toBe(true);
    expect(deployCustom.target).toBe("custom");
    expect(deployCalls[0]).toEqual(["echo", "deployed"]);
  });

  it("supports new flags on build (--deleteOutDir, --compile, --silent), new (--no-strict, --skip-git, --package-manager), and generate (--spec-file-suffix, --project, --sourceRoot)", async () => {
    const workdir = await makeTempDir("bunest-cli-flags-");

    // 1. new --no-strict --no-skip-git --package-manager pnpm
    const newSpawns: string[][] = [];
    const created = await createProject({
      projectName: "custom-pm-app",
      cwd: workdir,
      strict: false,
      skipGit: false,
      skipInstall: false,
      packageManager: "pnpm",
      spawn: async (cmd) => {
        newSpawns.push(cmd);
        return { exitCode: 0 };
      },
    });
    expect(created.gitInitialized).toBe(true);
    expect(created.installed).toBe(true);
    expect(newSpawns).toEqual([
      ["git", "init"],
      ["pnpm", "install"],
    ]);
    const tsconfig = (await Bun.file(
      join(workdir, "custom-pm-app/tsconfig.json"),
    ).json()) as { compilerOptions: { strict: boolean } };
    expect(tsconfig.compilerOptions.strict).toBe(false);

    // 2. build --deleteOutDir --silent & --compile
    await ensureDir(join(workdir, "app/src"));
    await ensureDir(join(workdir, "app/dist"));
    await Bun.write(join(workdir, "app/dist/stale.txt"), "old");
    await Bun.write(join(workdir, "app/src/main.ts"), `export const x = 1;\n`);

    const cap = createCapturedIO(join(workdir, "app"));
    const buildRes = await buildProject(
      {
        cwd: join(workdir, "app"),
        deleteOutDir: true,
        silent: true,
      },
      cap.io,
    );
    expect(buildRes.success).toBe(true);
    expect(cap.stdout).toHaveLength(0);
    expect(await fileExists(join(workdir, "app/dist/stale.txt"))).toBe(false);

    const compileSpawns: string[][] = [];
    const compileRes = await buildProject({
      cwd: join(workdir, "app"),
      compile: true,
      spawn: async (cmd) => {
        compileSpawns.push(cmd);
        return { exitCode: 0 };
      },
    });
    expect(compileRes.success).toBe(true);
    expect(compileSpawns[0]).toContain("--compile");
  });

  it("generates ALL 10 new schematics + interceptor 'itc' alias + --spec-file-suffix + bunest.json config loader", async () => {
    const workdir = await makeTempDir("bunest-cli-schematics-v12-");

    // Write bunest.json with projects and custom generateOptions
    await Bun.write(
      join(workdir, "bunest.json"),
      JSON.stringify(
        {
          sourceRoot: "src",
          entryFile: "main",
          projects: {
            billing: {
              type: "application",
              sourceRoot: "apps/billing/src",
              generateOptions: { specFileSuffix: "test" },
            },
          },
        },
        null,
        2,
      ),
    );

    const loaded = await loadCliConfiguration(workdir);
    expect(loaded.found).toBe(true);
    expect(AVAILABLE_BUILDERS).toContain("tsc");
    expect(
      resolveProjectConfiguration(loaded.config, "billing")?.sourceRoot,
    ).toBe("apps/billing/src");

    // Fallback to nest-cli.json in a separate dir
    const nestDir = await makeTempDir("bunest-cli-nest-cfg-");
    await Bun.write(
      join(nestDir, "nest-cli.json"),
      JSON.stringify({ sourceRoot: "server", entryFile: "index" }),
    );
    const loadedNest = await loadCliConfiguration(nestDir);
    expect(loadedNest.found).toBe(true);
    expect(loadedNest.config.sourceRoot).toBe("server");
    expect(loadedNest.config.entryFile).toBe("index");

    // Verify `itc` alias for interceptor AND --project + --spec-file-suffix
    const itcRes = await generateSchematic({
      schematic: "itc",
      name: "audit",
      project: "billing",
      cwd: workdir,
    });
    expect(itcRes.schematic).toBe("interceptor");
    expect(itcRes.files.map((f) => f.relativePath)).toEqual([
      "audit/audit.interceptor.ts",
      "audit/audit.interceptor.test.ts",
    ]);
    expect(
      await fileExists(
        join(workdir, "apps/billing/src/audit/audit.interceptor.test.ts"),
      ),
    ).toBe(true);

    // Verify all 10 new schematics via CLI
    const newSchematicCases: Array<{
      alias: string;
      expectedType: SchematicType;
      name: string;
      mustExist: string;
      expectedText: string;
    }> = [
      {
        alias: "cl",
        expectedType: "class",
        name: "money",
        mustExist: "src/money/money.ts",
        expectedText: "export class Money",
      },
      {
        alias: "itf",
        expectedType: "interface",
        name: "user-event",
        mustExist: "src/user-event/user-event.interface.ts",
        expectedText: "export interface UserEvent",
      },
      {
        alias: "d",
        expectedType: "decorator",
        name: "roles",
        mustExist: "src/roles/roles.decorator.ts",
        expectedText: "SetMetadata",
      },
      {
        alias: "pr",
        expectedType: "provider",
        name: "cache-client",
        mustExist: "src/cache-client/cache-client.ts",
        expectedText: "export class CacheClient",
      },
      {
        alias: "ga",
        expectedType: "gateway",
        name: "chat",
        mustExist: "src/chat/chat.gateway.ts",
        expectedText: "@WebSocketGateway()",
      },
      {
        alias: "r",
        expectedType: "resolver",
        name: "books",
        mustExist: "src/books/books.resolver.ts",
        expectedText: "@Resolver()",
      },
      {
        alias: "lib",
        expectedType: "library",
        name: "shared-auth",
        mustExist: "libs/shared-auth/src/shared-auth.module.ts",
        expectedText: "export class SharedAuthModule",
      },
      {
        alias: "app",
        expectedType: "sub-app",
        name: "worker-api",
        mustExist: "apps/worker-api/src/main.ts",
        expectedText: "WorkerApiModule",
      },
      {
        alias: "application",
        expectedType: "application",
        name: "standalone-svc",
        mustExist: "standalone-svc/package.json",
        expectedText: '"name": "standalone-svc"',
      },
    ];

    for (const c of newSchematicCases) {
      const cap = createCapturedIO(workdir);
      const res = await runCli(["g", c.alias, c.name], cap.io);
      expect(res.exitCode).toBe(0);
      const out = res.output as GenerateSchematicResult;
      expect(out.schematic).toBe(c.expectedType);
      const full = join(workdir, c.mustExist);
      expect(await fileExists(full)).toBe(true);
      expect(await Bun.file(full).text()).toContain(c.expectedText);
    }

    // configuration schematic (`bunest g config`) in a fresh dir
    const cfgDir = await makeTempDir("bunest-cli-config-schem-");
    const cfgCap = createCapturedIO(cfgDir);
    const cfgRes = await runCli(["g", "config"], cfgCap.io);
    expect(cfgRes.exitCode).toBe(0);
    expect(await fileExists(join(cfgDir, "bunest.json"))).toBe(true);
  });

  it("supports all 16 upgraded bunestMetadataPlugin options (classValidatorShim, classTransformerShim, parameterProperties, readonly, autoFillEnumName, skipDefaultValues, controller introspection, and static generateMetadataFile)", async () => {
    const dtoSource = `
export enum Priority {
  LOW = "low",
  HIGH = "high",
}

@Exclude()
export class TaskDto {
  /** Task title */
  @Expose({ name: "task_title" })
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  readonly title!: string;

  @Expose()
  @IsEmail()
  assigneeEmail!: string;

  @Expose()
  @IsInt()
  @Min(1)
  @Max(10)
  estimate: number = 2;

  @Expose()
  priority!: Priority;

  internalSecret!: string;

  constructor(public readonly traceId: string, public retryCount: number = 0) {}
}
`;

    // 1. Test classValidatorShim + classTransformerShim + parameterProperties + readonly + autoFillEnumName + dtoKeyOfComment
    const dtoRes = transformDtoMetadataSource(dtoSource, "task.dto.ts", {
      classValidatorShim: true,
      classTransformerShim: true,
      parameterProperties: true,
      readonly: true,
      autoFillEnumName: true,
      dtoKeyOfComment: "title",
      skipDefaultValues: false,
    });
    expect(dtoRes.modified).toBe(true);
    const props = dtoRes.classes[0]!.properties;
    const byName = new Map(props.map((p) => [p.name, p]));

    // internalSecret excluded due to @Exclude() on class + classTransformerShim: true!
    expect(byName.has("internalSecret")).toBe(false);
    expect(byName.get("title")).toMatchObject({
      aliasName: "task_title",
      isReadonly: true,
      constraints: { minLength: 3, maxLength: 80 },
    });
    expect(byName.get("assigneeEmail")?.constraints?.format).toBe("email");
    expect(byName.get("estimate")).toMatchObject({
      typeExpr: '"integer"',
      hasDefaultValue: true,
      defaultValue: 2,
      constraints: { typeOverride: '"integer"', minimum: 1, maximum: 10 },
    });
    expect(byName.get("priority")?.enumName).toBe("Priority");
    expect(byName.get("traceId")).toMatchObject({
      isReadonly: true,
      required: true,
      typeExpr: "String",
    });
    expect(byName.get("retryCount")).toMatchObject({
      required: false,
      defaultValue: 0,
    });
    expect(dtoRes.code).toContain('"title": "Task title"');
    expect(dtoRes.code).toContain('enumName: "Priority"');
    expect(dtoRes.code).toContain("readOnly: true");
    expect(dtoRes.code).toContain("default: 2");

    // Verify skipDefaultValues: true omits defaults
    const noDefaultsRes = transformDtoMetadataSource(dtoSource, "task.dto.ts", {
      skipDefaultValues: true,
    });
    expect(noDefaultsRes.code).not.toContain("default: 2");

    // 2. Controller introspection + skipAutoHttpCode + controllerKeyOfComment
    const ctrlSource = `
import { TaskDto } from "./task.dto";

export class TasksController {
  /** List all active tasks */
  @Get()
  findAll(): Promise<TaskDto[]> {
    return Promise.resolve([]);
  }

  /** Create a new task */
  @Post()
  create(): TaskDto {
    return {} as TaskDto;
  }
}
`;
    const ctrlRes = transformControllerMetadataSource(
      ctrlSource,
      "tasks.controller.ts",
      {
        controllerKeyOfComment: "summary",
        skipAutoHttpCode: false,
      },
    );
    expect(ctrlRes.modified).toBe(true);
    expect(ctrlRes.controllers[0]?.methods).toEqual([
      {
        name: "findAll",
        httpMethod: "GET",
        status: 200,
        summary: "List all active tasks",
        returnTypeExpr: "() => TaskDto",
        isArray: true,
      },
      {
        name: "create",
        httpMethod: "POST",
        status: 201,
        summary: "Create a new task",
        returnTypeExpr: "() => TaskDto",
        isArray: false,
      },
    ]);
    expect(ctrlRes.code).toContain(
      'Symbol.for("bunest:swagger:api_operation")',
    );
    expect(ctrlRes.code).toContain(
      'Symbol.for("bunest:swagger:api_responses")',
    );

    const skipStatusRes = transformControllerMetadataSource(
      ctrlSource,
      "tasks.controller.ts",
      { skipAutoHttpCode: true },
    );
    expect(skipStatusRes.controllers[0]?.methods[0]?.status).toBeUndefined();

    // 3. Static build-time generateMetadataFile() + real Bun.build() plugin check on controller
    const tmpProject = await makeTempDir("bunest-meta-gen-");
    await ensureDir(join(tmpProject, "src"));
    await Bun.write(
      join(tmpProject, "src/item.dto.ts"),
      `export class ItemDto {\n  /** Item label */\n  label!: string;\n  count: number = 1;\n}\n`,
    );
    await Bun.write(
      join(tmpProject, "src/item.controller.ts"),
      `import { ItemDto } from "./item.dto";\nfunction Get(): MethodDecorator { return () => {}; }\nexport class ItemController {\n  /** Fetch item */\n  @Get()\n  getItem(): ItemDto {\n    return new ItemDto();\n  }\n}\n`,
    );

    const metaFile = await generateMetadataFile({
      rootDir: tmpProject,
      pathToSource: "src",
      outDir: "src",
      esmCompatible: true,
      esmCompatibleWasConfigured: true,
    });
    expect(metaFile.modelsCount).toBe(1);
    expect(metaFile.controllersCount).toBe(1);
    expect(await fileExists(metaFile.outputPath)).toBe(true);
    expect(metaFile.code).toContain('"@nestjs/swagger"');
    expect(metaFile.code).toContain("./item.dto.js");
    expect(metaFile.code).toContain("./item.controller.js");
    expect(metaFile.code).toContain('"ItemDto"');
    expect(metaFile.code).toContain('"ItemController"');

    // Also test real Bun.build with bunestMetadataPlugin on controller file
    await Bun.write(
      join(tmpProject, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      }),
    );
    const buildOut = await Bun.build({
      entrypoints: [join(tmpProject, "src/item.controller.ts")],
      outdir: join(tmpProject, "dist"),
      target: "bun",
      format: "esm",
      plugins: [
        bunestMetadataPlugin({ controllerFileNameSuffix: [".controller.ts"] }),
      ],
    });
    expect(buildOut.success).toBe(true);
    const mod = (await import(
      `${Bun.pathToFileURL(buildOut.outputs[0]!.path).href}?t=${Date.now()}`
    )) as { ItemController: Function };
    const opMeta = Reflect.getOwnMetadata(
      Symbol.for("bunest:swagger:api_operation"),
      mod.ItemController.prototype.getItem,
    ) as { summary?: string };
    expect(opMeta?.summary).toBe("Fetch item");
  });

  it("generateMetadataFile() preserves nested DTO references, controller return DTO types, Expose aliases, enum imports, and array constraints", async () => {
    const tmpProject = await makeTempDir("bunest-meta-nested-");
    await ensureDir(join(tmpProject, "src/nested"));

    await Bun.write(
      join(tmpProject, "src/nested/address.dto.ts"),
      `export class AddressDto {\n  city!: string;\n}\n`,
    );
    await Bun.write(
      join(tmpProject, "src/order.dto.ts"),
      `import { AddressDto } from "./nested/address.dto";
function Expose(_opts?: { name?: string }): PropertyDecorator { return () => {}; }
function ArrayMinSize(_n: number): PropertyDecorator { return () => {}; }
function ArrayMaxSize(_n: number): PropertyDecorator { return () => {}; }
function ArrayUnique(): PropertyDecorator { return () => {}; }

export enum OrderStatus {
  Pending = "pending",
  Paid = "paid",
}

export class OrderDto {
  @Expose({ name: "shipping_address" })
  shippingAddress!: AddressDto;

  status!: OrderStatus;

  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  tags!: string[];
}
`,
    );
    await Bun.write(
      join(tmpProject, "src/order.controller.ts"),
      `import { OrderDto } from "./order.dto";
function Get(): MethodDecorator { return () => {}; }
export class OrderController {
  /** List orders */
  @Get()
  listOrders(): Promise<OrderDto[]> {
    return Promise.resolve([]);
  }
}
`,
    );

    const metaFile = await generateMetadataFile({
      rootDir: tmpProject,
      pathToSource: "src",
      outDir: "src",
      esmCompatible: false,
      esmCompatibleWasConfigured: true,
      autoFillEnumName: true,
      classTransformerShim: true,
    });

    expect(metaFile.modelsCount).toBe(2);
    expect(metaFile.controllersCount).toBe(1);
    // Value imports (NOT import type) for referenced DTOs & enums
    expect(metaFile.code).toContain(
      'import { AddressDto } from "./nested/address.dto";',
    );
    expect(metaFile.code).toContain(
      'import { OrderDto, OrderStatus } from "./order.dto";',
    );
    // Nested DTO preserved (not degraded to Object)
    expect(metaFile.code).toContain("type: () => AddressDto");
    expect(metaFile.code).not.toContain("type: () => Object");
    // Expose aliasName emitted as `name`
    expect(metaFile.code).toContain('name: "shipping_address"');
    // Enum value + enumName emitted
    expect(metaFile.code).toContain("enum: OrderStatus");
    expect(metaFile.code).toContain('enumName: "OrderStatus"');
    // Array constraints emitted
    expect(metaFile.code).toContain("minItems: 1");
    expect(metaFile.code).toContain("maxItems: 10");
    expect(metaFile.code).toContain("uniqueItems: true");
    // Controller return DTO type emitted
    expect(metaFile.code).toContain("type: () => OrderDto");

    // Dynamically import and execute the generated metadata.ts to verify runtime validity
    const loadedMod = (await import(
      `${Bun.pathToFileURL(metaFile.outputPath).href}?t=${Date.now()}`
    )) as { default: () => Promise<Record<string, any>> };
    const payload = await loadedMod.default();
    const swagger = payload["@nestjs/swagger"];
    const orderModelEntry = swagger.models.find(([, classes]: [unknown, any]) =>
      Boolean(classes.OrderDto),
    );
    expect(orderModelEntry).toBeDefined();
    const orderProps = orderModelEntry[1].OrderDto;
    expect(orderProps.shippingAddress.name).toBe("shipping_address");
    expect(orderProps.shippingAddress.type().name).toBe("AddressDto");
    expect(orderProps.status.enum).toEqual({
      Pending: "pending",
      Paid: "paid",
    });
    expect(orderProps.status.enumName).toBe("OrderStatus");
    expect(orderProps.tags.minItems).toBe(1);
    expect(orderProps.tags.maxItems).toBe(10);
    expect(orderProps.tags.uniqueItems).toBe(true);

    const ctrlEntry = swagger.controllers.find(([, ctrls]: [unknown, any]) =>
      Boolean(ctrls.OrderController),
    );
    expect(ctrlEntry).toBeDefined();
    expect(ctrlEntry[1].OrderController.listOrders.type().name).toBe(
      "OrderDto",
    );
    expect(ctrlEntry[1].OrderController.listOrders.isArray).toBe(true);
  });
});
