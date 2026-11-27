import { describe, expect, test } from "bun:test";
import {
  Body,
  BunestFactory,
  Catch,
  Controller,
  Get,
  Injectable,
  IntersectionType,
  Module,
  OmitType,
  Param,
  PartialType,
  PickType,
  Post,
  Query,
  UseFilters,
  UseGuards,
  UsePipes,
  VERSION_NEUTRAL,
  Version,
  VersioningType,
  type ArgumentsHost,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type PipeTransform,
} from "@bunest/core";
import { Test } from "@bunest/testing";
import { IsEmail, IsInt, IsString, MinLength } from "@bunest/validation/validator";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  DocumentBuilder,
  SwaggerModule,
  renderSwaggerHtml,
} from "../src/index";

class DomainConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainConflictError";
  }
}

class ProfileDto {
  @ApiProperty({ example: "ada@bunest.dev" })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: "Ada Lovelace" })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: "s3cr3t" })
  @IsString()
  password!: string;
}

class AuditFieldsDto {
  @ApiProperty({ example: 42 })
  @IsInt()
  version!: number;
}

class UpdateProfileDto extends PartialType(ProfileDto) {}
class PublicProfileDto extends OmitType(ProfileDto, ["password"] as const) {}
class EmailOnlyDto extends PickType(ProfileDto, ["email"] as const) {}
class VersionedProfileDto extends IntersectionType(
  PublicProfileDto,
  AuditFieldsDto,
) {}

