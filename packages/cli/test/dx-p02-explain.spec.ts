import { afterEach, describe, expect, test } from "bun:test";
import {
  BunestFactory,
  Controller,
  Get,
  Injectable,
  Module,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  join,
  removePath,
  type CanActivate,
  type ExceptionFilter,
  type NestInterceptor,
  type PipeTransform,
} from "@bunest/core";
import {
  BunestStaticAnalyzer,
  explainRoute,
  parseRouteQuery,
  type RouteExplainReport,
} from "../src/analyzer";
import {
  formatRouteExplainReport,
  runExplainRouteCommand,
} from "../src/commands/explain";
import { BUNEST_MCP_TOOLS, handleMcpRequest } from "../src/commands/mcp";

const createdTempDirs: string[] = [];

async function createTempProject(
  files: Record<string, string>,
): Promise<string> {
  const dir = join(
    process.cwd(),
    ".tmp-dx-p02-explain-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8),
  );
  createdTempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await Bun.write(abs, content);
  }
  return dir;
}

afterEach(async () => {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("P0.2 Route & DI Explainer (dx-p02-explain)", () => {
  test("Fixture 1: missing provider export identifies controller, param, owner module, exportsLocation, and emits deterministic add-export quick fix", async () => {
    const dir = await createTempProject({
      "src/billing.service.ts": `
        import { Injectable } from "@bunest/core";
        @Injectable()
        export class BillingService {
          charge() { return true; }
        }
      `,
      "src/shared.module.ts": `
        import { Module } from "@bunest/core";
        import { BillingService } from "./billing.service";

        @Module({
          providers: [BillingService],
          exports: [],
        })
        export class SharedModule {}
      `,
      "src/auth.guard.ts": `
        import { Injectable } from "@bunest/core";
        @Injectable()
        export class AuthGuard {
          canActivate() { return true; }
        }
      `,
      "src/orders.controller.ts": `
        import { Controller, Get, Post, UseGuards, UsePipes, UseInterceptors, UseFilters, Version, Public, Param } from "@bunest/core";
        import { BillingService } from "./billing.service";
        import { AuthGuard } from "./auth.guard";

        @Controller("orders")
        @UseGuards(AuthGuard)
        export class OrdersController {
          constructor(private readonly billing: BillingService) {}

          @Post()
          @UsePipes(OrderValidationPipe)
          @UseInterceptors(LoggingInterceptor)
          @UseFilters(HttpExceptionFilter)
          create() {
            return this.billing.charge();
          }

          @Get(":id")
          @Version("1")
          @Public()
          findOne(@Param("id", ParseIntPipe) id: string) {
            return { id };
          }
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

    const result = await runExplainRouteCommand({
      cwd: dir,
      route: "POST /orders",
      format: "json",
      silent: true,
    });

    expect(result.exitCode).toBe(0);
    const report = result.report;
    expect(report.schemaVersion).toBe("1.0");
    expect(report.confirmationStatus).toBe("static-only");
    expect(report.query).toEqual({
      raw: "POST /orders",
      method: "POST",
      path: "/orders",
    });
    expect(report.matches).toHaveLength(1);

    const match = report.matches[0]!;
    expect(match.method).toBe("POST");
    expect(match.path).toBe("/orders");
    expect(match.module?.name).toBe("OrdersModule");
    expect(match.module?.importsLocation).toBeDefined();
    expect(match.controller.name).toBe("OrdersController");
    expect(match.controller.handlerName).toBe("create");
    expect(match.controller.location?.line).toBeGreaterThan(0);
    expect(match.controller.handlerLocation?.line).toBeGreaterThan(0);

    // Pipeline extraction
    expect(
      match.pipeline.map((p) => `${p.stage}:${p.name}:${p.scope}`),
    ).toEqual([
      "guard:AuthGuard:controller",
      "pipe:OrderValidationPipe:handler",
      "interceptor:LoggingInterceptor:handler",
      "filter:HttpExceptionFilter:handler",
    ]);

    // Missing export classification
    expect(match.dependencies).toHaveLength(1);
    const dep = match.dependencies[0]!;
    expect(dep.paramName).toBe("billing");
    expect(dep.token).toBe("BillingService");
    expect(dep.status).toBe("missing-export");
    expect(dep.ownerModules).toHaveLength(1);
    expect(dep.ownerModules[0]!.name).toBe("SharedModule");
    expect(dep.ownerModules[0]!.exported).toBe(false);
    expect(dep.ownerModules[0]!.importedByConsumer).toBe(true);
    expect(dep.ownerModules[0]!.exportsLocation?.line).toBeGreaterThan(0);

    // Deterministic add-export quick fix
    expect(report.quickFixes).toHaveLength(1);
    const fix = report.quickFixes[0]!;
    expect(fix.kind).toBe("add-export");
    expect(fix.deterministic).toBe(true);
    expect(fix.targetFile).toContain("shared.module.ts");
    expect(fix.edits.length).toBeGreaterThan(0);
    expect(fix.edits[0]!.newText).toContain("exports: [BillingService]");

    // Concrete path vs :param + versioned route matching + param pipe + @Public
    const getResult = await runExplainRouteCommand({
      cwd: dir,
      route: "GET /v1/orders/42",
      version: "1",
      format: "agent",
      silent: true,
    });
    expect(getResult.report.matches).toHaveLength(1);
    const getMatch = getResult.report.matches[0]!;
    expect(getMatch.controller.handlerName).toBe("findOne");
    expect(getMatch.version).toBe("1");
    expect(getMatch.controller.isPublic).toBe(true);
    expect(
      getMatch.pipeline.some(
        (p) => p.stage === "pipe" && p.name === "ParseIntPipe" && p.scope === "param",
      ),
    ).toBe(true);

    // Formatting modes
    const pretty = formatRouteExplainReport(report, "pretty", dir);
    expect(pretty).toContain("POST /orders");
    expect(pretty).toContain("missing-export");
    expect(pretty).toContain("add-export");
    const agent = formatRouteExplainReport(report, "agent", dir);
    expect(agent).toContain("SharedModule");
  });

  test("Fixture 2: duplicate token across two modules classifies ambiguous-token, lists both owners, and suppresses quick fix", async () => {
    const dir = await createTempProject({
      "src/payment-a.service.ts": `
        import { Injectable } from "@bunest/core";
        @Injectable()
        export class PaymentService {}
      `,
      "src/payment-b.service.ts": `
        import { Injectable } from "@bunest/core";
        @Injectable()
        export class PaymentService {}
      `,
      "src/module-a.ts": `
        import { Module } from "@bunest/core";
        import { PaymentService } from "./payment-a.service";
        @Module({ providers: [PaymentService], exports: [PaymentService] })
        export class ModuleA {}
      `,
      "src/module-b.ts": `
        import { Module } from "@bunest/core";
        import { PaymentService } from "./payment-b.service";
        @Module({ providers: [PaymentService], exports: [PaymentService] })
        export class ModuleB {}
      `,
      "src/orders.controller.ts": `
        import { Controller, Post } from "@bunest/core";
        import { PaymentService } from "./payment-a.service";
        @Controller("orders")
        export class OrdersController {
          constructor(private readonly payment: PaymentService) {}
          @Post()
          create() {}
        }
      `,
      "src/orders.module.ts": `
        import { Module } from "@bunest/core";
        import { ModuleA } from "./module-a";
        import { ModuleB } from "./module-b";
        import { OrdersController } from "./orders.controller";
        @Module({
          imports: [ModuleA, ModuleB],
          controllers: [OrdersController],
        })
        export class OrdersModule {}
      `,
    });

    const analyzer = new BunestStaticAnalyzer({ cwd: dir, sourceRoot: "src" });
    const snapshot = analyzer.analyze();

    // providersByName preserves duplicate provider declarations
    expect(snapshot.moduleGraph.providersByName.get("PaymentService")?.length).toBe(2);

    const report = await explainRoute({
      query: "POST /orders",
      sourceFiles: analyzer.getScanner().getTrackedSourceFiles(),
      moduleGraph: snapshot.moduleGraph,
      diagnostics: snapshot.diagnostics,
    });

    expect(report.matches).toHaveLength(1);
    const dep = report.matches[0]!.dependencies[0]!;
    expect(dep.status).toBe("ambiguous-token");
    expect(dep.ownerModules.map((o) => o.name).sort()).toEqual([
      "ModuleA",
      "ModuleB",
    ]);
    expect(report.quickFixes).toEqual([]);
  });

  test("Fixture 3: dynamic module and spread registrations populate unknowns and suppress unsafe quick fixes", async () => {
    const dir = await createTempProject({
      "src/dynamic.service.ts": `
        import { Injectable } from "@bunest/core";
        @Injectable()
        export class DynamicService {}
      `,
      "src/extra.ts": `
        export const extraProviders = [];
        export const ROUTE_PREFIX = "orders";
      `,
      "src/orders.controller.ts": `
        import { Controller, Post } from "@bunest/core";
        import { DynamicService } from "./dynamic.service";
        @Controller("orders")
        export class OrdersController {
          constructor(private readonly dyn: DynamicService) {}
          @Post()
          create() {}
        }
      `,
      "src/orders.module.ts": `
        import { Module } from "@bunest/core";
        import { OrdersController } from "./orders.controller";
        import { extraProviders } from "./extra";

        @Module({
          imports: [ConfigModule.forRoot({ isGlobal: true })],
          controllers: [OrdersController],
          providers: [...extraProviders],
        })
        export class OrdersModule {}
      `,
    });

    const result = await runExplainRouteCommand({
      cwd: dir,
      route: "POST /orders",
      format: "json",
      silent: true,
    });

    const report = result.report;
    expect(report.unknowns.length).toBeGreaterThanOrEqual(2);
    expect(report.unknowns.some((u) => u.kind === "dynamic-module")).toBe(true);
    expect(report.unknowns.some((u) => u.kind === "dynamic-provider")).toBe(
      true,
    );
    expect(report.matches).toHaveLength(1);
    expect(report.matches[0]!.dependencies[0]!.status).toBe("unknown-dynamic");
    expect(report.quickFixes).toEqual([]);
  });

  test("Bootstrap failure / unreachable server falls back cleanly to static-only with static trace intact", async () => {
    const dir = await createTempProject({
      "src/orders.service.ts": `
        import { Injectable } from "@bunest/core";
        @Injectable()
        export class OrdersService {}
      `,
      "src/orders.controller.ts": `
        import { Controller, Post } from "@bunest/core";
        import { OrdersService } from "./orders.service";
        @Controller("orders")
        export class OrdersController {
          constructor(private readonly orders: OrdersService) {}
          @Post()
          create() {}
        }
      `,
      "src/orders.module.ts": `
        import { Module } from "@bunest/core";
        import { OrdersController } from "./orders.controller";
        import { OrdersService } from "./orders.service";
        @Module({
          controllers: [OrdersController],
          providers: [OrdersService],
        })
        export class OrdersModule {}
      `,
    });

    // 1. Unreachable server (network error)
    const unreachableFetch = (async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:49999");
    }) as unknown as typeof fetch;

    const unreachableRes = await runExplainRouteCommand({
      cwd: dir,
      route: "POST /orders",
      serverUrl: "http://127.0.0.1:49999",
      fetch: unreachableFetch,
      silent: true,
    });

    expect(unreachableRes.report.confirmationStatus).toBe("static-only");
    expect(unreachableRes.report.runtime.attempted).toBe(true);
    expect(unreachableRes.report.runtime.reachable).toBe(false);
    expect(unreachableRes.report.runtime.bootstrapFailed).toBe(true);
    expect(unreachableRes.report.runtime.error).toContain("ECONNREFUSED");
    expect(unreachableRes.report.matches).toHaveLength(1);
    expect(unreachableRes.report.matches[0]!.dependencies[0]!.status).toBe(
      "resolved",
    );

    // 2. Server returns 503 bootstrap failed
    const bootstrapFailFetch = (async () =>
      Response.json(
        { error: "DI bootstrap failed: Missing export BillingService" },
        { status: 503 },
      )) as unknown as typeof fetch;

    const failRes = await runExplainRouteCommand({
      cwd: dir,
      route: "POST /orders",
      serverUrl: "http://127.0.0.1:3000",
      fetch: bootstrapFailFetch,
      silent: true,
    });

    expect(failRes.report.confirmationStatus).toBe("static-only");
    expect(failRes.report.runtime.attempted).toBe(true);
    expect(failRes.report.runtime.reachable).toBe(true);
    expect(failRes.report.runtime.bootstrapFailed).toBe(true);
    expect(failRes.report.runtime.error).toContain("DI bootstrap failed");
    expect(failRes.report.matches).toHaveLength(1);
  });

  test("Runtime-confirmed match and mismatch detection keep both static and runtime entries", async () => {
    const dir = await createTempProject({
      "src/orders.controller.ts": `
        import { Controller, Post, UseGuards } from "@bunest/core";
        @Controller("orders")
        @UseGuards(AuthGuard)
        export class OrdersController {
          @Post()
          create() {}
        }
      `,
      "src/orders.module.ts": `
        import { Module } from "@bunest/core";
        import { OrdersController } from "./orders.controller";
        @Module({ controllers: [OrdersController] })
        export class OrdersModule {}
      `,
    });

    // Runtime-confirmed mock server
    const confirmedFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/__bunest/routes")) {
        return Response.json(
          {
            count: 1,
            buildVersion: "build-42",
            routes: [
              {
                method: "POST",
                path: "/orders",
                controller: "OrdersController",
                handler: "create",
                module: "OrdersModule",
                guards: ["AuthGuard"],
                pipes: ["ValidationPipe"],
                interceptors: [],
                filters: [],
              },
            ],
          },
          { status: 200 },
        );
      }
      if (url.endsWith("/__bunest/graph")) {
        return Response.json({
          count: 1,
          modules: [
            {
              name: "OrdersModule",
              isGlobal: false,
              controllers: ["OrdersController"],
              providers: [],
              exports: [],
            },
          ],
        });
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const confirmed = await runExplainRouteCommand({
      cwd: dir,
      route: "POST /orders",
      serverUrl: "http://127.0.0.1:3000",
      fetch: confirmedFetch,
      silent: true,
    });

    expect(confirmed.report.confirmationStatus).toBe("runtime-confirmed");
    expect(confirmed.report.runtime.reachable).toBe(true);
    expect(confirmed.report.runtime.buildVersion).toBe("build-42");
    expect(confirmed.report.matches).toHaveLength(1);
    expect(confirmed.report.matches[0]!.source).toEqual({
      static: true,
      runtime: true,
    });
    expect(
      confirmed.report.matches[0]!.pipeline.map(
        (p) => `${p.stage}:${p.name}:${p.source}`,
      ),
    ).toEqual([
      "guard:AuthGuard:both",
      "pipe:ValidationPipe:runtime",
    ]);

    // Mismatch mock server (different handler at runtime -> keeps BOTH sides)
    const mismatchFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/__bunest/routes")) {
        return Response.json({
          count: 1,
          routes: [
            {
              method: "POST",
              path: "/orders",
              controller: "LegacyOrdersController",
              handler: "createLegacy",
              module: "LegacyOrdersModule",
              guards: [],
              pipes: [],
              interceptors: [],
              filters: [],
            },
          ],
        });
      }
      return Response.json({ count: 0, modules: [] });
    }) as unknown as typeof fetch;

    const mismatch = await runExplainRouteCommand({
      cwd: dir,
      route: "POST /orders",
      serverUrl: "http://127.0.0.1:3000",
      fetch: mismatchFetch,
      silent: true,
    });

    expect(mismatch.report.confirmationStatus).toBe("mismatch");
    expect(mismatch.report.matches).toHaveLength(2);
    expect(mismatch.report.matches[0]!.source).toEqual({
      static: true,
      runtime: false,
    });
    expect(mismatch.report.matches[0]!.controller.name).toBe(
      "OrdersController",
    );
    expect(mismatch.report.matches[1]!.source).toEqual({
      static: false,
      runtime: true,
    });
    expect(mismatch.report.matches[1]!.controller.name).toBe(
      "LegacyOrdersController",
    );
    expect(mismatch.report.quickFixes).toEqual([]);
  });

  test("MCP bunest_explain_route returns identical schemaVersion 1.0 JSON structure as CLI", async () => {
    const dir = await createTempProject({
      "src/billing.service.ts": `
        import { Injectable } from "@bunest/core";
        @Injectable()
        export class BillingService {}
      `,
      "src/shared.module.ts": `
        import { Module } from "@bunest/core";
        import { BillingService } from "./billing.service";
        @Module({ providers: [BillingService] })
        export class SharedModule {}
      `,
      "src/orders.controller.ts": `
        import { Controller, Post } from "@bunest/core";
        import { BillingService } from "./billing.service";
        @Controller("orders")
        export class OrdersController {
          constructor(private readonly billing: BillingService) {}
          @Post()
          create() {}
        }
      `,
      "src/orders.module.ts": `
        import { Module } from "@bunest/core";
        import { SharedModule } from "./shared.module";
        import { OrdersController } from "./orders.controller";
        @Module({ imports: [SharedModule], controllers: [OrdersController] })
        export class OrdersModule {}
      `,
    });

    expect(
      BUNEST_MCP_TOOLS.some((t) => t.name === "bunest_explain_route"),
    ).toBe(true);

    const cliRes = await runExplainRouteCommand({
      cwd: dir,
      route: "POST /orders",
      format: "json",
      silent: true,
    });

    const mcpRes = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "bunest_explain_route",
          arguments: { route: "POST /orders", format: "json" },
        },
      },
      { cwd: dir },
    );

    const content = (
      mcpRes?.result as { content: Array<{ type: string; text: string }> }
    ).content[0]!.text;
    const mcpReport = JSON.parse(content) as RouteExplainReport;

    expect(mcpReport.schemaVersion).toBe("1.0");
    expect(mcpReport).toEqual(cliRes.report);
  });

  test("Runtime GET /__bunest/routes exposes owning module and resolved guards/pipes/interceptors/filters (and stays skipped in production)", async () => {
    @Injectable()
    class DemoGuard implements CanActivate {
      canActivate() {
        return true;
      }
    }

    @Injectable()
    class DemoPipe implements PipeTransform {
      transform(v: unknown) {
        return v;
      }
    }

    @Injectable()
    class DemoInterceptor implements NestInterceptor {
      async intercept(_ctx: unknown, next: { handle(): Promise<unknown> }) {
        return next.handle();
      }
    }

    class DemoFilter implements ExceptionFilter {
      catch() {
        return new Response("err", { status: 500 });
      }
    }

    @Controller("demo")
    @UseGuards(DemoGuard)
    class DemoController {
      @Get("items")
      @UsePipes(DemoPipe)
      @UseInterceptors(DemoInterceptor)
      @UseFilters(DemoFilter)
      list() {
        return [];
      }
    }

    @Module({
      controllers: [DemoController],
      providers: [DemoGuard, DemoPipe, DemoInterceptor],
    })
    class DemoModule {}

    const app = await BunestFactory.create(DemoModule, { logger: false });
    app.enableDevDiagnostics();
    await app.init();

    const routesRes = await app.inject({ method: "GET", url: "/__bunest/routes" });
    expect(routesRes.statusCode).toBe(200);
    const body = routesRes.json<{
      count: number;
      routes: Array<{
        method: string;
        path: string;
        module?: string;
        guards?: string[];
        pipes?: string[];
        interceptors?: string[];
        filters?: string[];
      }>;
    }>();
    expect(body.count).toBe(1);
    expect(body.routes[0]).toMatchObject({
      method: "GET",
      path: "/demo/items",
      module: "DemoModule",
      guards: ["DemoGuard"],
      pipes: ["DemoPipe"],
      interceptors: ["DemoInterceptor"],
      filters: ["DemoFilter"],
    });
    await app.close();

    // Production guard check
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const prodApp = await BunestFactory.create(DemoModule, { logger: false });
      prodApp.enableDevDiagnostics();
      await prodApp.init();
      const prodRes = await prodApp.inject({
        method: "GET",
        url: "/__bunest/routes",
      });
      expect(prodRes.statusCode).toBe(404);
      await prodApp.close();
    } finally {
      if (prevEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prevEnv;
      }
    }
  });

  test("parseRouteQuery parses method + path and path-only queries", () => {
    expect(parseRouteQuery("POST /orders")).toEqual({
      raw: "POST /orders",
      method: "POST",
      path: "/orders",
    });
    expect(parseRouteQuery("/orders/123?foo=bar", "2")).toEqual({
      raw: "/orders/123?foo=bar",
      path: "/orders/123",
      version: "2",
    });
  });
});
