import { describe, expect, it } from "bun:test";
import {
  All,
  Body,
  BunestFactory,
  Controller,
  Cookies,
  Get,
  Header,
  Headers,
  MetadataRegistry,
  Module,
  Param,
  Post,
  Query,
  RawBody,
  Redirect,
  Render,
  SerializeOptions,
  SetMetadata,
  SignedCookies,
  Sse,
  UploadedFile,
  UseStandardSchema,
  Version,
  VersioningType,
  type StandardSchemaV1,
} from "@bunest/core";
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiProperty,
  CompositionType,
  DocumentBuilder,
  SwaggerModule,
  type ConvertedPathInfo,
  type OpenApiSchema,
} from "../src";
import {
  clearPluginMetadataStore,
  getPluginModelMetadata,
  registerLoadedPluginMetadata,
} from "../src/plugin-metadata-store";

function createJsonStandardSchema(
  jsonSchema: Record<string, unknown>,
): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  } as unknown as StandardSchemaV1;
}

describe("@bunest/swagger HTTP, Params, Serializer, Security & Module integration", () => {
  it("preserves multi-prefix setGlobalPrefix(string[]) in createDocument() and SwaggerModule.setup()", async () => {
    @Controller("ping")
    class PingController {
      @Get()
      ping() {
        return { ok: true };
      }
    }

    @Module({ controllers: [PingController] })
    class MultiPrefixModule {}

    const app = await BunestFactory.create(MultiPrefixModule);
    app.setGlobalPrefix(["api", "v2"]);

    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("MultiPrefix").setVersion("1.0").build(),
    );

    expect(doc.paths["/api/ping"]?.get).toBeDefined();
    expect(doc.paths["/v2/ping"]?.get).toBeDefined();

    SwaggerModule.setup("docs", app, doc);
    await app.init();

    const r1 = await app.fetch(new Request("http://localhost/api/ping"));
    const r2 = await app.fetch(new Request("http://localhost/v2/ping"));
    const rDocs = await app.fetch(new Request("http://localhost/docs-json"));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(rDocs.status).toBe(200);
  });

  it("normalizes MEDIA_TYPE versioning key when missing trailing '='", async () => {
    @Controller("items")
    class ItemsController {
      @Version("1")
      @Get()
      listV1() {
        return [];
      }
    }

    @Module({ controllers: [ItemsController] })
    class MediaVerModule {}

    const app = await BunestFactory.create(MediaVerModule);
    app.enableVersioning({ type: VersioningType.MEDIA_TYPE, key: "v" });

    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("MediaVer").setVersion("1.0").build(),
    );
    const acceptParam = doc.paths["/items"]?.get?.parameters?.find(
      (p) => p.in === "header" && p.name === "Accept",
    );
    expect(acceptParam?.schema?.enum).toEqual(["application/json;v=1"]);
    expect(acceptParam?.schema?.default).toBe("application/json;v=1");
  });

  it("gives @All() expanded POST operation default 201 Created while others get 200 OK", async () => {
    @Controller("any")
    class AnyController {
      @All()
      handleAll() {
        return { ok: true };
      }
    }

    @Module({ controllers: [AnyController] })
    class AnyModule {}

    const app = await BunestFactory.create(AnyModule);
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("All").setVersion("1.0").build(),
    );

    expect(doc.paths["/any"]?.get?.responses["200"]?.description).toBe("OK");
    expect(doc.paths["/any"]?.post?.responses["201"]?.description).toBe(
      "Created",
    );
    expect(doc.paths["/any"]?.put?.responses["200"]?.description).toBe("OK");
    expect(doc.paths["/any"]?.patch?.responses["200"]?.description).toBe("OK");
    expect(doc.paths["/any"]?.delete?.responses["200"]?.description).toBe("OK");
  });

  it("documents @Sse(), @Header(), @Redirect(), and @Render() accurately", async () => {
    class DummyDto {
      @ApiProperty()
      id!: string;
    }

    @Controller("verbs")
    class VerbsController {
      @Sse("stream", { method: "POST" })
      stream() {
        return [];
      }

      @Get("headers")
      @Header("X-Cache", "HIT")
      @Header("Content-Type", "text/plain")
      withHeaders(): DummyDto {
        return { id: "1" };
      }

      @Get("moved")
      @Redirect("https://example.com/new", 301)
      moved(): DummyDto {
        return { id: "1" };
      }

      @Get("page")
      @Render("home")
      renderHome() {
        return {};
      }
    }

    @Module({ controllers: [VerbsController] })
    class VerbsModule {}

    const app = await BunestFactory.create(VerbsModule);
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("Verbs").setVersion("1.0").build(),
    );

    // @Sse POST -> 200 + text/event-stream
    const sseResp = doc.paths["/verbs/stream"]?.post?.responses["200"];
    expect(sseResp?.description).toBe("OK");
    expect(sseResp?.content?.["text/event-stream"]).toBeDefined();

    // @Header -> response.headers + Content-Type fallback
    const hdrResp = doc.paths["/verbs/headers"]?.get?.responses["200"];
    expect(hdrResp?.headers?.["X-Cache"]).toEqual({
      schema: { type: "string", default: "HIT" },
    });
    expect(hdrResp?.content?.["text/plain"]).toBeDefined();

    // @Redirect -> 301 Moved Permanently, Location header, no JSON body
    const redirResp = doc.paths["/verbs/moved"]?.get?.responses["301"];
    expect(redirResp?.description).toBe("Moved Permanently");
    expect(redirResp?.headers?.["Location"]).toBeDefined();
    expect(redirResp?.content).toBeUndefined();

    // @Render -> text/html
    const renderResp = doc.paths["/verbs/page"]?.get?.responses["200"];
    expect(renderResp?.content?.["text/html"]).toBeDefined();
  });

  it("supports keyed @Body schema, @Cookies/@SignedCookies, @RawBody, combined upload+@Body, @Param/@Headers schemas, and guards unkeyed @Query", async () => {
    const emailSchema = createJsonStandardSchema({
      type: "string",
      format: "email",
    });
    const pathObjSchema = createJsonStandardSchema({
      type: "object",
      properties: { id: { type: "string", format: "uuid" } },
    });
    const headersObjSchema = createJsonStandardSchema({
      type: "object",
      properties: { "x-trace": { type: "string" } },
      required: ["x-trace"],
    });
    const rawWebhookSchema = createJsonStandardSchema({
      type: "string",
      description: "Raw webhook payload",
    });

    class UploadMetaDto {
      @ApiProperty()
      title!: string;
    }

    @Controller("params")
    class ParamsController {
      @Post("keyed-body")
      keyedBody(@Body("email", emailSchema) _email: string) {
        return {};
      }

      @Get("query-map")
      queryMap(@Query() _q: Record<string, string>) {
        return {};
      }

      @Get("cookies")
      cookies(
        @Cookies("sid") _sid: string,
        @SignedCookies("csrf") _csrf: string,
      ) {
        return {};
      }

      @Post("raw-bin")
      rawBin(@RawBody() _raw: Uint8Array) {
        return {};
      }

      @Post("raw-schema")
      @ApiConsumes("text/plain")
      rawWithSchema(@RawBody(rawWebhookSchema) _raw: string) {
        return {};
      }

      @Post("upload")
      upload(
        @UploadedFile("avatar") _file: unknown,
        @Body() _meta: UploadMetaDto,
      ) {
        return {};
      }

      @Get("by-id/:id")
      byId(
        @Param(pathObjSchema) _p: { id: string },
        @Headers(headersObjSchema) _h: { "x-trace": string },
      ) {
        return {};
      }
    }

    @Module({ controllers: [ParamsController] })
    class ParamsModule {}

    const app = await BunestFactory.create(ParamsModule);
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("Params").setVersion("1.0").build(),
    );

    // Keyed @Body("email", schema)
    const keyedBodySchema = doc.paths["/params/keyed-body"]?.post?.requestBody
      ?.content?.["application/json"]?.schema as OpenApiSchema | undefined;
    expect(keyedBodySchema?.properties?.["email"]).toEqual({
      type: "string",
      format: "email",
    });

    // Unkeyed @Query() Record -> does NOT register Object in components.schemas
    expect(doc.components?.schemas?.["Object"]).toBeUndefined();

    // @Cookies & @SignedCookies
    const cookieParams = doc.paths["/params/cookies"]?.get?.parameters ?? [];
    expect(
      cookieParams.find((p) => p.in === "cookie" && p.name === "sid"),
    ).toBeDefined();
    expect(
      cookieParams.find((p) => p.in === "cookie" && p.name === "csrf"),
    ).toBeDefined();

    // @RawBody() binary default
    expect(
      doc.paths["/params/raw-bin"]?.post?.requestBody?.content?.[
        "application/octet-stream"
      ]?.schema,
    ).toEqual({ type: "string", format: "binary" });

    // @RawBody(schema) + @ApiConsumes
    expect(
      doc.paths["/params/raw-schema"]?.post?.requestBody?.content?.["text/plain"]
        ?.schema,
    ).toEqual({ type: "string", description: "Raw webhook payload" });

    // Combined @UploadedFile + @Body DTO
    const uploadSchema = doc.paths["/params/upload"]?.post?.requestBody
      ?.content?.["multipart/form-data"]?.schema as OpenApiSchema | undefined;
    expect(uploadSchema?.properties?.["avatar"]).toEqual({
      type: "string",
      format: "binary",
    });
    expect(uploadSchema?.properties?.["title"]).toEqual({ type: "string" });
    expect(uploadSchema?.required).toEqual(["title"]);

    // Unkeyed @Param(schema) and @Headers(schema)
    const byIdParams = doc.paths["/params/by-id/{id}"]?.get?.parameters ?? [];
    expect(
      byIdParams.find((p) => p.in === "path" && p.name === "id")?.schema,
    ).toEqual({ type: "string", format: "uuid" });
    const traceHeader = byIdParams.find(
      (p) => p.in === "header" && p.name === "x-trace",
    );
    expect(traceHeader?.required).toBe(true);
    expect(traceHeader?.schema).toEqual({ type: "string" });
  });

  it("integrates Core Serializer (@UseStandardSchema & @SerializeOptions) and @bunest/security (@Public & @Throttle/@SkipThrottle)", async () => {
    const outSchema = createJsonStandardSchema({
      type: "object",
      properties: { safe: { type: "boolean" } },
      required: ["safe"],
    });

    class PublicUserDto {
      @ApiProperty()
      username!: string;
    }

    const IS_PUBLIC = Symbol.for("bunest:security:is_public");
    const AUTH_NEXT_PUBLIC = Symbol.for("@nestjs/authentication:public");
    const THROTTLE = Symbol.for("bunest:security:throttle");
    const SKIP_THROTTLE = Symbol.for("bunest:security:skip_throttle");

    @ApiBearerAuth()
    @SetMetadata(THROTTLE, { ttl: 60000, limit: 10 })
    @Controller("sec")
    class SecController {
      @Get("std")
      @UseStandardSchema(outSchema)
      stdOut() {
        return { safe: true };
      }

      @Get("dto")
      @SerializeOptions({ type: PublicUserDto })
      dtoOut() {
        return { username: "alice" };
      }

      @Get("public-legacy")
      @SetMetadata(IS_PUBLIC, true)
      @SetMetadata(SKIP_THROTTLE, true)
      publicLegacy() {
        return {};
      }

      @Get("public-next")
      @SetMetadata(AUTH_NEXT_PUBLIC, true)
      publicNext() {
        return {};
      }
    }

    // Also test controller-level auth-next @Public() overridden by method @Authenticate() (false)
    @SetMetadata(AUTH_NEXT_PUBLIC, true)
    @ApiBearerAuth()
    @Controller("mixed")
    class MixedAuthController {
      @Get("open")
      open() {
        return {};
      }

      @Get("locked")
      @SetMetadata(AUTH_NEXT_PUBLIC, false)
      locked() {
        return {};
      }
    }

    @Module({ controllers: [SecController, MixedAuthController] })
    class SecModule {}

    const app = await BunestFactory.create(SecModule);
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("Sec").setVersion("1.0").build(),
    );

    // Core serializer inference
    expect(
      doc.paths["/sec/std"]?.get?.responses["200"]?.content?.["application/json"]
        ?.schema,
    ).toEqual({
      type: "object",
      properties: { safe: { type: "boolean" } },
      required: ["safe"],
    });
    expect(
      doc.paths["/sec/dto"]?.get?.responses["200"]?.content?.["application/json"]
        ?.schema,
    ).toEqual({ $ref: "#/components/schemas/PublicUserDto" });

    // @Throttle adds 429; @SkipThrottle suppresses it
    expect(doc.paths["/sec/std"]?.get?.responses["429"]).toEqual({
      description: "Too Many Requests",
    });
    expect(doc.paths["/sec/public-legacy"]?.get?.responses["429"]).toBeUndefined();

    // @Public() sets security: []
    expect(doc.paths["/sec/public-legacy"]?.get?.security).toEqual([]);
    expect(doc.paths["/sec/public-next"]?.get?.security).toEqual([]);
    expect(doc.paths["/mixed/open"]?.get?.security).toEqual([]);
    // @Authenticate() (false) overrides controller @Public()
    expect(doc.paths["/mixed/locked"]?.get?.security).toEqual([{ bearer: [] }]);
  });

  it("exports ConvertedPathInfo, CompositionType, and clears WeakMaps in clearPluginMetadataStore()", async () => {
    const checkType: ConvertedPathInfo = { openApiPath: "/x", pathParams: [] };
    expect(checkType.openApiPath).toBe("/x");
    expect(typeof CompositionType).toBe("function");

    class PluginDto {}
    await registerLoadedPluginMetadata({
      "@bunest/swagger": {
        models: [[{ PluginDto }, { PluginDto: { id: { type: () => String } } }]],
      },
    });
    expect(getPluginModelMetadata(PluginDto)).toBeDefined();
    clearPluginMetadataStore();
    expect(getPluginModelMetadata(PluginDto)).toBeUndefined();
    // Silence unused MetadataRegistry import check if needed
    expect(typeof MetadataRegistry.get).toBe("function");
  });
});
