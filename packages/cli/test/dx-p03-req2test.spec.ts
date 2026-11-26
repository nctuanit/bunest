import { afterEach, describe, expect, it } from "bun:test";
import {
  BunestFactory,
  Controller,
  Get,
  Module,
  ensureDir,
  join,
  removePath,
  resolve,
  statPath,
} from "@bunest/core";
import { FileCollisionError } from "../src/utils/fs-writer";
import {
  parseHttpFileToScenarios,
  planTestFromRequest,
  runTestFromRequestCommand,
  sanitizeScenarioForTest,
  type RequestScenarioV1,
} from "../src/commands/test-from-request";
import type { CliIO } from "../src/types";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const WORKSPACE_TMP_BASE = REPO_ROOT;
const tempDirs: string[] = [];

async function makeTempDir(prefix: string, insideWorkspace = false): Promise<string> {
  const base = insideWorkspace ? WORKSPACE_TMP_BASE : TMP_DIR;
  const dir = join(base, `${prefix}${crypto.randomUUID().slice(0, 8)}`);
  await ensureDir(dir);
  tempDirs.push(dir);
  return dir;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await statPath(filePath);
    return true;
  } catch {
    return false;
  }
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

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("P0.3 — Request to Regression Test (test-from-request)", () => {
  it("parses both RequestScenarioV1 JSON and .http sample files (201 happy-path + 400 validation failure)", async () => {
    const httpSample = [
      "@baseUrl = http://localhost:3000",
      "@contentType = application/json",
      "",
      "### Create order (201)",
      "# @module OrdersModule",
      "# @moduleImport ../src/orders/orders.module",
      "# @override OrdersExternalGateway",
      "POST {{baseUrl}}/orders?source=web HTTP/1.1",
      "Content-Type: {{contentType}}",
      "",
      JSON.stringify({ item: "espresso", quantity: 2 }, null, 2),
      "",
      "### Create order - missing required fields (400)",
      "POST {{baseUrl}}/orders HTTP/1.1",
      "Content-Type: {{contentType}}",
      "",
      JSON.stringify({ quantity: 0 }, null, 2),
    ].join("\n");

    const parsed = parseHttpFileToScenarios(httpSample, "requests/orders.http");
    expect(parsed).toHaveLength(2);

    expect(parsed[0]!.schemaVersion).toBe(1);
    expect(parsed[0]!.method).toBe("POST");
    expect(parsed[0]!.path).toBe("/orders");
    expect(parsed[0]!.query).toEqual({ source: "web" });
    expect(parsed[0]!.body).toEqual({ item: "espresso", quantity: 2 });
    expect(parsed[0]!.assertions?.status).toBe(201);
    expect(parsed[0]!.routeMeta?.module).toBe("OrdersModule");
    expect(parsed[0]!.routeMeta?.moduleImportPath).toBe("../src/orders/orders.module");
    expect(parsed[0]!.routeMeta?.sourceFile).toBe("requests/orders.http");
    expect(parsed[0]!.overrides).toEqual(["OrdersExternalGateway"]);

    expect(parsed[1]!.method).toBe("POST");
    expect(parsed[1]!.path).toBe("/orders");
    expect(parsed[1]!.body).toEqual({ quantity: 0 });
    expect(parsed[1]!.assertions?.status).toBe(400);

    const planFromHttp = planTestFromRequest(parsed);
    expect(planFromHttp.schemaVersion).toBe("1.0");
    expect(planFromHttp.files).toHaveLength(1);
    const code = planFromHttp.files[0]!.content;
    expect(code).toContain('import { OrdersModule } from "../src/orders/orders.module";');
    expect(code).toContain('.overrideProvider("OrdersExternalGateway")');
    expect(code).toContain("expect(res.status).toBe(201);");
    expect(code).toContain("expect(res.status).toBe(400);");
    expect(code).toContain("afterEach(async () => {");
    expect(code).toContain("await moduleRef.close();");

    // Also verify loading a RequestScenarioV1 JSON file via runTestFromRequestCommand
    const workdir = await makeTempDir("bunest-p03-json-");
    const scenarioJson: RequestScenarioV1 = {
      schemaVersion: 1,
      name: "Create order flow",
      method: "POST",
      path: "/orders",
      body: { item: "latte", quantity: 1 },
      observedResponse: {
        status: 201,
        contentType: "application/json",
        body: { status: "created", item: "latte", quantity: 1 },
      },
      assertions: {
        status: 201,
        allowFields: ["status", "item", "quantity"],
      },
      cases: [
        {
          name: "rejects invalid order payload (400)",
          method: "POST",
          path: "/orders",
          body: { item: "" },
          assertions: { status: 400 },
        },
      ],
    };
    const jsonPath = join(workdir, "orders.scenario.json");
    await Bun.write(jsonPath, JSON.stringify(scenarioJson, null, 2));

    const { io } = createCapturedIO(workdir);
    const result = await runTestFromRequestCommand(
      {
        cwd: workdir,
        inputPath: "orders.scenario.json",
        dryRun: true,
        format: "json",
      },
      io,
    );
    expect(result.exitCode).toBe(0);
    expect(result.plan.files[0]!.content).toContain('expect(body.status).toBe("created");');
    expect(result.plan.files[0]!.content).toContain("expect(res.status).toBe(400);");
  });

  it("sanitizes secrets/tokens/cookies/passwords/JWTs with ZERO leaks in code or diff and emits shape assertions for volatile fields", () => {
    const rawBearer = "super-secret-bearer-token-99999";
    const rawApiKey = "sk_live_very_secret_api_key_12345";
    const rawCookie = "sid=secret_session_cookie_abcde";
    const rawPassword = "MyUltraSecretPassword!2026";
    const rawPrivateKey = "-----BEGIN-PRIVATE-KEY-SECRET-XYZ-----";
    const rawJwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzQyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const rawResponseSecret = "resp_refresh_secret_77777";
    const volatileUuid = "550e8400-e29b-41d4-a716-446655440000";
    const volatileIso = "2026-11-26T18:05:30.123Z";
    const volatileEpochMs = 1795691130123;

    const scenario: RequestScenarioV1 = {
      schemaVersion: 1,
      name: "Auth login and profile",
      method: "POST",
      path: "/auth/login",
      headers: {
        Authorization: `Bearer ${rawBearer}`,
        "X-Api-Key": rawApiKey,
        Cookie: rawCookie,
        "X-Custom-Trace": "trace-static-ok",
      },
      body: {
        email: "dev@bunest.dev",
        password: rawPassword,
        nested: {
          privateKey: rawPrivateKey,
          embeddedJwt: rawJwt,
        },
      },
      observedResponse: {
        status: 201,
        contentType: "application/json",
        headers: {
          "Set-Cookie": rawCookie,
        },
        body: {
          id: volatileUuid,
          createdAt: volatileIso,
          issuedMs: volatileEpochMs,
          role: "admin",
          refreshToken: rawResponseSecret,
          sessionJwt: rawJwt,
        },
      },
      assertions: {
        status: 201,
      },
    };

    const sanitized = sanitizeScenarioForTest(scenario);
    expect(sanitized.sanitized.length).toBeGreaterThanOrEqual(7);

    const plan = planTestFromRequest(scenario);
    const generatedCode = plan.files[0]!.content;
    const diffPreview = plan.diffs[0]!.unifiedDiff;
    const serializedAudit = JSON.stringify({
      sanitized: plan.sanitized,
      scenario: sanitized.scenario,
    });

    const forbiddenSecrets = [
      rawBearer,
      rawApiKey,
      rawCookie,
      rawPassword,
      rawPrivateKey,
      rawJwt,
      rawResponseSecret,
    ];

    for (const secret of forbiddenSecrets) {
      expect(generatedCode).not.toContain(secret);
      expect(diffPreview).not.toContain(secret);
      expect(serializedAudit).not.toContain(secret);
    }

    // Named fixture constants must be declared and referenced
    expect(generatedCode).toContain("const FIXTURE_AUTH_TOKEN =");
    expect(generatedCode).toContain("const FIXTURE_API_KEY =");
    expect(generatedCode).toContain("const FIXTURE_COOKIE =");
    expect(generatedCode).toContain("const FIXTURE_PASSWORD =");
    expect(generatedCode).toContain("const FIXTURE_PRIVATE_KEY =");
    expect(generatedCode).toContain("const FIXTURE_JWT_TOKEN =");

    // Volatile values must produce shape assertions, never brittle literal values
    expect(generatedCode).not.toContain(volatileUuid);
    expect(generatedCode).not.toContain(volatileIso);
    expect(generatedCode).not.toContain(String(volatileEpochMs));
    expect(generatedCode).toContain('expect(typeof body.id).toBe("string");');
    expect(generatedCode).toContain("expect(body.id).toBeDefined();");
    expect(generatedCode).toContain('expect(typeof body.createdAt).toBe("string");');
    expect(generatedCode).toContain('expect(typeof body.issuedMs).toBe("number");');

    // Stable non-sensitive field gets exact assertion
    expect(generatedCode).toContain('expect(body.role).toBe("admin");');
  });

  it("handles binary/stream responses with binaryFixtureSuggestion and only writes fixture on saveBinaryFixture: true", async () => {
    const fakePdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const scenario: RequestScenarioV1 = {
      schemaVersion: 1,
      name: "Download invoice PDF",
      method: "GET",
      path: "/invoices/42/pdf",
      observedResponse: {
        status: 200,
        contentType: "application/pdf",
        rawBody: fakePdfBytes,
        sizeBytes: fakePdfBytes.byteLength,
      },
      assertions: {
        status: 200,
      },
    };

    // Default: do NOT plan or write fixture file
    const planDefault = planTestFromRequest(scenario);
    expect(planDefault.binaryFixtureSuggestion).toEqual({
      suggestedPath: "test/fixtures/download-invoice-pdf.pdf",
      contentType: "application/pdf",
      sizeBytes: 8,
    });
    expect(planDefault.files).toHaveLength(1);
    expect(planDefault.files[0]!.content).not.toContain("%PDF-1.7");
    expect(planDefault.files[0]!.content).toContain('expect(res.header("content-type") ?? "").toContain("application/pdf");');
    expect(planDefault.files[0]!.content).toContain("const bytes = await res.bytes();");

    // Opt-in: saveBinaryFixture: true plans and writes the fixture file
    const workdir = await makeTempDir("bunest-p03-bin-");
    const planOptIn = planTestFromRequest(scenario, { saveBinaryFixture: true });
    expect(planOptIn.files).toHaveLength(2);
    expect(planOptIn.files[1]!.relativePath).toBe("test/fixtures/download-invoice-pdf.pdf");

    await runTestFromRequestCommand({
      cwd: workdir,
      scenario,
      saveBinaryFixture: true,
    });
    expect(await fileExists(join(workdir, "test/download-invoice-pdf.regression.spec.ts"))).toBe(true);
    expect(await fileExists(join(workdir, "test/fixtures/download-invoice-pdf.pdf"))).toBe(true);

    // Also verify text/event-stream detection via contentType
    const ssePlan = planTestFromRequest({
      schemaVersion: 1,
      name: "Order events stream",
      method: "GET",
      path: "/orders/events",
      observedResponse: {
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        rawBody: "data: {\"ok\":true}\n\n",
      },
    });
    expect(ssePlan.binaryFixtureSuggestion?.contentType).toBe("text/event-stream; charset=utf-8");
    expect(ssePlan.files).toHaveLength(1);
  });

  it("propagates unsavedBuffer: true as an explicit warning in plan and formatted outputs", async () => {
    const scenario: RequestScenarioV1 = {
      schemaVersion: 1,
      name: "Draft route",
      method: "GET",
      path: "/draft",
      routeMeta: {
        sourceFile: "src/draft/draft.controller.ts",
        unsavedBuffer: true,
      },
      assertions: { status: 200 },
    };

    const plan = planTestFromRequest(scenario);
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.warnings[0]).toContain("Unsaved editor buffer");
    expect(plan.warnings[0]).toContain("src/draft/draft.controller.ts");
    expect(plan.files[0]!.content).toContain("// WARNING: Unsaved editor buffer");

    const workdir = await makeTempDir("bunest-p03-unsaved-");
    const { io, stdout } = createCapturedIO(workdir);
    await runTestFromRequestCommand(
      { cwd: workdir, scenario, dryRun: true, format: "diff" },
      io,
    );
    expect(stdout.join("\n")).toContain("WARNING: Unsaved editor buffer");
  });

  it("supports --dry-run (writes nothing) and aborts cleanly on file collision without overwriting", async () => {
    const workdir = await makeTempDir("bunest-p03-dryrun-");
    const scenario: RequestScenarioV1 = {
      schemaVersion: 1,
      name: "Health check",
      method: "GET",
      path: "/health",
      assertions: { status: 200 },
    };

    const targetRel = "test/health-check.regression.spec.ts";
    const targetFull = join(workdir, targetRel);

    // 1. Dry-run writes nothing
    const { io, stdout } = createCapturedIO(workdir);
    const dryRes = await runTestFromRequestCommand(
      { cwd: workdir, scenario, out: targetRel, dryRun: true, format: "pretty" },
      io,
    );
    expect(dryRes.dryRun).toBe(true);
    expect(dryRes.files[0]!.action).toBe("dry-run");
    expect(await fileExists(targetFull)).toBe(false);
    expect(stdout.join("\n")).toContain("Dry-run:");

    // 2. Existing user test file -> collision aborts cleanly without overwriting
    const existingContent = "// user hand-written test — must not be overwritten\n";
    await ensureDir(join(workdir, "test"));
    await Bun.write(targetFull, existingContent);

    await expect(
      runTestFromRequestCommand({
        cwd: workdir,
        scenario,
        out: targetRel,
      }),
    ).rejects.toBeInstanceOf(FileCollisionError);

    expect(await Bun.file(targetFull).text()).toBe(existingContent);

    // 3. Explicit --force overwrites
    const forced = await runTestFromRequestCommand({
      cwd: workdir,
      scenario,
      out: targetRel,
      force: true,
    });
    expect(forced.files[0]!.action).toBe("overwrite");
    expect(await Bun.file(targetFull).text()).toContain("Test.createTestingModule");
  });

  it("end-to-end: runs a generated regression test against a real mini Bunest module with ValidationPipe twice in a row (201 + 400 deterministic)", async () => {
    const workdir = await makeTempDir("bunest-p03-e2e-");
    await ensureDir(join(workdir, "src"));
    await ensureDir(join(workdir, "test"));

    const toPosix = (p: string) => p.replace(/\\/g, "/");
    await Bun.write(
      join(workdir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            paths: {
              "@bunest/core": [toPosix(join(REPO_ROOT, "packages/core/src/index.ts"))],
              "@bunest/core/*": [toPosix(join(REPO_ROOT, "packages/core/src/*"))],
              "@bunest/testing": [toPosix(join(REPO_ROOT, "packages/testing/src/index.ts"))],
              "@bunest/validation": [toPosix(join(REPO_ROOT, "packages/validation/src/index.ts"))],
              "@bunest/validation/*": [toPosix(join(REPO_ROOT, "packages/validation/src/*"))],
            },
          },
        },
        null,
        2,
      ),
    );

    // Write a real mini Bunest module with ValidationPipe DTO validation
    const moduleCode = [
      'import "@bunest/validation";',
      'import { Body, Controller, HttpCode, Module, Post } from "@bunest/core";',
      'import { IsInt, IsString, Min, MinLength } from "@bunest/validation/validator";',
      "",
      "export class CreateOrderDto {",
      "  @IsString()",
      "  @MinLength(2)",
      "  item!: string;",
      "",
      "  @IsInt()",
      "  @Min(1)",
      "  quantity!: number;",
      "}",
      "",
      '@Controller("orders")',
      "export class OrdersController {",
      "  @Post()",
      "  @HttpCode(201)",
      "  create(@Body() dto: CreateOrderDto) {",
      "    return {",
      "      id: crypto.randomUUID(),",
      "      createdAt: new Date().toISOString(),",
      '      status: "created",',
      "      item: dto.item,",
      "      quantity: dto.quantity,",
      "    };",
      "  }",
      "}",
      "",
      "@Module({",
      "  controllers: [OrdersController],",
      "})",
      "export class MiniOrdersModule {}",
      "",
    ].join("\n");

    await Bun.write(join(workdir, "src/orders.module.ts"), moduleCode);

    // Build a multi-case scenario (201 happy path with volatile id/createdAt + 400 validation failure)
    const scenario: RequestScenarioV1 = {
      schemaVersion: 1,
      name: "MiniOrdersModule POST /orders regression",
      method: "POST",
      path: "/orders",
      body: { item: "matcha", quantity: 3 },
      routeMeta: {
        module: "MiniOrdersModule",
        moduleImportPath: "../src/orders.module",
      },
      observedResponse: {
        status: 201,
        contentType: "application/json",
        body: {
          id: "123e4567-e89b-12d3-a456-426614174000",
          createdAt: "2026-11-26T18:00:00.000Z",
          status: "created",
          item: "matcha",
          quantity: 3,
        },
      },
      assertions: {
        status: 201,
      },
      cases: [
        {
          name: "POST /orders rejects invalid payload with 400",
          method: "POST",
          path: "/orders",
          body: { item: "x", quantity: 0 },
          assertions: {
            status: 400,
          },
        },
      ],
    };

    const generatedRel = "test/orders.regression.spec.ts";
    await runTestFromRequestCommand({
      cwd: workdir,
      scenario,
      out: generatedRel,
      useValidationPipe: true,
    });

    const generatedFull = join(workdir, generatedRel);
    expect(await fileExists(generatedFull)).toBe(true);

    // Run the generated test file TWICE in a row to prove determinism
    for (let run = 1; run <= 2; run++) {
      const proc = Bun.spawn([process.execPath, "test", generatedFull], {
        cwd: workdir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      expect(exitCode, `Run #${run} failed:\nstdout:\n${out}\nstderr:\n${err}`).toBe(0);
    }
  });

  it("sanitizes generated filename slugs strictly (no parentheses or special chars)", () => {
    const httpWithParens = [
      "### Create Orders (Valid - expects 201)",
      "POST http://localhost:3000/orders HTTP/1.1",
      "Content-Type: application/json",
      "",
      JSON.stringify({ item: "espresso", quantity: 2 }),
    ].join("\n");

    const parsed = parseHttpFileToScenarios(httpWithParens, "src/orders/orders.http");
    const plan = planTestFromRequest(parsed);
    expect(plan.files[0]!.relativePath).toBe(
      "test/create-orders-valid-expects-201.regression.spec.ts",
    );
    expect(plan.files[0]!.relativePath).not.toContain("(");
    expect(plan.files[0]!.relativePath).not.toContain(")");

    const messyPlan = planTestFromRequest({
      schemaVersion: 1,
      name: "  (Create) [Orders] -- @v2!! / #draft  ",
      method: "POST",
      path: "/orders",
      assertions: { status: 201 },
    });
    expect(messyPlan.files[0]!.relativePath).toBe(
      "test/create-orders-v2-draft.regression.spec.ts",
    );
    expect(messyPlan.files[0]!.relativePath).toMatch(
      /^test\/[a-z0-9]+(?:-[a-z0-9]+)*\.regression\.spec\.ts$/,
    );
  });

  it("wires ValidationPipe by default in beforeEach so generated .http tests return 400 on invalid DTO payloads without module-level APP_PIPE", async () => {
    const workdir = await makeTempDir("bunest-p03-default-valpipe-");
    await ensureDir(join(workdir, "src"));
    await ensureDir(join(workdir, "test"));

    const toPosix = (p: string) => p.replace(/\\/g, "/");
    await Bun.write(
      join(workdir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            paths: {
              "@bunest/core": [toPosix(join(REPO_ROOT, "packages/core/src/index.ts"))],
              "@bunest/core/*": [toPosix(join(REPO_ROOT, "packages/core/src/*"))],
              "@bunest/testing": [toPosix(join(REPO_ROOT, "packages/testing/src/index.ts"))],
              "@bunest/validation": [toPosix(join(REPO_ROOT, "packages/validation/src/index.ts"))],
              "@bunest/validation/*": [toPosix(join(REPO_ROOT, "packages/validation/src/*"))],
            },
          },
        },
        null,
        2,
      ),
    );

    // Module intentionally has NO APP_PIPE provider (like real apps that register ValidationPipe in src/main.ts)
    const moduleCode = [
      'import "@bunest/validation";',
      'import { Body, Controller, HttpCode, Module, Post } from "@bunest/core";',
      'import { IsInt, IsString, Min, MinLength } from "@bunest/validation/validator";',
      "",
      "export class CreateOrderDto {",
      "  @IsString()",
      "  @MinLength(2)",
      "  item!: string;",
      "",
      "  @IsInt()",
      "  @Min(1)",
      "  quantity!: number;",
      "}",
      "",
      '@Controller("orders")',
      "export class OrdersController {",
      "  @Post()",
      "  @HttpCode(201)",
      "  create(@Body() dto: CreateOrderDto) {",
      '    return { status: "created", item: dto.item, quantity: dto.quantity };',
      "  }",
      "}",
      "",
      "@Module({",
      "  controllers: [OrdersController],",
      "})",
      "export class AppModule {}",
      "",
    ].join("\n");

    await Bun.write(join(workdir, "src/app.module.ts"), moduleCode);

    const httpFile = [
      "### Create Orders (Valid - expects 201)",
      "POST http://localhost:3000/orders HTTP/1.1",
      "Content-Type: application/json",
      "",
      JSON.stringify({ item: "espresso", quantity: 2 }),
      "",
      "### Create Orders (Invalid - expects 400)",
      "POST http://localhost:3000/orders HTTP/1.1",
      "Content-Type: application/json",
      "",
      JSON.stringify({ item: "", quantity: 0 }),
      "",
    ].join("\n");

    await Bun.write(join(workdir, "orders.http"), httpFile);

    // Run WITHOUT useValidationPipe option and WITHOUT out option
    const res = await runTestFromRequestCommand({
      cwd: workdir,
      inputPath: "orders.http",
    });

    expect(res.exitCode).toBe(0);
    expect(res.files[0]!.relativePath).toBe(
      "test/create-orders-valid-expects-201.regression.spec.ts",
    );

    const generatedCode = res.plan.files[0]!.content;
    expect(generatedCode).toContain('import { ValidationPipe } from "@bunest/core";');
    expect(generatedCode).toContain(
      "app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));",
    );

    const generatedFull = join(workdir, res.files[0]!.relativePath);
    const proc = Bun.spawn([process.execPath, "test", generatedFull], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(exitCode, `Generated test failed:\nstdout:\n${out}\nstderr:\n${err}`).toBe(0);

    // Explicit opt-out still works
    const optOutPlan = planTestFromRequest(
      {
        schemaVersion: 1,
        name: "No validation pipe",
        method: "GET",
        path: "/health",
        assertions: { status: 200 },
      },
      { useValidationPipe: false },
    );
    expect(optOutPlan.files[0]!.content).not.toContain("ValidationPipe");
  });

  it("production-build dev-inspector absence check: enableDevDiagnostics() registers ZERO /__bunest/* routes when NODE_ENV=production", async () => {
    @Controller("health")
    class ProdHealthController {
      @Get()
      check() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [ProdHealthController],
    })
    class ProdAppModule {}

    const previousNodeEnv = process.env.NODE_ENV;
    try {
      // Under NODE_ENV=production, enableDevDiagnostics() must be a complete no-op
      process.env.NODE_ENV = "production";
      const prodApp = await BunestFactory.create(ProdAppModule, { logger: false });
      prodApp.enableDevDiagnostics();
      await prodApp.init();

      try {
        const healthRes = await prodApp.fetch(new Request("http://localhost/health"));
        expect(healthRes.status).toBe(200);

        for (const devPath of [
          "/__bunest/errors",
          "/__bunest/routes",
          "/__bunest/graph",
        ]) {
          const res = await prodApp.fetch(new Request(`http://localhost${devPath}`));
          expect(res.status, `Expected 404 for ${devPath} in production`).toBe(404);
        }
      } finally {
        await prodApp.close();
      }

      // Sanity check: under NODE_ENV=development, enableDevDiagnostics() mounts them
      process.env.NODE_ENV = "development";
      const devApp = await BunestFactory.create(ProdAppModule, { logger: false });
      devApp.enableDevDiagnostics();
      await devApp.init();

      try {
        const routesRes = await devApp.fetch(
          new Request("http://localhost/__bunest/routes"),
        );
        expect(routesRes.status).toBe(200);
      } finally {
        await devApp.close();
      }
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });
});
