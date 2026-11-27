import { afterEach, describe, expect, it } from "bun:test";
import { ensureDir, join, removePath, statPath } from "@bunest/core";
import { createTypedClient } from "@bunest/core/client";
import {
  BunestTypegenScanner,
  HELP_TEXT,
  generateBunestTypes,
  runCli,
  runTypegenCommand,
  startTypegenWatcher,
  validateGeneratedDeclaration,
  type CliIO,
  type TypegenCommandResult,
} from "../src";
import { emitClientRouteTypes } from "../src/typegen";

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

async function createMonorepoFixture(rootDir: string): Promise<void> {
  await ensureDir(join(rootDir, "src/orders"));
  await ensureDir(join(rootDir, "apps/web/src"));

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
    join(rootDir, "src/decorators.stub.ts"),
    `export function Controller(_prefix?: unknown): ClassDecorator { return () => {}; }
export function Get(_path?: string): MethodDecorator { return () => {}; }
export function Post(_path?: string): MethodDecorator { return () => {}; }
export function Delete(_path?: string): MethodDecorator { return () => {}; }
export function Param(_key?: string): ParameterDecorator { return () => {}; }
export function Query(_key?: string): ParameterDecorator { return () => {}; }
export function Body(): ParameterDecorator { return () => {}; }
`,
  );

  await Bun.write(
    join(rootDir, "src/orders/orders.dto.ts"),
    `export interface CreateOrderDto {
  sku: string;
  quantity: number;
}

export interface OrderResult {
  id: string;
  sku: string;
  quantity: number;
  expanded?: boolean;
}
`,
  );

  await Bun.write(
    join(rootDir, "src/orders/orders.controller.ts"),
    `import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from "../decorators.stub";
import type { CreateOrderDto, OrderResult } from "./orders.dto";

@Controller("orders")
export class OrdersController {
  @Get(":id")
  async findOne(
    @Param("id") id: string,
    @Query("expand") expand?: boolean,
  ): Promise<OrderResult> {
    return { id, sku: "S1", quantity: 1, expanded: expand };
  }

  @Post()
  async create(@Body() dto: CreateOrderDto): Promise<OrderResult> {
    return { id: "new", sku: dto.sku, quantity: dto.quantity };
  }

  @Delete(":id")
  async remove(@Param("id") _id: string): Promise<void> {}
}
`,
  );

  await Bun.write(
    join(rootDir, "src/health.controller.ts"),
    `import { Controller, Get } from "./decorators.stub";

@Controller("health")
export class HealthController {
  @Get()
  check(): { ok: boolean } {
    return { ok: true };
  }
}
`,
  );
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("@bunest/cli typegen --client-types (frontend-portable route types)", () => {
  it("emits standalone AppRoutes + appRouteManifest with zero @bunest/core imports while keeping default bunest.d.ts intact", async () => {
    const workdir = await makeTempDir("bunest-typegen-client-");
    await createMonorepoFixture(workdir);

    const cap = createCapturedIO(workdir);
    const cmdRes = await runTypegenCommand(
      {
        cwd: workdir,
        clientTypes: "apps/web/src/api-routes.ts",
      },
      cap.io,
    );

    expect(cmdRes.exitCode).toBe(0);
    expect(cmdRes.result.changed).toBe(true);
    expect(cmdRes.result.relativePath).toBe(".bunest/types/bunest.d.ts");
    expect(cmdRes.result.clientTypes).toBeDefined();
    expect(cmdRes.result.clientTypes!.relativePath).toBe(
      "apps/web/src/api-routes.ts",
    );
    expect(cmdRes.result.clientTypes!.changed).toBe(true);
    expect(await fileExists(cmdRes.result.outputPath)).toBe(true);
    expect(await fileExists(cmdRes.result.clientTypes!.outputPath)).toBe(true);

    // Default `.bunest/types/bunest.d.ts` remains 100% backward compatible
    const defaultDts = await Bun.file(cmdRes.result.outputPath).text();
    expect(defaultDts).toContain('declare module "@bunest/core"');
    expect(defaultDts).toContain("interface BunestRouteRegistry");

    // Standalone client types file has ZERO imports or references to @bunest/core
    const clientTs = await Bun.file(cmdRes.result.clientTypes!.outputPath).text();
    expect(validateGeneratedDeclaration(clientTs)).toBe(true);
    expect(clientTs).not.toContain("@bunest/core");
    expect(clientTs).not.toContain("declare module");
    expect(clientTs).not.toContain("declare global");

    // Uses verbatimModuleSyntax-safe `import type` with relative path from apps/web/src -> src/orders/orders.dto
    expect(clientTs).toContain(
      'import type { CreateOrderDto, OrderResult } from "../../../src/orders/orders.dto";',
    );
    expect(clientTs).toContain("export interface AppRoutes {");
    expect(clientTs).toContain('"GET /health": {');
    expect(clientTs).toContain('"GET /orders/:id": {');
    expect(clientTs).toContain("readonly params: { id: string };");
    expect(clientTs).toContain("readonly query: { expand?: boolean };");
    expect(clientTs).toContain('"POST /orders": {');
    expect(clientTs).toContain("readonly body: CreateOrderDto;");
    expect(clientTs).toContain("readonly response: OrderResult;");
    expect(clientTs).toContain('"DELETE /orders/:id": {');
    expect(clientTs).toContain("export type AppRouteKey = keyof AppRoutes;");
    expect(clientTs).toContain("export type AppRoutePath =");
    expect(clientTs).toContain("export const appRouteManifest = {");
    expect(clientTs).toContain('controller: "OrdersController",');
    expect(clientTs).toContain('handler: "findOne",');
    expect(clientTs).toContain("} as const;");

    // Logs mention both files
    expect(cap.stdout.join("\n")).toContain(".bunest/types/bunest.d.ts");
    expect(cap.stdout.join("\n")).toContain("apps/web/src/api-routes.ts");

    // Second run is a no-op (upToDate: true, changed: false)
    const second = await runTypegenCommand({
      cwd: workdir,
      clientTypes: "apps/web/src/api-routes.ts",
      silent: true,
    });
    expect(second.exitCode).toBe(0);
    expect(second.result.changed).toBe(false);
    expect(second.result.upToDate).toBe(true);
    expect(second.result.clientTypes!.changed).toBe(false);
    expect(second.result.clientTypes!.upToDate).toBe(true);
  });

  it("supports .d.ts client-types output (declaration-only, no runtime const initializer) and empty route sets", async () => {
    const workdir = await makeTempDir("bunest-typegen-client-dts-");
    await createMonorepoFixture(workdir);

    const res = await generateBunestTypes({
      cwd: workdir,
      clientTypes: "apps/web/src/api-routes.d.ts",
      silent: true,
    });

    const dts = res.clientTypes!.content;
    expect(dts).toContain("export interface AppRoutes {");
    expect(dts).not.toContain("@bunest/core");
    expect(dts).not.toContain("export const appRouteManifest =");

    // Empty project produces valid empty AppRoutes + appRouteManifest
    const emptyDir = await makeTempDir("bunest-typegen-client-empty-");
    await ensureDir(join(emptyDir, "src"));
    const emptyRes = await generateBunestTypes({
      cwd: emptyDir,
      clientTypes: "client/routes.ts",
      silent: true,
    });
    expect(emptyRes.clientTypes!.content).toContain(
      "export interface AppRoutes {}",
    );
    expect(emptyRes.clientTypes!.content).toContain(
      "export const appRouteManifest = {} as const;",
    );
  });

  it("strips any @bunest/* package imports or inline import('@bunest/...') types from emitted client routes", async () => {
    const workdir = await makeTempDir("bunest-typegen-client-strip-");
    await ensureDir(join(workdir, "src"));
    const scanner = new BunestTypegenScanner({ cwd: workdir, sourceRoot: "src" });
    const baseScan = scanner.scan();

    const syntheticScan = {
      ...baseScan,
      routes: [
        {
          key: "GET /download",
          method: "GET",
          path: "/download",
          paramsTypeText: "Record<string, never>",
          queryTypeText: "Record<string, unknown>",
          bodyTypeText: "never",
          responseTypeText:
            'StreamableFile | import("@bunest/core").HttpStatus',
          controllerName: "FilesController",
          handlerName: "download",
          sourceFile: join(workdir, "src/files.controller.ts"),
          imports: [
            {
              filePath: "@bunest/core",
              exportName: "StreamableFile",
              isTypeOnly: true,
            },
          ],
        },
      ],
    };

    const output = emitClientRouteTypes(syntheticScan, {
      cwd: workdir,
      outputPath: join(workdir, "apps/web/src/routes.ts"),
    });

    expect(output).not.toContain("@bunest/core");
    expect(output).not.toContain("StreamableFile");
    expect(output).toContain("readonly response: unknown | unknown;");
    expect(validateGeneratedDeclaration(output)).toBe(true);
  });

  it("honors --check, --dry-run, and watcher regeneration for --client-types", async () => {
    const workdir = await makeTempDir("bunest-typegen-client-check-");
    await createMonorepoFixture(workdir);
    const clientRel = "apps/web/src/api-routes.ts";

    // --dry-run does not write either file
    const dryRes = await runTypegenCommand({
      cwd: workdir,
      clientTypes: clientRel,
      dryRun: true,
      silent: true,
    });
    expect(dryRes.exitCode).toBe(0);
    expect(await fileExists(join(workdir, clientRel))).toBe(false);

    // --check fails when files are missing
    const missingCheck = await runTypegenCommand({
      cwd: workdir,
      clientTypes: clientRel,
      check: true,
      silent: true,
    });
    expect(missingCheck.exitCode).toBe(1);
    expect(missingCheck.result.upToDate).toBe(false);

    // Generate both files
    await runTypegenCommand({
      cwd: workdir,
      clientTypes: clientRel,
      silent: true,
    });

    // --check passes when both are up-to-date
    const okCheck = await runTypegenCommand({
      cwd: workdir,
      clientTypes: clientRel,
      check: true,
      silent: true,
    });
    expect(okCheck.exitCode).toBe(0);
    expect(okCheck.result.upToDate).toBe(true);

    // Tamper with ONLY the client types file -> --check detects staleness!
    await Bun.write(join(workdir, clientRel), "// stale\n");
    const staleClientCheck = await runTypegenCommand({
      cwd: workdir,
      clientTypes: clientRel,
      check: true,
      silent: true,
    });
    expect(staleClientCheck.exitCode).toBe(1);
    expect(staleClientCheck.result.clientTypes!.upToDate).toBe(false);

    // Watcher updates client-types when a new controller is added
    const watcher = await startTypegenWatcher({
      cwd: workdir,
      clientTypes: clientRel,
      debounceMs: 30,
      silent: true,
    });
    try {
      const usersControllerPath = join(workdir, "src/users.controller.ts");
      await Bun.write(
        usersControllerPath,
        `import { Controller, Get } from "./decorators.stub";
@Controller("users")
export class UsersController {
  @Get()
  list(): string[] { return []; }
}
`,
      );
      const updated = await watcher.regenerate([usersControllerPath]);
      expect(updated.changed).toBe(true);
      expect(updated.clientTypes!.changed).toBe(true);
      expect(updated.clientTypes!.content).toContain('"GET /users": {');
    } finally {
      await watcher.close();
    }
  });

  it("end-to-end: dynamically imports generated api-routes.ts manifest and calls live Bun.serve via createTypedClient", async () => {
    const workdir = await makeTempDir("bunest-typegen-client-e2e-");
    await createMonorepoFixture(workdir);

    const gen = await generateBunestTypes({
      cwd: workdir,
      clientTypes: "apps/web/src/api-routes.ts",
      silent: true,
    });
    const generatedModuleUrl = Bun.pathToFileURL(
      gen.clientTypes!.outputPath,
    ).href;
    const generated = (await import(generatedModuleUrl)) as {
      appRouteManifest: Record<
        string,
        { method: string; path: string; controller: string; handler: string }
      >;
    };

    expect(generated.appRouteManifest["GET /orders/:id"]).toEqual({
      method: "GET",
      path: "/orders/:id",
      controller: "OrdersController",
      handler: "findOne",
    });

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/health") {
          return Response.json({ ok: true });
        }
        if (req.method === "GET" && url.pathname.startsWith("/orders/")) {
          const id = decodeURIComponent(url.pathname.slice("/orders/".length));
          return Response.json({
            id,
            sku: "E2E",
            quantity: 7,
            expanded: url.searchParams.get("expand") === "true",
          });
        }
        if (req.method === "POST" && url.pathname === "/orders") {
          const body = (await req.json()) as { sku: string; quantity: number };
          return Response.json({ id: "ord_e2e", ...body }, { status: 201 });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      interface GeneratedRoutes {
        "GET /health": {
          readonly method: "GET";
          readonly path: "/health";
          readonly params: Record<string, never>;
          readonly query: Record<string, unknown>;
          readonly body: never;
          readonly response: { ok: boolean };
          readonly controller: "HealthController";
          readonly handler: "check";
        };
        "GET /orders/:id": {
          readonly method: "GET";
          readonly path: "/orders/:id";
          readonly params: { id: string };
          readonly query: { expand?: boolean };
          readonly body: never;
          readonly response: {
            id: string;
            sku: string;
            quantity: number;
            expanded?: boolean;
          };
          readonly controller: "OrdersController";
          readonly handler: "findOne";
        };
        "POST /orders": {
          readonly method: "POST";
          readonly path: "/orders";
          readonly params: Record<string, never>;
          readonly query: Record<string, unknown>;
          readonly body: { sku: string; quantity: number };
          readonly response: { id: string; sku: string; quantity: number };
          readonly controller: "OrdersController";
          readonly handler: "create";
        };
      }

      const client = createTypedClient<GeneratedRoutes>({
        baseUrl: server.url.origin,
        retry: false,
        manifest: generated.appRouteManifest,
      });

      const health = await client.get("/health");
      expect(health.data).toEqual({ ok: true });

      const found = await client.$rpc.OrdersController.findOne({
        params: { id: "ord_77" },
        query: { expand: true },
      });
      expect(found.data).toEqual({
        id: "ord_77",
        sku: "E2E",
        quantity: 7,
        expanded: true,
      });

      const created = await client.$rpc.OrdersController.create({
        body: { sku: "DESK", quantity: 2 },
      });
      expect(created.status).toBe(201);
      expect(created.data).toEqual({
        id: "ord_e2e",
        sku: "DESK",
        quantity: 2,
      });
    } finally {
      server.stop(true);
    }
  });

  it("supports CLI invocation `bunest typegen --client-types <output-path>` via runCli", async () => {
    const workdir = await makeTempDir("bunest-typegen-client-cli-");
    await createMonorepoFixture(workdir);
    expect(HELP_TEXT).toContain("--client-types");

    const genCap = createCapturedIO(workdir);
    const genRes = await runCli(
      ["typegen", "--client-types", "apps/web/src/routes.ts"],
      genCap.io,
    );
    expect(genRes.exitCode).toBe(0);
    const out = genRes.output as TypegenCommandResult;
    expect(out.result.clientTypes?.relativePath).toBe("apps/web/src/routes.ts");
    expect(await fileExists(join(workdir, "apps/web/src/routes.ts"))).toBe(
      true,
    );

    const checkCap = createCapturedIO(workdir);
    const checkRes = await runCli(
      ["tg", "--check", "--client-types=apps/web/src/routes.ts"],
      checkCap.io,
    );
    expect(checkRes.exitCode).toBe(0);
  });
});
