import { afterEach, describe, expect, it } from "bun:test";
import { BunestStaticAnalyzer } from "@bunest/cli";
import {
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
} from "@bunest/core";
import {
  MockDiagnostic,
  MockRange,
  MockWorkspaceEdit,
  createMockTextDocument,
  vscodeMockState,
} from "./vscode-mock";

const createMockDoc = createMockTextDocument;

const {
  buildExplainReportHtml,
  buildQuickFixWorkspaceEdit,
  collectDirtyBufferPaths,
  executeExplainRouteForEntry,
  formatExplainReportMarkdown,
  unwrapRouteTarget,
} = await import("../src/commands/explain-route");
const { BunestCodeLensProvider } = await import(
  "../src/providers/codelens.provider"
);
const { BunestCodeActionsProvider } = await import(
  "../src/providers/code-actions.provider"
);
const {
  buildPlannedFilesWorkspaceEdit,
  detectUnsavedRouteBuffers,
  extractCandidateResponseFields,
  isBinaryOrStreamContentType,
  planHttpExchangeAsTest,
} = await import("../src/webview/save-as-test");

const tempDirs: string[] = [];

function createTempProject(files: Record<string, string>): string {
  const dir = join(
    process.cwd(),
    ".tmp-vscode-dx-test-" +
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2, 8),
  );
  mkdirSyncPath(dir, { recursive: true });
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    const parent = full.slice(0, Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\")));
    mkdirSyncPath(parent, { recursive: true });
    writeTextSync(full, content);
  }
  return dir;
}

