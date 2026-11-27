import { describe, expect, spyOn, test } from "bun:test";
import {
  Body,
  BunestFactory,
  Controller,
  Get,
  Logger,
  Module,
  Param,
  Post,
  VERSION_NEUTRAL,
  Version,
  VersioningType,
} from "@bunest/core";
import {
  ApiOperation,
  ApiProperty,
  DocumentBuilder,
  SwaggerModule,
  renderSwaggerHtml,
  type OpenApiDocument,
} from "../src/index";

class UserV1Dto {
  @ApiProperty({ example: "1" })
  id!: string;

  @ApiProperty({ example: "Ada" })
  name!: string;
}

class UserV2Dto {
  @ApiProperty({ example: "1" })
  id!: string;

  @ApiProperty({ example: "Ada Lovelace" })
  fullName!: string;

  @ApiProperty({ example: "ada@bunest.dev" })
  email!: string;
}

class CreateUserV2Dto {
  @ApiProperty({ example: "Ada Lovelace" })
  fullName!: string;
}

class HealthDto {
  @ApiProperty({ example: "ok" })
  status!: string;
}

@Controller("/users")
class VersionedUsersController {
  @Version("1")
  @Get(":id")
  @ApiOperation({ summary: "Get user v1" })
  getUserV1(@Param("id") _id: string): UserV1Dto {
    return { id: "1", name: "Ada" };
  }

  @Version("2")
  @Get(":id")
  @ApiOperation({ summary: "Get user v2" })
  getUserV2(@Param("id") _id: string): UserV2Dto {
    return { id: "1", fullName: "Ada Lovelace", email: "ada@bunest.dev" };
  }

  @Version(["1", "2"])
  @Get()
  @ApiOperation({ summary: "List users (v1 & v2)" })
  listUsers(): UserV1Dto[] {
    return [];
  }

  @Version("2")
  @Post()
  @ApiOperation({ summary: "Create user v2 only" })
  createUserV2(@Body() _body: CreateUserV2Dto): UserV2Dto {
    return { id: "2", fullName: "Grace", email: "grace@bunest.dev" };
  }
}

@Controller("/health")
class HealthController {
  @Version(VERSION_NEUTRAL)
  @Get()
  @ApiOperation({ summary: "Health check" })
  check(): HealthDto {
    return { status: "ok" };
  }
}

@Module({
  controllers: [VersionedUsersController, HealthController],
})
class VersionedAppModule {}

