import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller, Get, Injectable, Module } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  AbstractLoader,
  BunStaticLoader,
  DEFAULT_EXPRESS_RENDER_PATH,
  DEFAULT_FASTIFY_RENDER_PATH,
  DEFAULT_RENDER_PATH,
  DEFAULT_ROOT_PATH,
  NoopLoader,
  SERVE_STATIC_MODULE_OPTIONS,
  ServeStaticModule,
  createStaticAssetsMount,
  parseMaxAgeSeconds,
  serveStaticProviders,
  tryServeStaticAsset,
  type ServeStaticModuleAsyncOptions,
  type ServeStaticModuleOptions,
  type ServeStaticModuleOptionsFactory,
} from "../src";

describe("@bunest/serve-static drop-in facade (@nestjs/serve-static v12 Bun-native parity)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("exports all Bun-native ServeStatic symbols and constants", () => {
    expect(ServeStaticModule).toBeDefined();
    expect(AbstractLoader).toBeDefined();
    expect(BunStaticLoader).toBeDefined();
    expect(NoopLoader).toBeDefined();
    expect(Array.isArray(serveStaticProviders)).toBe(true);
    expect(SERVE_STATIC_MODULE_OPTIONS).toBe("SERVE_STATIC_MODULE_OPTIONS");
    expect(DEFAULT_ROOT_PATH).toBe("client");
    expect(DEFAULT_RENDER_PATH).toBe("*");
    expect(DEFAULT_EXPRESS_RENDER_PATH).toBe("{*any}");
    expect(DEFAULT_FASTIFY_RENDER_PATH).toBe("*");
    expect(typeof createStaticAssetsMount).toBe("function");
    expect(typeof tryServeStaticAsset).toBe("function");
    expect(parseMaxAgeSeconds("1h")).toBe(3600);
  });

  it("serves static files and SPA fallback via ServeStaticModule.forRoot() and forRootAsync()", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "bunest-serve-static-facade-"));
    tempDirs.push(rootDir);

    await writeFile(join(rootDir, "index.html"), "<html><body>SPA Shell</body></html>");
    await writeFile(join(rootDir, "hello.txt"), "Hello Bunest Static!");

    @Controller("/api")
    class ApiController {
      @Get("ping")
      ping() {
        return { pong: true };
      }
    }

    @Module({
      imports: [
        ServeStaticModule.forRoot({
          rootPath: rootDir,
          exclude: ["/api*"],
        }),
      ],
      controllers: [ApiController],
    })
    class StaticAppModule {}

    const app = await BunestFactory.create(StaticAppModule, { logger: false });
    try {
      const fileRes = await app.fetch(new Request("http://localhost/hello.txt"));
      expect(fileRes.status).toBe(200);
      expect(await fileRes.text()).toBe("Hello Bunest Static!");

      const spaRes = await app.fetch(new Request("http://localhost/dashboard/settings"));
      expect(spaRes.status).toBe(200);
      expect(await spaRes.text()).toContain("SPA Shell");

      const apiRes = await app.fetch(new Request("http://localhost/api/ping"));
      expect(apiRes.status).toBe(200);
      expect(await apiRes.json()).toEqual({ pong: true });
    } finally {
      await app.close();
    }

    // Also test forRootAsync with useClass
    @Injectable()
    class StaticConfigFactory implements ServeStaticModuleOptionsFactory {
      createLoggerOptions(): ServeStaticModuleOptions[] {
        return [{ rootPath: rootDir, serveRoot: "/assets" }];
      }
    }

    const asyncOpts: ServeStaticModuleAsyncOptions = { useClass: StaticConfigFactory };

    @Module({
      imports: [ServeStaticModule.forRootAsync(asyncOpts)],
    })
    class AsyncStaticAppModule {}

    const asyncApp = await BunestFactory.create(AsyncStaticAppModule, { logger: false });
    try {
      const assetRes = await asyncApp.fetch(new Request("http://localhost/assets/hello.txt"));
      expect(assetRes.status).toBe(200);
      expect(await assetRes.text()).toBe("Hello Bunest Static!");
    } finally {
      await asyncApp.close();
    }
  });
});