afterEach(() => {
  vscodeMockState.openDocuments = [];
  vscodeMockState.configValues = {};
  for (const d of tempDirs.splice(0)) {
    try {
      removePath(d, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe("P0.2 VS Code Integration: Explain Route, CodeLens & BUNEST001 Quick Fix", () => {
  it("unwraps route targets and collects dirty file buffers", () => {
    const fakeRoute = {
      key: "GET /orders",
      method: "GET",
      path: "/orders",
      controllerName: "OrdersController",
      handlerName: "list",
      bodyTypeText: "unknown",
      responseTypeText: "Promise<unknown>",
    } as never;

    expect(unwrapRouteTarget(fakeRoute)).toBe(fakeRoute);
    expect(unwrapRouteTarget({ route: fakeRoute })).toBe(fakeRoute);
    expect(unwrapRouteTarget(undefined)).toBeUndefined();

    const dirtyDoc = createMockDoc("/app/src/orders.controller.ts", "// dirty", true);
    const cleanDoc = createMockDoc("/app/src/app.module.ts", "// clean", false);
    const dirtyPaths = collectDirtyBufferPaths([dirtyDoc, cleanDoc] as never);
    expect(dirtyPaths).toEqual(["/app/src/orders.controller.ts"]);
  });

  it("explains a route, falls back cleanly to static-only on unreachable server, formats clickable locations, and builds undoable WorkspaceEdit for add-export", async () => {
    const cwd = createTempProject({
      "src/shared.service.ts": `
        import { Injectable } from "@bunest/core";
        @Injectable()
        export class SharedService {}
      `,
      "src/shared.module.ts": `
        import { Module } from "@bunest/core";
        import { SharedService } from "./shared.service";
        @Module({
          providers: [SharedService],
        })
        export class SharedModule {}
      `,
      "src/orders.controller.ts": `
        import { Controller, Get } from "@bunest/core";
        import { SharedService } from "./shared.service";
        @Controller("orders")
        export class OrdersController {
          constructor(private readonly shared: SharedService) {}
          @Get()
          list() { return []; }
        }
      `,
      "src/orders.module.ts": `
        import { Module } from "@bunest/core";
        import { SharedModule } from "./shared.module";
        import { OrdersController } from "./orders.controller";
        @Module({
          imports: [SharedModule],
          controllers: [OrdersController],
        })
        export class OrdersModule {}
      `,
    });

    const analyzer = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" });
    const snapshot = analyzer.analyze();
    const route = snapshot.scan.routes.find((r) => r.path === "/orders")!;
    expect(route).toBeDefined();

    const ctx = {
      cwd,
      sourceRoot: "src",
      analyzer,
      snapshot,
    } as never;

    const unreachableFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const report = await executeExplainRouteForEntry(ctx, route, {
      serverUrl: "http://127.0.0.1:3999",
      dirtyBuffers: [join(cwd, "src/orders.controller.ts")],
      fetch: unreachableFetch,
    });

    expect(report.schemaVersion).toBe("1.0");
    expect(report.confirmationStatus).toBe("static-only");
    expect(report.runtime.attempted).toBe(true);
    expect(report.runtime.reachable).toBe(false);
    expect(report.dirtyBuffers).toEqual([join(cwd, "src/orders.controller.ts")]);
    expect(report.matches.length).toBe(1);

    const addExportFix = report.quickFixes.find((q) => q.kind === "add-export");
    expect(addExportFix).toBeDefined();
    expect(addExportFix!.title).toContain("SharedService");
    expect(addExportFix!.title).toContain("SharedModule");

    const md = formatExplainReportMarkdown(report, cwd);
    expect(md).toContain("GET /orders");
    expect(md).toContain("static-only");
    expect(md).toContain("src/orders.controller.ts:");

    const { html, locations } = buildExplainReportHtml(report, cwd);
    expect(html).toContain("loc-link");
    expect(html).toContain("Apply Fix (Undoable)");
    expect(locations.length).toBeGreaterThan(0);

    const wsEdit = buildQuickFixWorkspaceEdit(addExportFix!, []);
    expect(wsEdit).toBeDefined();
    const edits = (wsEdit as unknown as MockWorkspaceEdit).edits;
    expect(edits.length).toBe(1);
    expect(edits[0]!.text).toContain("exports: [SharedService]");
  });

  it("adds Explain CodeLens alongside Send and Copy URL on HTTP routes", () => {
    const cwd = createTempProject({
      "src/items.controller.ts": `
        import { Controller, Get } from "@bunest/core";
        @Controller("items")
        export class ItemsController {
          @Get(":id")
          findOne() { return {}; }
        }
      `,
    });

    const analyzer = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" });
    const snapshot = analyzer.analyze();
    const ctrlFile = join(cwd, "src/items.controller.ts");

    const fakeIndex = {
      onDidUpdate: () => ({ dispose: () => {} }),
      getContextForFile: () => ({ cwd, analyzer, snapshot }),
    } as never;

    const provider = new BunestCodeLensProvider(fakeIndex);
    const doc = createMockDoc(ctrlFile, "");
    const lenses = provider.provideCodeLenses(doc as never);
    const commands = lenses.map((l) => l.command?.command);

    expect(commands).toContain("bunest.sendRequest");
    expect(commands).toContain("bunest.copyRouteUrl");
    expect(commands).toContain("bunest.explainRoute");
  });

  it("offers deterministic addExportToModule quick fix for BUNEST001 only when a single imported owner module exists", () => {
    // Case A: Single imported owner module -> offers Export quick fix as preferred
    const cwdSingle = createTempProject({
      "src/shared.service.ts": `
        import { Injectable } from "@bunest/core";
        @Injectable()
        export class SharedService {}
      `,
      "src/shared.module.ts": `
        import { Module } from "@bunest/core";
        import { SharedService } from "./shared.service";
        @Module({
          providers: [SharedService],
        })
        export class SharedModule {}
      `,
      "src/orders.controller.ts": `
        import { Controller, Get } from "@bunest/core";
        import { SharedService } from "./shared.service";
        @Controller("orders")
        export class OrdersController {
          constructor(private readonly shared: SharedService) {}
          @Get()
          list() { return []; }
        }
      `,
      "src/orders.module.ts": `
        import { Module } from "@bunest/core";
        import { SharedModule } from "./shared.module";
        import { OrdersController } from "./orders.controller";
        @Module({
          imports: [SharedModule],
          controllers: [OrdersController],
        })
        export class OrdersModule {}
      `,
    });

    const analyzerA = new BunestStaticAnalyzer({ cwd: cwdSingle, sourceRoot: "src" });
    const snapA = analyzerA.analyze();
    const b001A = snapA.diagnostics.find((d) => d.code === "BUNEST001")!;
    expect(b001A).toBeDefined();

    const ctrlPathA = b001A.location.filePath;
    const ctrlDocA = createMockDoc(
      ctrlPathA,
      analyzerA.getSourceFile(ctrlPathA)!.getFullText(),
    );
    const vDiagA = new MockDiagnostic(
      new MockRange(b001A.location.line - 1, 0, b001A.location.line - 1, 10),
      b001A.message,
      0,
    );
    vDiagA.source = "bunest";
    vDiagA.code = "BUNEST001";

    const codeActionsA = new BunestCodeActionsProvider({
      getContextForFile: () => ({ cwd: cwdSingle, analyzer: analyzerA, snapshot: snapA }),
    } as never);
    const actsA = codeActionsA.provideCodeActions(
      ctrlDocA as never,
      vDiagA.range as never,
      { diagnostics: [vDiagA] } as never,
    );

    const exportActA = actsA.find((a) =>
      a.title.includes("Export SharedService from SharedModule"),
    );
    expect(exportActA).toBeDefined();
    expect(exportActA!.isPreferred).toBe(true);
    const exportEdits = (exportActA!.edit as unknown as MockWorkspaceEdit).edits;
    expect(exportEdits[0]!.text).toContain("exports: [SharedService]");

    // Case B: Ambiguous (two modules provide SharedService) -> must NOT offer addExportToModule
    const cwdAmbig = createTempProject({
      "src/shared.service.ts": `
        import { Injectable } from "@bunest/core";
        @Injectable()
        export class SharedService {}
      `,
      "src/shared-a.module.ts": `
        import { Module } from "@bunest/core";
        import { SharedService } from "./shared.service";
        @Module({ providers: [SharedService] })
        export class SharedAModule {}
      `,
      "src/shared-b.module.ts": `
        import { Module } from "@bunest/core";
        import { SharedService } from "./shared.service";
        @Module({ providers: [SharedService] })
        export class SharedBModule {}
      `,
      "src/orders.controller.ts": `
        import { Controller, Get } from "@bunest/core";
        import { SharedService } from "./shared.service";
        @Controller("orders")
        export class OrdersController {
          constructor(private readonly shared: SharedService) {}
          @Get()
          list() { return []; }
        }
      `,
      "src/orders.module.ts": `
        import { Module } from "@bunest/core";
        import { SharedAModule } from "./shared-a.module";
        import { SharedBModule } from "./shared-b.module";
        import { OrdersController } from "./orders.controller";
        @Module({
          imports: [SharedAModule, SharedBModule],
          controllers: [OrdersController],
        })
        export class OrdersModule {}
      `,
    });

    const analyzerB = new BunestStaticAnalyzer({ cwd: cwdAmbig, sourceRoot: "src" });
    const snapB = analyzerB.analyze();
    const b001B = snapB.diagnostics.find((d) => d.code === "BUNEST001")!;
    expect(b001B).toBeDefined();

    const ctrlPathB = b001B.location.filePath;
    const ctrlDocB = createMockDoc(
      ctrlPathB,
      analyzerB.getSourceFile(ctrlPathB)!.getFullText(),
    );
    const vDiagB = new MockDiagnostic(
      new MockRange(b001B.location.line - 1, 0, b001B.location.line - 1, 10),
      b001B.message,
      0,
    );
    vDiagB.source = "bunest";
    vDiagB.code = "BUNEST001";

    const codeActionsB = new BunestCodeActionsProvider({
      getContextForFile: () => ({ cwd: cwdAmbig, analyzer: analyzerB, snapshot: snapB }),
    } as never);
    const actsB = codeActionsB.provideCodeActions(
      ctrlDocB as never,
      vDiagB.range as never,
      { diagnostics: [vDiagB] } as never,
    );

    expect(actsB.some((a) => a.title.includes("Export SharedService"))).toBe(
      false,
    );
  });
});

describe("P0.3 VS Code Integration: HTTP Studio Save as Test", () => {
  it("detects binary and stream Content-Type values accurately", () => {
    expect(isBinaryOrStreamContentType("application/octet-stream")).toBe(true);
    expect(isBinaryOrStreamContentType("image/png")).toBe(true);
    expect(isBinaryOrStreamContentType("image/jpeg; charset=binary")).toBe(true);
    expect(isBinaryOrStreamContentType("application/pdf")).toBe(true);
    expect(isBinaryOrStreamContentType("text/event-stream; charset=utf-8")).toBe(true);
    expect(isBinaryOrStreamContentType("multipart/form-data; boundary=abc")).toBe(true);
    expect(isBinaryOrStreamContentType("application/json; charset=utf-8")).toBe(false);
    expect(isBinaryOrStreamContentType("text/plain")).toBe(false);
    expect(isBinaryOrStreamContentType(undefined)).toBe(false);
  });

  it("extracts candidate response fields and distinguishes stable vs volatile fields", () => {
    const fields = extractCandidateResponseFields({
      id: "550e8400-e29b-41d4-a716-446655440000",
      status: "created",
      total: 42,
      createdAt: "2026-11-26T10:00:00.000Z",
      customer: { name: "Ada" },
    });

    const byPath = new Map(fields.map((f) => [f.path, f]));
    expect(byPath.get("id")?.isVolatile).toBe(true);
    expect(byPath.get("createdAt")?.isVolatile).toBe(true);
    expect(byPath.get("status")?.isVolatile).toBe(false);
    expect(byPath.get("total")?.isVolatile).toBe(false);
    expect(byPath.get("customer.name")?.isVolatile).toBe(false);
  });

  it("builds RequestScenarioV1 with unsavedBuffer propagation and delegates to @bunest/cli planTestFromRequest()", () => {
    const cwd = createTempProject({
      "src/orders/orders.controller.ts": "export class OrdersController {}",
    });
    const controllerFile = join(cwd, "src/orders/orders.controller.ts");
    const dirtyDoc = createMockDoc(controllerFile, "// edited", true);

    expect(detectUnsavedRouteBuffers(controllerFile, [], [dirtyDoc] as never)).toBe(
      true,
    );

    const { scenario, plan } = planHttpExchangeAsTest(
      {
        method: "POST",
        url: "http://localhost:3000/orders?dry=1",
        requestHeaders: {
          "Content-Type": "application/json",
          Authorization: "Bearer super-secret-prod-token-12345",
        },
        requestBody: JSON.stringify({
          item: "widget",
          password: "my-real-password",
        }),
        status: 201,
        responseContentType: "application/json",
        responseHeaders: { "content-type": "application/json" },
        responseJsonBody: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          status: "created",
          item: "widget",
        },
        responseRawBody: '{"id":"550e8400-e29b-41d4-a716-446655440000","status":"created","item":"widget"}',
        isBinaryOrStream: false,
        sizeBytes: 84,
        route: {
          key: "POST /orders",
          method: "POST",
          path: "/orders",
          controllerName: "OrdersController",
          handlerName: "create",
          bodyTypeText: "CreateOrderDto",
          responseTypeText: "Promise<Order>",
          location: {
            filePath: controllerFile,
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 1,
            start: 0,
            end: 0,
          },
        } as never,
      },
      {
        cwd,
        assertFields: ["status", "item"],
        documents: [dirtyDoc] as never,
      },
    );

    expect(scenario.schemaVersion).toBe(1);
    expect(scenario.routeMeta?.unsavedBuffer).toBe(true);
    expect(scenario.query).toEqual({ dry: "1" });
    expect(plan.schemaVersion).toBe("1.0");
    expect(plan.files.length).toBe(1);
    expect(plan.sanitized.length).toBeGreaterThanOrEqual(2);
    expect(plan.warnings.some((w) => /unsaved/i.test(w))).toBe(true);

    const content = plan.files[0]!.content;
    // Secrets must never leak into the generated test
    expect(content).not.toContain("super-secret-prod-token-12345");
    expect(content).not.toContain("my-real-password");
    expect(content).toContain("FIXTURE_AUTH_TOKEN");
    expect(content).toContain("expect(res.status).toBe(201)");
    expect(content).toContain('"created"');

    // WorkspaceEdit for native Undo
    const wsEdit = buildPlannedFilesWorkspaceEdit(cwd, plan);
    const edits = (wsEdit as unknown as MockWorkspaceEdit).edits;
    expect(edits.some((e) => e.kind === "createFile")).toBe(true);
    expect(edits.some((e) => e.kind === "insert" && e.text === content)).toBe(true);
  });

  it("handles binary responses without inlining bytes by default and supports opt-in binary fixture", () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const exchange = {
      method: "GET",
      url: "http://localhost:3000/exports/report.png",
      requestHeaders: {},
      status: 200,
      responseContentType: "image/png",
      responseHeaders: { "content-type": "image/png" },
      responseRawBody: pngBytes,
      isBinaryOrStream: true,
      sizeBytes: pngBytes.byteLength,
    };

    const defaultPlan = planHttpExchangeAsTest(exchange, {
      saveBinaryFixture: false,
    }).plan;
    expect(defaultPlan.files.length).toBe(1);
    expect(defaultPlan.binaryFixtureSuggestion).toBeDefined();
    expect(defaultPlan.files[0]!.content).toContain("image/png");

    const optInPlan = planHttpExchangeAsTest(exchange, {
      saveBinaryFixture: true,
    }).plan;
    expect(optInPlan.files.length).toBe(2);
    expect(optInPlan.files[1]!.relativePath).toBe(
      defaultPlan.binaryFixtureSuggestion!.suggestedPath,
    );
  });
});
