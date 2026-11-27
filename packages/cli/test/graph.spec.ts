import { afterEach, describe, expect, it } from "bun:test";
import {
  dirname,
  join,
  mkdirSyncPath,
  removePath,
  resolve,
  writeTextSync,
} from "@bunest/core";
import { runCli, type CliIO } from "../src";
import {
  runGraphCommand,
  type StaticGraphJsonOutput,
} from "../src/commands/graph";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

function createTempProject(files: Record<string, string>): string {
  const dir = join(
    TMP_DIR,
    `bunest-graph-${crypto.randomUUID().slice(0, 8)}`,
  );
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
      stdout: (m) => stdout.push(m),
      stderr: (m) => stderr.push(m),
    },
  };
}

function createSampleWorkspace(): string {
  return createTempProject({
    "src/decorators.ts": `
      export const Scope = { SINGLETON: 0, REQUEST: 1, TRANSIENT: 2 } as const;
      export function Global(): ClassDecorator { return () => {}; }
      export function Module(_o?: any): ClassDecorator { return () => {}; }
      export function Injectable(_o?: any): ClassDecorator { return () => {}; }
      export function Controller(_o?: any): ClassDecorator { return () => {}; }
      export function Repository(_o?: any): ClassDecorator { return () => {}; }
    `,
    "src/db/db.service.ts": `
      import { Injectable } from "../decorators";
      @Injectable()
      export class DbService {}
    `,
    "src/db/db.module.ts": `
      import { Global, Module } from "../decorators";
      import { DbService } from "./db.service";
      @Global()
      @Module({ providers: [DbService], exports: [DbService] })
      export class DbModule {}
    `,
    "src/users/user.repository.ts": `
      import { Repository } from "../decorators";
      @Repository()
      export abstract class UserRepository {}
    `,
    "src/users/users.service.ts": `
      import { Injectable } from "../decorators";
      import { DbService } from "../db/db.service";
      import { UserRepository } from "./user.repository";
      @Injectable()
      export class UsersService {
        constructor(
          private readonly db: DbService,
          private readonly repo: UserRepository,
        ) {}
      }
    `,
    "src/users/users.controller.ts": `
      import { Controller } from "../decorators";
      import { UsersService } from "./users.service";
      @Controller("users")
      export class UsersController {
        constructor(private readonly users: UsersService) {}
      }
    `,
    "src/users/users.module.ts": `
      import { Module } from "../decorators";
      import { UserRepository } from "./user.repository";
      import { UsersService } from "./users.service";
      import { UsersController } from "./users.controller";
      @Module({
        controllers: [UsersController],
        providers: [UsersService, UserRepository],
        exports: [UsersService],
      })
      export class UsersModule {}
    `,
    "src/billing/audit.service.ts": `
      import { Injectable, Scope } from "../decorators";
      @Injectable({ scope: Scope.REQUEST })
      export class AuditService {}
    `,
    "src/billing/billing.module.ts": `
      import { Module } from "../decorators";
      import { AuditService } from "./audit.service";
      @Module({
        providers: [AuditService],
        exports: [AuditService],
      })
      export class BillingModule {}
    `,
    "src/app.module.ts": `
      import { Module } from "./decorators";
      import { DbModule } from "./db/db.module";
      import { UsersModule } from "./users/users.module";
      import { BillingModule } from "./billing/billing.module";
      @Module({
        imports: [DbModule, UsersModule, BillingModule],
      })
      export class AppModule {}
    `,
  });
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("bunest graph CLI command", () => {
  it("renders Mermaid flowchart LR by default and with --format mermaid / --format=mermaid", async () => {
    const projectDir = createSampleWorkspace();

    const defaultCap = createCapturedIO(projectDir);
    const defaultRes = await runCli(["graph"], defaultCap.io);
    expect(defaultRes.exitCode).toBe(0);
    const mermaid = defaultCap.stdout.join("\n");
    expect(mermaid.startsWith("flowchart LR")).toBe(true);
    expect(mermaid).toContain('M_AppModule[["AppModule"]]:::module');
    expect(mermaid).toContain('M_DbModule[["DbModule (global)"]]:::module');
    expect(mermaid).toContain("UsersController (controller, SINGLETON)");
    expect(mermaid).toContain("UserRepository (repository, SINGLETON)");
    expect(mermaid).toContain("AuditService (REQUEST)");
    expect(mermaid).toContain("M_AppModule -->|imports| M_UsersModule");
    expect(mermaid).toContain("M_UsersModule -.->|controller| C_UsersController");
    expect(mermaid).toContain("M_UsersModule -.->|provides| P_UsersService");
    expect(mermaid).toContain("C_UsersController -->|injects| P_UsersService");
    expect(mermaid).toContain("P_UsersService -->|injects| P_DbService");

    // Explicit space-separated `--format mermaid`
    const spaceCap = createCapturedIO(projectDir);
    const spaceRes = await runCli(["graph", "--format", "mermaid"], spaceCap.io);
    expect(spaceRes.exitCode).toBe(0);
    expect(spaceCap.stdout.join("\n")).toBe(mermaid);

    // Equals-form `--format=mermaid`
    const eqCap = createCapturedIO(projectDir);
    const eqRes = await runCli(["graph", "--format=mermaid"], eqCap.io);
    expect(eqRes.exitCode).toBe(0);
    expect(eqCap.stdout.join("\n")).toBe(mermaid);
  });

  it("renders Graphviz DOT with --format dot and structured JSON with --format json", async () => {
    const projectDir = createSampleWorkspace();

    // DOT format
    const dotCap = createCapturedIO(projectDir);
    const dotRes = await runCli(["graph", "--format", "dot"], dotCap.io);
    expect(dotRes.exitCode).toBe(0);
    const dot = dotCap.stdout.join("\n");
    expect(dot.startsWith("digraph BunestGraph {")).toBe(true);
    expect(dot).toContain("rankdir=LR;");
    expect(dot).toContain('"mod:AppModule"');
    expect(dot).toContain('"prov:UsersController"');
    expect(dot).toContain('"prov:AuditService"');
    expect(dot).toContain('"mod:AppModule" -> "mod:UsersModule" [label="import"];');
    expect(dot).toContain('"prov:UsersController" -> "prov:UsersService" [label="injects"];');
    expect(dot.trim().endsWith("}")).toBe(true);

    // JSON format
    const jsonCap = createCapturedIO(projectDir);
    const jsonRes = await runCli(["graph", "--format", "json"], jsonCap.io);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonCap.stdout.join("\n")) as StaticGraphJsonOutput;
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.modules.map((m) => m.name)).toEqual([
      "AppModule",
      "BillingModule",
      "DbModule",
      "UsersModule",
    ]);
    expect(parsed.providers.some((p) => p.name === "UsersController" && p.kind === "controller")).toBe(true);
    expect(parsed.providers.some((p) => p.name === "UserRepository" && p.kind === "repository")).toBe(true);
    expect(parsed.providers.some((p) => p.name === "AuditService" && p.scope === "REQUEST")).toBe(true);
    expect(
      parsed.edges.some(
        (e) =>
          e.from === "UsersController" &&
          e.to === "UsersService" &&
          e.kind === "injects",
      ),
    ).toBe(true);
  });

  it("supports --module <Name> filtering and --cwd <dir> override", async () => {
    const projectDir = createSampleWorkspace();

    // Run from an unrelated cwd, pointing `--cwd` at projectDir and filtering to UsersModule
    const cap = createCapturedIO(TMP_DIR);
    const res = await runCli(
      ["graph", "--format", "json", "--module", "UsersModule", "--cwd", projectDir],
      cap.io,
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(cap.stdout.join("\n")) as StaticGraphJsonOutput;
    expect(parsed.filterModule).toBe("UsersModule");
    expect(parsed.modules.map((m) => m.name)).toEqual(["UsersModule"]);
    // Unrelated BillingModule / AuditService must be excluded
    expect(parsed.modules.some((m) => m.name === "BillingModule")).toBe(false);
    expect(parsed.providers.some((p) => p.name === "AuditService")).toBe(false);
    // Direct controller, provider, repository, and injected DbService are retained
    const provNames = parsed.providers.map((p) => p.name);
    expect(provNames).toContain("UsersController");
    expect(provNames).toContain("UsersService");
    expect(provNames).toContain("UserRepository");
    expect(provNames).toContain("DbService");
  });

  it("exits with code 1 on unknown --module or invalid --format", async () => {
    const projectDir = createSampleWorkspace();

    const badModCap = createCapturedIO(projectDir);
    const badModRes = await runCli(
      ["graph", "--module", "NonExistentModule"],
      badModCap.io,
    );
    expect(badModRes.exitCode).toBe(1);
    expect(badModCap.stderr.join("\n")).toContain('Module "NonExistentModule" not found');
    expect(badModCap.stderr.join("\n")).toContain("Available modules:");

    const badFmtCap = createCapturedIO(projectDir);
    const badFmtRes = await runCli(
      ["graph", "--format", "xml"],
      badFmtCap.io,
    );
    expect(badFmtRes.exitCode).toBe(1);
    expect(badFmtCap.stderr.join("\n")).toContain('Invalid --format "xml"');

    const missingFmtCap = createCapturedIO(projectDir);
    const missingFmtRes = await runCli(["graph", "--format"], missingFmtCap.io);
    expect(missingFmtRes.exitCode).toBe(1);
    expect(missingFmtCap.stderr.join("\n")).toContain('Flag "--format" requires a value');
  });

  it("works offline on the repository examples/starter app", async () => {
    const starterDir = resolve(import.meta.dir, "../../../examples/starter");
    const res = await runGraphCommand({
      cwd: starterDir,
      format: "mermaid",
      silent: true,
    });
    expect(res.exitCode).toBe(0);
    expect(res.output.startsWith("flowchart LR")).toBe(true);
    expect(res.output).toContain("AppModule");
    expect(res.graph?.modules.length).toBeGreaterThanOrEqual(1);
  });
});
