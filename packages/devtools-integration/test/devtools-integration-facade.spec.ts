import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Controller, Get, Injectable, Module } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  DEVTOOLS_OPTIONS,
  DevtoolsModule,
  DevtoolsService,
  GraphPublisher,
  type DevtoolsApplicationGraph,
  type DevtoolsModuleAsyncOptions,
  type DevtoolsModuleOptions,
  type DevtoolsOptionsFactory,
  type PublishGraphOptions,
} from "../src";

describe("@bunest/devtools-integration drop-in facade (@nestjs/devtools-integration v12 parity)", () => {
  it("exports DevtoolsModule, GraphPublisher, DevtoolsService, and DEVTOOLS_OPTIONS", () => {
    expect(DevtoolsModule).toBeDefined();
    expect(GraphPublisher).toBeDefined();
    expect(DevtoolsService).toBeDefined();
    expect(typeof DEVTOOLS_OPTIONS).toBe("symbol");
  });

  it("registers DevtoolsModule.register() & registerAsync(), serves /_devtools/graph, and publishes via GraphPublisher", async () => {
    @Controller("/demo")
    class DemoController {
      @Get("ping")
      ping() {
        return { ok: true };
      }
    }

    const opts: DevtoolsModuleOptions = {
      http: true,
      port: 8000,
      allowInProduction: true,
    };

    @Module({
      imports: [DevtoolsModule.register(opts)],
      controllers: [DemoController],
    })
    class DemoAppModule {}

    const app = await BunestFactory.create(DemoAppModule, {
      logger: false,
      snapshot: true,
    });
    try {
      const devtools = app.get(DevtoolsService);
      expect(devtools).toBeInstanceOf(DevtoolsService);

      const res = await app.fetch(new Request("http://localhost/_devtools/graph"));
      expect(res.status).toBe(200);
      const graph = (await res.json()) as DevtoolsApplicationGraph;
      expect(graph.modules.length).toBeGreaterThan(0);
      expect(graph.routes.some((r) => r.fullPath === "/demo/ping")).toBe(true);

      let uploadedUrl = "";
      let uploadedPayload: Record<string, unknown> = {};
      const publishOpts: PublishGraphOptions = {
        apiKey: "test-key",
        owner: "bunest",
        repository: "demo",
        branch: "main",
        trigger: "push",
        sha: "deadbeef",
        endpoint: "https://devtools.local",
        fetch: async (url, init) => {
          uploadedUrl = url;
          uploadedPayload = JSON.parse(String(init.body));
          return Response.json({
            previewUrl: "https://devtools.local/p/1",
            reportUrl: "https://devtools.local/r/1",
          });
        },
      };

      const publisher = new GraphPublisher(app);
      await publisher.publish(publishOpts);
      expect(uploadedUrl).toBe(
        "https://devtools.local/organizations/bunest/projects/demo/builds",
      );
      expect(uploadedPayload.hash).toBe("deadbeef");
      expect(typeof uploadedPayload.snapshot).toBe("string");
    } finally {
      await app.close();
    }

    // registerAsync via useClass
    @Injectable()
    class DevtoolsFactory implements DevtoolsOptionsFactory {
      createDevtoolsOptions(): DevtoolsModuleOptions {
        return { http: true, allowInProduction: true };
      }
    }

    const asyncOpts: DevtoolsModuleAsyncOptions = { useClass: DevtoolsFactory };

    @Module({
      imports: [DevtoolsModule.registerAsync(asyncOpts)],
    })
    class AsyncDevtoolsApp {}

    const asyncApp = await BunestFactory.create(AsyncDevtoolsApp, { logger: false });
    try {
      expect(asyncApp.get(DevtoolsService)).toBeInstanceOf(DevtoolsService);
      const res = await asyncApp.fetch(new Request("http://localhost/_devtools/routes"));
      expect(res.status).toBe(200);
    } finally {
      await asyncApp.close();
    }
  });
});