describe("SwaggerModule P0 #1 Bridge Delegation & P2 #10 Upgrades", () => {
  test("P0 #1 regression: SwaggerModule.setup() preserves module-local enhancers, TestingModule overrides, and custom @Catch filter mappings", async () => {
    @Injectable()
    class FeatureLocalToken {
      readonly expected = "feature-secret";
    }

    // Registered ONLY inside FeatureModule (NOT exported globally!)
    @Injectable()
    class FeatureLocalGuard implements CanActivate {
      constructor(private readonly token: FeatureLocalToken) {}
      canActivate(ctx: ExecutionContext): boolean {
        const req = ctx.switchToHttp().getRequest<Request>();
        return req.headers.get("x-feature-key") === this.token.expected;
      }
    }

    @Injectable()
    class UppercasePipe implements PipeTransform {
      transform(value: unknown) {
        return typeof value === "string" ? value.toUpperCase() : value;
      }
    }

    @Catch(DomainConflictError)
    class DomainConflictFilter implements ExceptionFilter<DomainConflictError> {
      catch(exception: DomainConflictError, host: ArgumentsHost) {
        const res = host.switchToHttp().getResponse();
        res.status(409);
        return { handledBy: "DomainConflictFilter", error: exception.message };
      }
    }

    @Controller("/feature")
    @UseGuards(FeatureLocalGuard)
    @UseFilters(DomainConflictFilter)
    class FeatureController {
      @Get(":slug")
      getItem(@Param("slug", UppercasePipe) slug: string) {
        if (slug === "CONFLICT") {
          throw new DomainConflictError("Duplicate slug");
        }
        return { slug };
      }
    }

    @Module({
      controllers: [FeatureController],
      providers: [
        FeatureLocalToken,
        FeatureLocalGuard,
        UppercasePipe,
        DomainConflictFilter,
      ],
    })
    class FeatureModule {}

    @Module({
      imports: [FeatureModule],
    })
    class RootAppModule {}

    // 1. Verify module-local guard + @Catch filter survive SwaggerModule.setup()
    const app = await BunestFactory.create(RootAppModule, { logger: false });
    try {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("Bridge Test").build(),
      );
      SwaggerModule.setup("/docs", app, doc);

      // Guard must still resolve FeatureLocalToken from FeatureModule (requires controllerToken!)
      const denied = await app.fetch(
        new Request("http://localhost/feature/hello"),
      );
      expect(denied.status).toBe(403);

      const ok = await app.fetch(
        new Request("http://localhost/feature/hello", {
          headers: { "x-feature-key": "feature-secret" },
        }),
      );
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ slug: "HELLO" });

      // Custom @Catch(DomainConflictError) filter mapping must be preserved!
      const conflict = await app.fetch(
        new Request("http://localhost/feature/conflict", {
          headers: { "x-feature-key": "feature-secret" },
        }),
      );
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({
        handledBy: "DomainConflictFilter",
        error: "Duplicate slug",
      });
    } finally {
      await app.close();
    }

    // 2. Verify TestingModule kind-specific overrides (overrideGuard & overridePipe & overrideFilter) survive SwaggerModule.setup()!
    const mod = await Test.createTestingModule({
      imports: [RootAppModule],
    })
      .overrideGuard(FeatureLocalGuard)
      .useValue({ canActivate: () => true })
      .overridePipe(UppercasePipe)
      .useValue({ transform: (v: unknown) => `OVERRIDDEN:${String(v)}` })
      .overrideFilter(DomainConflictFilter)
      .useValue({
        catch(err: Error, host: ArgumentsHost) {
          host.switchToHttp().getResponse().status(418);
          return { overriddenFilter: err.message };
        },
      })
      .compile();

    const testApp = mod.createBunestApplication();
    try {
      const doc = SwaggerModule.createDocument(
        testApp,
        new DocumentBuilder().setTitle("Override Bridge Test").build(),
      );
      SwaggerModule.setup("/docs", testApp, doc);
      await testApp.init();

      // Guard override allows without header, Pipe override transforms param!
      const res = await testApp.fetch(
        new Request("http://localhost/feature/abc"),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ slug: "OVERRIDDEN:abc" });

      // Swagger docs still served
      const docsRes = await testApp.fetch(
        new Request("http://localhost/docs-json"),
      );
      expect(docsRes.status).toBe(200);
    } finally {
      await testApp.close();
    }
  });

  test("introspects design:returntype DTOs, @Version() paths/headers, and MappedTypes (Partial/Pick/Omit/Intersection)", async () => {
    @Controller({ path: "/profiles", version: "1" })
    class ProfilesController {
      @Get(":id")
      getProfile(@Param("id") _id: string): PublicProfileDto {
        return { email: "a@b.c", name: "Ada" };
      }

      @Version("2")
      @Get(":id")
      @ApiOkResponse({ description: "Versioned profile with audit info" })
      getProfileV2(@Param("id") _id: string): VersionedProfileDto {
        return { email: "a@b.c", name: "Ada", version: 1 };
      }

      @Version(["1", "2"])
      @Get("multi")
      multiVersion(): EmailOnlyDto {
        return { email: "multi@bunest.dev" };
      }

      @Version(VERSION_NEUTRAL)
      @Post("partial")
      updatePartial(@Body() _body: UpdateProfileDto): EmailOnlyDto {
        return { email: "a@b.c" };
      }
    }

    @Module({ controllers: [ProfilesController] })
    class ProfileAppModule {}

    // 1. URI versioning + globalPrefix + design:returntype + MappedTypes
    const appUri = await BunestFactory.create(ProfileAppModule, {
      logger: false,
      globalPrefix: "api",
    });
    appUri.enableVersioning({ type: VersioningType.URI, prefix: "v" });

    try {
      const doc = SwaggerModule.createDocument(
        appUri,
        new DocumentBuilder()
          .setTitle("Versioned API")
          .setVersion("2.0.0")
          .build(),
      );

      // URI versioned paths generated without double-prefixing (including multi-version @Version(["1", "2"]))
      expect(doc.paths["/api/v1/profiles/{id}"]?.get).toBeDefined();
      expect(doc.paths["/api/v2/profiles/{id}"]?.get).toBeDefined();
      expect(doc.paths["/api/v1/profiles/multi"]?.get).toBeDefined();
      expect(doc.paths["/api/v2/profiles/multi"]?.get).toBeDefined();
      expect(doc.paths["/api/v1/v2/profiles/multi"]).toBeUndefined();
      expect(doc.paths["/api/v2/v1/profiles/multi"]).toBeUndefined();
      expect(doc.paths["/api/profiles/partial"]?.post).toBeDefined();

      // Multi-version URI routes MUST have distinct OpenAPI 3.1 operationIds
      const multiV1OpId = doc.paths["/api/v1/profiles/multi"]?.get?.operationId;
      const multiV2OpId = doc.paths["/api/v2/profiles/multi"]?.get?.operationId;
      expect(multiV1OpId).toBe("ProfilesController_multiVersion_v1");
      expect(multiV2OpId).toBe("ProfilesController_multiVersion_v2");
      expect(multiV1OpId).not.toBe(multiV2OpId);

      // Every operationId across the entire OpenAPI document must be unique
      const allOpIds: string[] = [];
      for (const pathItem of Object.values(doc.paths)) {
        for (const op of Object.values(pathItem)) {
          if (
            op &&
            typeof op === "object" &&
            "operationId" in op &&
            typeof op.operationId === "string"
          ) {
            allOpIds.push(op.operationId);
          }
        }
      }
      expect(new Set(allOpIds).size).toBe(allOpIds.length);

      // design:returntype inferred automatically into response content schema!
      expect(
        doc.paths["/api/v1/profiles/{id}"]?.get?.responses["200"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({ $ref: "#/components/schemas/PublicProfileDto" });

      expect(
        doc.paths["/api/v2/profiles/{id}"]?.get?.responses["200"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({ $ref: "#/components/schemas/VersionedProfileDto" });

      expect(
        doc.paths["/api/profiles/partial"]?.post?.responses["201"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({ $ref: "#/components/schemas/EmailOnlyDto" });

      // MappedTypes schemas verified
      const schemas = doc.components?.schemas ?? {};
      expect(schemas.PublicProfileDto?.properties?.password).toBeUndefined();
      expect(schemas.PublicProfileDto?.properties?.email).toBeDefined();
      expect(schemas.PublicProfileDto?.properties?.name).toBeDefined();
      expect(schemas.PublicProfileDto?.required).toContain("email");

      // PartialType: all properties optional (`required` omitted)
      expect(schemas.UpdateProfileDto?.properties?.email).toBeDefined();
      expect(schemas.UpdateProfileDto?.properties?.name).toBeDefined();
      expect(schemas.UpdateProfileDto?.required).toBeUndefined();

      // PickType: only email
      expect(Object.keys(schemas.EmailOnlyDto?.properties ?? {})).toEqual([
        "email",
      ]);

      // IntersectionType: email + name + version (and no password)
      expect(schemas.VersionedProfileDto?.properties?.email).toBeDefined();
      expect(schemas.VersionedProfileDto?.properties?.name).toBeDefined();
      expect(schemas.VersionedProfileDto?.properties?.version).toBeDefined();
      expect(schemas.VersionedProfileDto?.properties?.password).toBeUndefined();
    } finally {
      await appUri.close();
    }

    // 2. HEADER versioning adds version header parameter to operations
    const appHdr = await BunestFactory.create(ProfileAppModule, {
      logger: false,
    });
    appHdr.enableVersioning({
      type: VersioningType.HEADER,
      header: "X-API-Version",
    });
    try {
      const doc = SwaggerModule.createDocument(
        appHdr,
        new DocumentBuilder().setTitle("Header Versioned").build(),
      );
      const getOp = doc.paths["/profiles/{id}"]?.get;
      const versionHeader = getOp?.parameters?.find(
        (p) => p.in === "header" && p.name === "X-API-Version",
      );
      expect(versionHeader).toBeDefined();
      expect(versionHeader?.required).toBe(true);
    } finally {
      await appHdr.close();
    }
  });

  test("renders Interactive Try-It-Out UI (path/query/header/body/Authorize/XSS-safe) and scalar/swagger-ui presets", async () => {
    @Controller("/orders")
    class OrdersController {
      @Post(":id")
      @ApiBearerAuth()
      @ApiHeader({ name: "X-Tenant", required: true })
      @ApiOperation({ summary: "Create order for tenant" })
      create(
        @Param("id") _id: string,
        @Query("dryRun") _dryRun: string,
        @Body() _body: PublicProfileDto,
      ): PublicProfileDto {
        return { email: "a@b.c", name: "Ada" };
      }
    }

    @Module({ controllers: [OrdersController] })
    class OrdersModule {}

    const app = await BunestFactory.create(OrdersModule, { logger: false });
    try {
      const config = new DocumentBuilder()
        .setTitle("Interactive Orders API")
        .addBearerAuth()
        .addApiKey(
          { type: "apiKey", name: "X-API-Key", in: "header" },
          "api-key",
        )
        .build();
      const doc = SwaggerModule.createDocument(app, config);

      // 1. Default builtin interactive Try-It-Out UI (zero CDN, full param/body/auth controls)
      const builtinHtml = renderSwaggerHtml(doc, "/docs-json");
      expect(builtinHtml).toContain("auth-dialog");
      expect(builtinHtml).toContain("auth-bearer");
      expect(builtinHtml).toContain("auth-apikey-value");
      expect(builtinHtml).toContain("Path Parameters");
      expect(builtinHtml).toContain("Query Parameters");
      expect(builtinHtml).toContain("Header Parameters");
      expect(builtinHtml).toContain("Request Body (");
      expect(builtinHtml).toContain("buildExampleValue");
      expect(builtinHtml).not.toContain("cdn.jsdelivr.net");
      expect(builtinHtml).not.toContain("innerHTML");

      // 2. Scalar preset
      const scalarHtml = renderSwaggerHtml(doc, "/docs-json", { ui: "scalar" });
      expect(scalarHtml).toContain("@scalar/api-reference");
      expect(scalarHtml).toContain('data-url="/docs-json"');

      // 3. Swagger-UI preset (verifies query-param `&` is NOT double-escaped as `&amp;` in JS literal, while `</script>` is safely escaped)
      const swaggerUiHtml = renderSwaggerHtml(doc, "/docs-json?a=1&b=2", {
        ui: "swagger-ui",
      });
      expect(swaggerUiHtml).toContain("SwaggerUIBundle");
      expect(swaggerUiHtml).not.toContain("&amp;");
      const urlMatch = /url:\s*("(?:[^"\\]|\\.)*")/.exec(swaggerUiHtml);
      expect(urlMatch).not.toBeNull();
      expect(JSON.parse(urlMatch![1]!)).toBe("/docs-json?a=1&b=2");

      const xssPresetHtml = renderSwaggerHtml(
        doc,
        "/docs-json?</script><img src=x>",
        {
          ui: "swagger-ui",
        },
      );
      expect(xssPresetHtml).not.toContain("</script><img");
    } finally {
      await app.close();
    }
  });

  test("SwaggerModule.setup() serves /docs and /docs-json as VERSION_NEUTRAL when defaultVersion is enabled (URI & HEADER)", async () => {
    @Controller("/items")
    class ItemsController {
      @Get()
      list() {
        return { ok: true };
      }
    }

    @Module({ controllers: [ItemsController] })
    class VersionedDocsModule {}

    // 1. URI versioning with defaultVersion: "1" -> /docs and /docs-json must stay at /docs (not /v1/docs)
    const uriApp = await BunestFactory.create(VersionedDocsModule, {
      logger: false,
    });
    uriApp.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
    try {
      const doc = SwaggerModule.createDocument(
        uriApp,
        new DocumentBuilder().setTitle("URI Versioned Docs").build(),
      );
      SwaggerModule.setup("/docs", uriApp, doc);
      await uriApp.init();

      const uiRes = await uriApp.fetch(new Request("http://localhost/docs"));
      expect(uiRes.status).toBe(200);
      expect(uiRes.headers.get("content-type")).toContain("text/html");

      const jsonRes = await uriApp.fetch(
        new Request("http://localhost/docs-json"),
      );
      expect(jsonRes.status).toBe(200);
      const parsed = (await jsonRes.json()) as {
        paths: Record<string, unknown>;
      };
      expect(parsed.paths["/v1/items"]).toBeDefined();
    } finally {
      await uriApp.close();
    }

    // 2. HEADER versioning with defaultVersion: "1" -> /docs and /docs-json must work WITHOUT version header
    const hdrApp = await BunestFactory.create(VersionedDocsModule, {
      logger: false,
    });
    hdrApp.enableVersioning({
      type: VersioningType.HEADER,
      header: "X-API-Version",
      defaultVersion: "1",
    });
    try {
      const doc = SwaggerModule.createDocument(
        hdrApp,
        new DocumentBuilder().setTitle("Header Versioned Docs").build(),
      );
      SwaggerModule.setup("/docs", hdrApp, doc);
      await hdrApp.init();

      const uiRes = await hdrApp.fetch(new Request("http://localhost/docs"));
      expect(uiRes.status).toBe(200);
      const jsonRes = await hdrApp.fetch(
        new Request("http://localhost/docs-json"),
      );
      expect(jsonRes.status).toBe(200);
    } finally {
      await hdrApp.close();
    }
  });
});
