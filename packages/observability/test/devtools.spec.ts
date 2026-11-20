import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  BunestFactory,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Scope,
  UseGuards,
  type CanActivate,
} from "@bunest/core";
import {
  DevtoolsModule,
  DevtoolsService,
  type DevtoolsApplicationGraph,
} from "../src";

describe("DevtoolsModule & DevtoolsService Introspection", () => {
  it("introspects modules, re-exports, providers, dependencies, controllers, routes, Mermaid graph, and enforces production security gate", async () => {
    @Injectable()
    class AuthGuard implements CanActivate {
      canActivate() {
        return true;
      }
    }

    @Injectable()
    class DbConnection {}

    @Module({ providers: [DbConnection], exports: [DbConnection] })
    class DbModule {}

    @Module({ imports: [DbModule], exports: [DbModule] })
    class DataLayerModule {}

    @Injectable()
    class UsersService {
      constructor(public readonly db: DbConnection) {}
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestAudit {}

    @Controller("/users")
    @UseGuards(AuthGuard)
    class UsersController {
      constructor(public readonly users: UsersService) {}

      @Get(":id")
      @HttpCode(200)
      findOne(@Param("id", ParseIntPipe) id: number) {
        return { id };
      }
    }

    @Module({
      imports: [DataLayerModule],
      controllers: [UsersController],
      providers: [UsersService, RequestAudit, AuthGuard],
    })
    class UsersModule {}

    @Module({
      imports: [UsersModule, DevtoolsModule.forRoot()],
    })
    class AppModule {}

    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const app = await BunestFactory.create(AppModule, { logger: false });
    const devtools = app.get(DevtoolsService);
    devtools.attachApplication(app);

    try {
      // 1. /_devtools/graph JSON endpoint
      const graphRes = await app.fetch(
        new Request("http://localhost/_devtools/graph"),
      );
      expect(graphRes.status).toBe(200);
      const graph = (await graphRes.json()) as DevtoolsApplicationGraph;

      const modNames = graph.modules.map((m) => m.name);
      expect(modNames).toContain("AppModule");
      expect(modNames).toContain("UsersModule");
      expect(modNames).toContain("DataLayerModule");
      expect(modNames).toContain("DbModule");

      // Re-export edge captured
      expect(graph.edges.some((e) => e.type === "re-export")).toBe(true);
      expect(graph.edges.some((e) => e.type === "import")).toBe(true);
      expect(graph.edges.some((e) => e.type === "provider-dependency")).toBe(
        true,
      );

      // Provider metadata (scope, exported flag, dependencies)
      const usersSvcNode = graph.providers.find(
        (p) => p.token === "UsersService",
      );
      expect(usersSvcNode).toBeDefined();
      expect(usersSvcNode?.scope).toBe(Scope.SINGLETON);
      expect(usersSvcNode?.dependencies).toContain("DbConnection");

      const auditNode = graph.providers.find((p) => p.token === "RequestAudit");
      expect(auditNode?.scope).toBe(Scope.REQUEST);

      const dbNode = graph.providers.find((p) => p.token === "DbConnection");
      expect(dbNode?.isExported).toBe(true);

      // Route metadata (params, guards, controller)
      const routesRes = await app.fetch(
        new Request("http://localhost/_devtools/routes"),
      );
      expect(routesRes.status).toBe(200);
      const { routes } = (await routesRes.json()) as {
        routes: DevtoolsApplicationGraph["routes"];
      };
      const userRoute = routes.find((r) => r.fullPath === "/users/:id");
      expect(userRoute).toBeDefined();
      expect(userRoute?.method).toBe("GET");
      expect(userRoute?.controller).toBe("UsersController");
      expect(userRoute?.handler).toBe("findOne");
      expect(userRoute?.guards).toContain("AuthGuard");
      expect(userRoute?.parameters[0]).toMatchObject({
        index: 0,
        source: "param",
        key: "id",
        metatype: "Number",
      });

      // 2. Mermaid flowchart LR output
      const mermaidRes = await app.fetch(
        new Request("http://localhost/_devtools/mermaid"),
      );
      expect(mermaidRes.status).toBe(200);
      const mermaid = await mermaidRes.text();
      expect(mermaid.startsWith("flowchart LR")).toBe(true);
      expect(mermaid).toContain("AppModule");
      expect(mermaid).toContain("DataLayerModule");
      expect(mermaid).toContain("-.->|re-export|");
      expect(mermaid).toContain("-->|injects|");

      // 3. Production security gate blocks all devtools endpoints by default!
      process.env.NODE_ENV = "production";
      expect(
        (await app.fetch(new Request("http://localhost/_devtools/graph")))
          .status,
      ).toBe(403);
      expect(
        (await app.fetch(new Request("http://localhost/_devtools/routes")))
          .status,
      ).toBe(403);
      expect(
        (await app.fetch(new Request("http://localhost/_devtools/mermaid")))
          .status,
      ).toBe(403);
    } finally {
      process.env.NODE_ENV = prevEnv;
      await app.close();
    }
  });

  it("auto-discovers module graph via public DiscoveryService without calling attachApplication()", async () => {
    @Injectable()
    class HealthRepo {}

    @Controller("/ping")
    class PingController {
      constructor(public readonly repo: HealthRepo) {}
      @Get()
      ping() {
        return { pong: true };
      }
    }

    @Module({
      imports: [DevtoolsModule.forRoot({ exposeEndpoints: false })],
      controllers: [PingController],
      providers: [HealthRepo],
    })
    class StandaloneDevtoolsModule {}

    const app = await BunestFactory.create(StandaloneDevtoolsModule, {
      logger: false,
    });
    try {
      const devtools = app.get(DevtoolsService);
      // Do NOT call devtools.attachApplication(app) — DiscoveryService resolves modules automatically!
      const graph = devtools.getGraph();
      expect(graph.modules.some((m) => m.name === "StandaloneDevtoolsModule")).toBe(true);
      expect(graph.providers.some((p) => p.token === "HealthRepo")).toBe(true);
      expect(graph.routes.some((r) => r.fullPath === "/ping")).toBe(true);
    } finally {
      await app.close();
    }
  });
});