describe("Swagger API Versioning", () => {
  test("createDocument filters by version and includeVersionNeutral across URI, HEADER, MEDIA_TYPE, and CUSTOM strategies", async () => {
    const config = new DocumentBuilder()
      .setTitle("Versioned Users API")
      .setDescription("Multi-version API")
      .setVersion("1.0")
      .build();

    // 1. URI versioning
    const uriApp = await BunestFactory.create(VersionedAppModule, {
      logger: false,
    });
    uriApp.enableVersioning({ type: VersioningType.URI, prefix: "v" });
    try {
      const v1Doc = SwaggerModule.createDocument(uriApp, config, {
        version: "1",
      });
      expect(Object.keys(v1Doc.paths).sort()).toEqual([
        "/health",
        "/v1/users",
        "/v1/users/{id}",
      ]);
      expect(v1Doc.paths["/v1/users/{id}"]?.get?.summary).toBe("Get user v1");
      expect(v1Doc.paths["/v2/users"]).toBeUndefined();
      expect(v1Doc.paths["/v2/users/{id}"]).toBeUndefined();

      const v1NoNeutral = SwaggerModule.createDocument(uriApp, config, {
        version: "1",
        includeVersionNeutral: false,
      });
      expect(Object.keys(v1NoNeutral.paths).sort()).toEqual([
        "/v1/users",
        "/v1/users/{id}",
      ]);
      expect(v1NoNeutral.paths["/health"]).toBeUndefined();

      const v2Doc = SwaggerModule.createDocument(uriApp, config, {
        version: "2",
      });
      expect(Object.keys(v2Doc.paths).sort()).toEqual([
        "/health",
        "/v2/users",
        "/v2/users/{id}",
      ]);
      expect(v2Doc.paths["/v2/users/{id}"]?.get?.summary).toBe("Get user v2");
      expect(v2Doc.paths["/v2/users"]?.post?.summary).toBe("Create user v2 only");
      expect(v2Doc.paths["/v1/users"]).toBeUndefined();
    } finally {
      await uriApp.close();
    }

    // 2. HEADER versioning
    const headerApp = await BunestFactory.create(VersionedAppModule, {
      logger: false,
    });
    headerApp.enableVersioning({
      type: VersioningType.HEADER,
      header: "X-API-Version",
    });
    try {
      const v1Doc = SwaggerModule.createDocument(headerApp, config, {
        version: "1",
      });
      const v2Doc = SwaggerModule.createDocument(headerApp, config, {
        version: "2",
        includeVersionNeutral: false,
      });

      expect(v1Doc.paths["/health"]?.get).toBeDefined();
      expect(v1Doc.paths["/users/{id}"]?.get?.summary).toBe("Get user v1");
      const v1HeaderParam = v1Doc.paths["/users/{id}"]?.get?.parameters?.find(
        (p) => p.in === "header" && p.name === "X-API-Version",
      );
      expect(v1HeaderParam?.required).toBe(true);
      expect(v1HeaderParam?.schema?.enum).toEqual(["1"]);
      expect(v1HeaderParam?.schema?.default).toBe("1");

      // Multi-version route filtered to v1 restricts enum to ["1"]
      const v1ListParam = v1Doc.paths["/users"]?.get?.parameters?.find(
        (p) => p.in === "header" && p.name === "X-API-Version",
      );
      expect(v1ListParam?.schema?.enum).toEqual(["1"]);
      expect(v1ListParam?.schema?.default).toBe("1");

      expect(v2Doc.paths["/health"]).toBeUndefined();
      expect(v2Doc.paths["/users/{id}"]?.get?.summary).toBe("Get user v2");
      const v2HeaderParam = v2Doc.paths["/users/{id}"]?.get?.parameters?.find(
        (p) => p.in === "header" && p.name === "X-API-Version",
      );
      expect(v2HeaderParam?.required).toBe(true);
      expect(v2HeaderParam?.schema?.enum).toEqual(["2"]);
      expect(v2HeaderParam?.schema?.default).toBe("2");
    } finally {
      await headerApp.close();
    }

    // 3. MEDIA_TYPE versioning
    const mediaApp = await BunestFactory.create(VersionedAppModule, {
      logger: false,
    });
    mediaApp.enableVersioning({
      type: VersioningType.MEDIA_TYPE,
      key: "v=",
    });
    try {
      const v1Doc = SwaggerModule.createDocument(mediaApp, config, {
        version: "1",
      });
      const v2Doc = SwaggerModule.createDocument(mediaApp, config, {
        version: "2",
        includeVersionNeutral: false,
      });

      expect(v1Doc.paths["/health"]?.get).toBeDefined();
      expect(v1Doc.paths["/users/{id}"]?.get?.summary).toBe("Get user v1");
      const v1Accept = v1Doc.paths["/users/{id}"]?.get?.parameters?.find(
        (p) => p.in === "header" && p.name === "Accept",
      );
      expect(v1Accept?.required).toBe(true);
      expect(v1Accept?.schema?.enum).toEqual(["application/json;v=1"]);
      expect(v1Accept?.schema?.default).toBe("application/json;v=1");

      expect(v2Doc.paths["/health"]).toBeUndefined();
      expect(v2Doc.paths["/users/{id}"]?.get?.summary).toBe("Get user v2");
      const v2Accept = v2Doc.paths["/users/{id}"]?.get?.parameters?.find(
        (p) => p.in === "header" && p.name === "Accept",
      );
      expect(v2Accept?.required).toBe(true);
      expect(v2Accept?.schema?.enum).toEqual(["application/json;v=2"]);
      expect(v2Accept?.schema?.default).toBe("application/json;v=2");
    } finally {
      await mediaApp.close();
    }

    // 4. CUSTOM versioning with customVersionParameter
    const customApp = await BunestFactory.create(VersionedAppModule, {
      logger: false,
    });
    customApp.enableVersioning({
      type: VersioningType.CUSTOM,
      extractor: (req) => new URL(req.url).searchParams.get("apiVersion") ?? "1",
    });
    try {
      const customParam = {
        name: "apiVersion",
        in: "query" as const,
        description: "Custom query version selector",
      };
      const v1Doc = SwaggerModule.createDocument(customApp, config, {
        version: "1",
        customVersionParameter: customParam,
      });
      const v2Doc = SwaggerModule.createDocument(customApp, config, {
        version: "2",
        includeVersionNeutral: false,
        customVersionParameter: customParam,
      });

      expect(v1Doc.paths["/health"]?.get).toBeDefined();
      expect(v1Doc.paths["/users/{id}"]?.get?.summary).toBe("Get user v1");
      const v1QueryParam = v1Doc.paths["/users/{id}"]?.get?.parameters?.find(
        (p) => p.in === "query" && p.name === "apiVersion",
      );
      expect(v1QueryParam).toBeDefined();
      expect(v1QueryParam?.required).toBe(true);
      expect(v1QueryParam?.description).toBe("Custom query version selector");
      expect(v1QueryParam?.schema?.enum).toEqual(["1"]);
      expect(v1QueryParam?.schema?.default).toBe("1");

      expect(v2Doc.paths["/health"]).toBeUndefined();
      expect(v2Doc.paths["/users/{id}"]?.get?.summary).toBe("Get user v2");
      const v2QueryParam = v2Doc.paths["/users/{id}"]?.get?.parameters?.find(
        (p) => p.in === "query" && p.name === "apiVersion",
      );
      expect(v2QueryParam?.schema?.enum).toEqual(["2"]);
      expect(v2QueryParam?.schema?.default).toBe("2");
    } finally {
      await customApp.close();
    }
  });

  test("HEADER, MEDIA_TYPE, and CUSTOM routes on the same path/method do not overwrite each other in createVersionedDocuments, and single-doc mode logs a collision warning", async () => {
    const config = new DocumentBuilder()
      .setTitle("Collision Test API")
      .setDescription("Checks collision safety")
      .setVersion("0.0.0")
      .build();

    const strategies = [
      {
        label: "HEADER",
        enable: (app: Awaited<ReturnType<typeof BunestFactory.create>>) =>
          app.enableVersioning({
            type: VersioningType.HEADER,
            header: "X-API-Version",
          }),
        options: {},
      },
      {
        label: "MEDIA_TYPE",
        enable: (app: Awaited<ReturnType<typeof BunestFactory.create>>) =>
          app.enableVersioning({
            type: VersioningType.MEDIA_TYPE,
            key: "v=",
          }),
        options: {},
      },
      {
        label: "CUSTOM",
        enable: (app: Awaited<ReturnType<typeof BunestFactory.create>>) =>
          app.enableVersioning({
            type: VersioningType.CUSTOM,
            extractor: () => "1",
          }),
        options: {
          customVersionParameter: {
            name: "apiVersion",
            in: "query" as const,
          },
        },
      },
    ];

    for (const strategy of strategies) {
      const app = await BunestFactory.create(VersionedAppModule, {
        logger: false,
      });
      strategy.enable(app);
      try {
        // Per-version documents keep both GET /users/{id} operations intact
        const docs = SwaggerModule.createVersionedDocuments(app, config, {
          ...strategy.options,
          infoVersionResolver: (v) => `${v}.0.0`,
        });
        expect(Object.keys(docs)).toEqual(["1", "2"]);
        expect(docs["1"]?.info.title).toBe("Collision Test API");
        expect(docs["1"]?.info.description).toBe("Checks collision safety");
        expect(docs["1"]?.info.version).toBe("1.0.0");
        expect(docs["2"]?.info.version).toBe("2.0.0");

        expect(docs["1"]?.paths["/users/{id}"]?.get?.summary).toBe(
          "Get user v1",
        );
        expect(
          docs["1"]?.paths["/users/{id}"]?.get?.responses["200"]?.content?.[
            "application/json"
          ]?.schema,
        ).toEqual({ $ref: "#/components/schemas/UserV1Dto" });

        expect(docs["2"]?.paths["/users/{id}"]?.get?.summary).toBe(
          "Get user v2",
        );
        expect(
          docs["2"]?.paths["/users/{id}"]?.get?.responses["200"]?.content?.[
            "application/json"
          ]?.schema,
        ).toEqual({ $ref: "#/components/schemas/UserV2Dto" });

        // Single-doc mode logs a collision warning
        const warnSpy = spyOn(Logger.prototype, "warn").mockImplementation(
          () => {},
        );
        try {
          SwaggerModule.createDocument(app, config, strategy.options);
          const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
          const collisionWarn = warnMessages.find(
            (m) =>
              m.includes("GET /users/{id}") &&
              m.includes("createVersionedDocuments"),
          );
          expect(collisionWarn).toBeDefined();
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        await app.close();
      }
    }
  });

  test("components.schemas is scoped per version (v1 does not leak v2-only DTOs)", async () => {
    const app = await BunestFactory.create(VersionedAppModule, {
      logger: false,
    });
    app.enableVersioning({ type: VersioningType.URI, prefix: "v" });
    try {
      const config = new DocumentBuilder().setTitle("Scoped Schemas").build();
      const docs = SwaggerModule.createVersionedDocuments(app, config);

      const v1Schemas = Object.keys(docs["1"]?.components?.schemas ?? {});
      const v2Schemas = Object.keys(docs["2"]?.components?.schemas ?? {});

      expect(v1Schemas).toContain("UserV1Dto");
      expect(v1Schemas).toContain("HealthDto");
      expect(v1Schemas).not.toContain("UserV2Dto");
      expect(v1Schemas).not.toContain("CreateUserV2Dto");

      expect(v2Schemas).toContain("UserV2Dto");
      expect(v2Schemas).toContain("CreateUserV2Dto");
      expect(v2Schemas).toContain("HealthDto");

      // Excluding VERSION_NEUTRAL also excludes HealthDto from schemas
      const v1Only = SwaggerModule.createDocument(app, config, {
        version: "1",
        includeVersionNeutral: false,
      });
      const v1OnlySchemas = Object.keys(v1Only.components?.schemas ?? {});
      expect(v1OnlySchemas).toContain("UserV1Dto");
      expect(v1OnlySchemas).not.toContain("HealthDto");
      expect(v1OnlySchemas).not.toContain("UserV2Dto");
      expect(v1OnlySchemas).not.toContain("CreateUserV2Dto");
    } finally {
      await app.close();
    }
  });

  test("defaultVersion sets required: false on header/media-type version param and operationIdFactory receives version across all 4 strategies", async () => {
    const config = new DocumentBuilder().setTitle("Defaults & OpId").build();

    // 1. HEADER with defaultVersion: "1" -> v1 param required: false, v2 param required: true
    const headerApp = await BunestFactory.create(VersionedAppModule, {
      logger: false,
    });
    headerApp.enableVersioning({
      type: VersioningType.HEADER,
      header: "X-API-Version",
      defaultVersion: "1",
    });
    try {
      const v1OpIds: Array<{ c: string; m: string; v?: string }> = [];
      const v1Doc = SwaggerModule.createDocument(headerApp, config, {
        version: "1",
        operationIdFactory: (c, m, v) => {
          v1OpIds.push({ c, m, v });
          return `${c}_${m}_${v ?? "neutral"}`;
        },
      });
      const v2Doc = SwaggerModule.createDocument(headerApp, config, {
        version: "2",
      });

      const v1Param = v1Doc.paths["/users/{id}"]?.get?.parameters?.find(
        (p) => p.in === "header" && p.name === "X-API-Version",
      );
      expect(v1Param?.required).toBe(false);

      const v2Param = v2Doc.paths["/users/{id}"]?.get?.parameters?.find(
        (p) => p.in === "header" && p.name === "X-API-Version",
      );
      expect(v2Param?.required).toBe(true);

      expect(v1Doc.paths["/users/{id}"]?.get?.operationId).toBe(
        "VersionedUsersController_getUserV1_1",
      );
      expect(v1OpIds.find((e) => e.m === "getUserV1")?.v).toBe("1");
      expect(v1OpIds.find((e) => e.m === "check")?.v).toBeUndefined();
    } finally {
      await headerApp.close();
    }

    // 2. MEDIA_TYPE with defaultVersion: "2" -> v2 Accept param required: false, v1 required: true
    const mediaApp = await BunestFactory.create(VersionedAppModule, {
      logger: false,
    });
    mediaApp.enableVersioning({
      type: VersioningType.MEDIA_TYPE,
      key: "v=",
      defaultVersion: "2",
    });
    try {
      const v1Doc = SwaggerModule.createDocument(mediaApp, config, {
        version: "1",
      });
      const v2Doc = SwaggerModule.createDocument(mediaApp, config, {
        version: "2",
        operationIdFactory: (c, m, v) => `${c}.${m}.v${v ?? "0"}`,
      });

      const v1Accept = v1Doc.paths["/users/{id}"]?.get?.parameters?.find(
        (p) => p.in === "header" && p.name === "Accept",
      );
      expect(v1Accept?.required).toBe(true);

      const v2Accept = v2Doc.paths["/users/{id}"]?.get?.parameters?.find(
        (p) => p.in === "header" && p.name === "Accept",
      );
      expect(v2Accept?.required).toBe(false);
      expect(v2Doc.paths["/users/{id}"]?.get?.operationId).toBe(
        "VersionedUsersController.getUserV2.v2",
      );
    } finally {
      await mediaApp.close();
    }

    // 3. URI & CUSTOM operationIdFactory receives version
    const uriApp = await BunestFactory.create(VersionedAppModule, {
      logger: false,
    });
    uriApp.enableVersioning({ type: VersioningType.URI, prefix: "v" });
    try {
      const doc = SwaggerModule.createDocument(uriApp, config, {
        version: "2",
        operationIdFactory: (c, m, v) => `${c}:${m}:${v ?? "none"}`,
      });
      expect(doc.paths["/v2/users/{id}"]?.get?.operationId).toBe(
        "VersionedUsersController:getUserV2:2",
      );
    } finally {
      await uriApp.close();
    }

    const customApp = await BunestFactory.create(VersionedAppModule, {
      logger: false,
    });
    customApp.enableVersioning({
      type: VersioningType.CUSTOM,
      extractor: () => "2",
      defaultVersion: "2",
    });
    try {
      const doc = SwaggerModule.createDocument(customApp, config, {
        version: "2",
        customVersionParameter: { name: "ver", in: "query" },
        operationIdFactory: (c, m, v) => `${c}#${m}#${v ?? "none"}`,
      });
      expect(doc.paths["/users/{id}"]?.get?.operationId).toBe(
        "VersionedUsersController#getUserV2#2",
      );
      const customParam = doc.paths["/users/{id}"]?.get?.parameters?.find(
        (p) => p.in === "query" && p.name === "ver",
      );
      expect(customParam?.required).toBe(false);
    } finally {
      await customApp.close();
    }
  });

  test("discoverApiVersions(app) returns unique concrete versions in natural ascending order (1, 2, 10)", async () => {
    @Controller("/items")
    class MultiVersionItemsController {
      @Version("10")
      @Get("ten")
      ten() {
        return { v: 10 };
      }

      @Version("2")
      @Get("two")
      two() {
        return { v: 2 };
      }

      @Version(["1", "10"])
      @Get("one-and-ten")
      oneAndTen() {
        return { v: "1,10" };
      }

      @Version(VERSION_NEUTRAL)
      @Get("neutral")
      neutral() {
        return { v: "neutral" };
      }
    }

    @Module({ controllers: [MultiVersionItemsController] })
    class NaturalSortModule {}

    const app = await BunestFactory.create(NaturalSortModule, {
      logger: false,
    });
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: "1",
    });
    try {
      expect(SwaggerModule.discoverApiVersions(app)).toEqual(["1", "2", "10"]);
    } finally {
      await app.close();
    }
  });

  test("E2E SwaggerModule.setup('docs', app, docs, { defaultVersion: '2' }) serves all JSON/YAML/UI routes without requiring version headers or prefixes", async () => {
    const config = new DocumentBuilder()
      .setTitle("Multi-Version E2E API")
      .build();

    // 1. HEADER versioning with defaultVersion: "1" (no header required on /docs*)
    const headerApp = await BunestFactory.create(VersionedAppModule, {
      logger: false,
    });
    headerApp.enableVersioning({
      type: VersioningType.HEADER,
      header: "X-API-Version",
      defaultVersion: "1",
    });
    try {
      const docs = SwaggerModule.createVersionedDocuments(headerApp, config);
      SwaggerModule.setup("docs", headerApp, docs, {
        defaultVersion: "2",
      });
      await headerApp.init();

      const uiRes = await headerApp.fetch(new Request("http://localhost/docs"));
      expect(uiRes.status).toBe(200);
      expect(uiRes.headers.get("content-type")).toContain("text/html");
      const html = await uiRes.text();
      expect(html).toContain('id="version-selector"');
      expect(html).toContain("/docs/v1-json");
      expect(html).toContain("/docs/v2-json");

      // /docs-json serves defaultVersion ("2")
      const defaultJsonRes = await headerApp.fetch(
        new Request("http://localhost/docs-json"),
      );
      expect(defaultJsonRes.status).toBe(200);
      const defaultDoc = (await defaultJsonRes.json()) as OpenApiDocument;
      expect(defaultDoc.info.version).toBe("2");
      expect(defaultDoc.paths["/users/{id}"]?.get?.summary).toBe("Get user v2");

      // /docs/v1-json and /docs/v1-yaml
      const v1JsonRes = await headerApp.fetch(
        new Request("http://localhost/docs/v1-json"),
      );
      expect(v1JsonRes.status).toBe(200);
      const v1Doc = (await v1JsonRes.json()) as OpenApiDocument;
      expect(v1Doc.info.version).toBe("1");
      expect(v1Doc.paths["/users/{id}"]?.get?.summary).toBe("Get user v1");

      const v1YamlRes = await headerApp.fetch(
        new Request("http://localhost/docs/v1-yaml"),
      );
      expect(v1YamlRes.status).toBe(200);
      expect(v1YamlRes.headers.get("content-type")).toContain("text/yaml");
      expect(await v1YamlRes.text()).toContain("Get user v1");

      // /docs/v2-json and /docs/v2-yaml
      const v2JsonRes = await headerApp.fetch(
        new Request("http://localhost/docs/v2-json"),
      );
      expect(v2JsonRes.status).toBe(200);
      const v2Doc = (await v2JsonRes.json()) as OpenApiDocument;
      expect(v2Doc.info.version).toBe("2");
      expect(v2Doc.paths["/users/{id}"]?.get?.summary).toBe("Get user v2");

      const v2YamlRes = await headerApp.fetch(
        new Request("http://localhost/docs/v2-yaml"),
      );
      expect(v2YamlRes.status).toBe(200);
      expect(v2YamlRes.headers.get("content-type")).toContain("text/yaml");
      expect(await v2YamlRes.text()).toContain("Get user v2");
    } finally {
      await headerApp.close();
    }

    // 2. URI versioning with defaultVersion: "1" + ReadonlyMap input (no /v1 prefix on /docs*)
    const uriApp = await BunestFactory.create(VersionedAppModule, {
      logger: false,
    });
    uriApp.enableVersioning({
      type: VersioningType.URI,
      prefix: "v",
      defaultVersion: "1",
    });
    try {
      const recordDocs = SwaggerModule.createVersionedDocuments(uriApp, config);
      const mapDocs = new Map<string, OpenApiDocument>(
        Object.entries(recordDocs),
      );
      SwaggerModule.setup("docs", uriApp, mapDocs);
      await uriApp.init();

      // Without explicit defaultVersion, setup() defaults to last entry ("2")
      const defaultRes = await uriApp.fetch(
        new Request("http://localhost/docs-json"),
      );
      expect(defaultRes.status).toBe(200);
      const defaultDoc = (await defaultRes.json()) as OpenApiDocument;
      expect(defaultDoc.info.version).toBe("2");

      const v1Res = await uriApp.fetch(
        new Request("http://localhost/docs/v1-json"),
      );
      expect(v1Res.status).toBe(200);
      const v1Doc = (await v1Res.json()) as OpenApiDocument;
      expect(v1Doc.paths["/v1/users/{id}"]?.get).toBeDefined();
    } finally {
      await uriApp.close();
    }
  });

  test("renders multi-version switcher across builtin, swagger-ui, and scalar presets with XSS escaping", () => {
    const sampleDoc: OpenApiDocument = {
      openapi: "3.1.0",
      info: { title: "Multi-Version UI", version: "2" },
      paths: {},
    };
    const urls = [
      {
        name: "v1",
        url: "/docs/v1-json",
        yamlUrl: "/docs/v1-yaml",
        version: "1",
      },
      {
        name: "v2",
        url: "/docs/v2-json",
        yamlUrl: "/docs/v2-yaml",
        version: "2",
      },
    ];

    // 1. Built-in Explorer preset
    const builtinHtml = renderSwaggerHtml(sampleDoc, "/docs-json", {
      ui: "builtin",
      urls,
      defaultVersion: "2",
    });
    expect(builtinHtml).toContain('id="version-selector"');
    expect(builtinHtml).toContain(
      '<option value="/docs/v2-json" selected>v2</option>',
    );
    expect(builtinHtml).toContain(
      '<option value="/docs/v1-json">v1</option>',
    );
    expect(builtinHtml).not.toContain("innerHTML");

    // 2. Swagger-UI preset (StandaloneLayout + standalone preset + urls + no embedded spec)
    const swaggerUiHtml = renderSwaggerHtml(sampleDoc, "/docs-json", {
      ui: "swagger-ui",
      urls,
      defaultVersion: "2",
    });
    expect(swaggerUiHtml).toContain("swagger-ui-standalone-preset.js");
    expect(swaggerUiHtml).toContain('layout: "StandaloneLayout"');
    expect(swaggerUiHtml).toContain("SwaggerUIStandalonePreset");
    expect(swaggerUiHtml).toContain('"urls.primaryName": "v2"');
    expect(swaggerUiHtml).toContain('"/docs/v1-json"');
    expect(swaggerUiHtml).toContain('"/docs/v2-json"');
    expect(swaggerUiHtml).not.toMatch(/\bspec\s*:/);

    // 3. Scalar preset (data-configuration with sources array)
    const scalarHtml = renderSwaggerHtml(sampleDoc, "/docs-json", {
      ui: "scalar",
      urls,
      defaultVersion: "2",
    });
    expect(scalarHtml).toContain("@scalar/api-reference");
    const configAttrMatch = /data-configuration="([^"]+)"/.exec(scalarHtml);
    expect(configAttrMatch).not.toBeNull();
    const decodedConfig = configAttrMatch![1]!
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&#39;", "'");
    const parsedScalarConfig = JSON.parse(decodedConfig) as {
      sources: Array<{ title: string; url: string; default: boolean }>;
    };
    expect(parsedScalarConfig.sources).toEqual([
      { title: "v1", url: "/docs/v1-json", default: false },
      { title: "v2", url: "/docs/v2-json", default: true },
    ]);

    // 4. XSS escaping of version names across all 3 presets
    const xssUrls = [
      {
        name: 'v1</script><img src=x onerror=alert(1)>',
        url: "/docs/v1-json",
        version: "1",
      },
      {
        name: 'v2" onmouseover="alert(2)',
        url: "/docs/v2-json",
        version: "2",
      },
    ];
    for (const ui of ["builtin", "swagger-ui", "scalar"] as const) {
      const html = renderSwaggerHtml(sampleDoc, "/docs-json", {
        ui,
        urls: xssUrls,
        defaultVersion: "1",
      });
      expect(html).not.toContain("</script><img");
      expect(html).not.toContain('onmouseover="alert(2)');
      expect(html).not.toContain("<img src=x");
    }
  });
});
