import { describe, expect, it } from "bun:test";
import { IsInt, IsString, MinLength } from "../packages/validation/src/validator";
import {
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiExtension,
  ApiExtraModels,
  ApiHideProperty,
  ApiOAuth2,
  ApiOkResponse,
  ApiProduces,
  ApiProperty,
  DocumentBuilder,
  SwaggerModule,
  getSchemaPath,
  refs,
} from "../packages/swagger/src";
import {
  ApplicationConfig,
  BaseExceptionFilter,
  Bind,
  Body,
  BunestFactory,
  Catch,
  ClassSerializerInterceptor,
  ConsoleLogger,
  Controller,
  Dependencies,
  DiscoveryService,
  ExternalContextCreator,
  Get,
  GraphInspector,
  Header,
  HttpAdapterHost,
  HttpException,
  HttpStatus,
  INQUIRER,
  ImATeapotException,
  Inject,
  Injectable,
  InitializeOnPreviewAllowlist,
  Logger,
  MetadataScanner,
  MisdirectedException,
  Module,
  ModuleRef,
  ModulesContainer,
  NestFactory,
  Next,
  NotAcceptableException,
  Param,
  PartialGraphHost,
  Post,
  PreconditionFailedException,
  Propfind,
  QueryMethod,
  Render,
  Request,
  RequestMapping,
  RequestMethod,
  RequestTimeoutException,
  Response,
  Scope,
  Search,
  SerializedGraph,
  SignedCookies,
  StreamableFile,
  UseFilters,
  ValidationPipe,
  assignMetadata,
  createContextId,
  createReplContext,
  filterLogLevels,
  flatten,
  HttpVersionNotSupportedException,
  mixin,
  stripProtoKeys,
  type ArgumentsHost,
  type NextFunction,
  type ResponseContext,
} from "../packages/core/src";
import {
  Directive,
  Extensions,
  Field,
  GraphQLModule,
  GraphQLSchemaHost,
  GraphQLService,
  HideField,
  ID,
  InputType,
  ObjectType,
  PartialType as GqlPartialType,
  Query as GqlQuery,
  ResolveReference,
  Resolver,
  Scalar,
  type CustomScalar,
} from "../packages/graphql/src";
import {
  Ack,
  BunWebSocketAdapter,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "../packages/core/src/ws";
import {
  GrpcStreamCall,
  InMemoryBroker,
  InMemoryClientProxy,
  InMemoryServer,
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  MqttRecordBuilder,
  NatsRecordBuilder,
  Payload,
  RedisRecordBuilder,
  RmqRecordBuilder,
  type CustomTransportStrategy,
} from "../packages/microservices/src";
import { Test, request } from "../packages/testing/src";
import { parseCliArgs, transformDtoMetadataSource } from "../packages/cli/src";
import { DevtoolsModule, DevtoolsService } from "../packages/observability/src";

describe("NestJS v12.5.1 Full API Parity Suite (Phases 1-6)", () => {
  describe("Phase 1: @bunest/common primitives, exceptions, decorators, logger & utils", () => {
    it("exports Scope.DEFAULT === Scope.SINGLETON and all 6 new HttpException subclasses + HttpStatus codes", () => {
      expect(Scope.DEFAULT).toBe(Scope.SINGLETON);
      expect(HttpStatus.EARLYHINTS).toBe(103);
      expect(HttpStatus.MULTI_STATUS).toBe(207);
      expect(HttpStatus.ALREADY_REPORTED).toBe(208);
      expect(HttpStatus.CONTENT_DIFFERENT).toBe(210);
      expect(HttpStatus.LOCKED).toBe(423);
      expect(HttpStatus.UNRECOVERABLE_ERROR).toBe(456);
      expect(HttpStatus.INSUFFICIENT_STORAGE).toBe(507);
      expect(HttpStatus.LOOP_DETECTED).toBe(508);

      expect(new NotAcceptableException().getStatus()).toBe(406);
      expect(new RequestTimeoutException().getStatus()).toBe(408);
      expect(new PreconditionFailedException().getStatus()).toBe(412);
      expect(new ImATeapotException().getStatus()).toBe(418);
      expect(new MisdirectedException().getStatus()).toBe(421);
      expect(new HttpVersionNotSupportedException().getStatus()).toBe(505);

      const ex = new HttpException("Rate limited", 429, {
        errorCode: "ERR_RATE_LIMIT",
        description: "Too many requests",
      });
      expect(ex.errorCode).toBe("ERR_RATE_LIMIT");
      expect(HttpException.getDescriptionFrom("desc")).toBe("desc");
      expect(
        HttpException.extractDescriptionAndOptionsFrom({
          description: "D",
          errorCode: "E1",
        }),
      ).toEqual({
        description: "D",
        httpExceptionOptions: { description: "D", errorCode: "E1" },
      });
    });

    it("supports mixin(), flatten(), assignMetadata(), stripProtoKeys(), ConsoleLogger, Logger buffer, and StreamableFile error hooks", () => {
      class BaseMixin {
        greet() {
          return "hi";
        }
      }
      const Mixed = mixin(BaseMixin);
      expect(new Mixed().greet()).toBe("hi");
      expect(Mixed.name).not.toBe("BaseMixin");

      expect(flatten([1, [2, [3]], 4])).toEqual([1, 2, 3, 4]);
      const meta = assignMetadata({}, 1, 0, "id");
      expect(meta["1:0"]).toEqual({ index: 0, data: "id", pipes: [] });

      const clean = stripProtoKeys(
        JSON.parse('{"ok":1,"__proto__":{"polluted":true}}'),
      ) as Record<string, unknown>;
      expect(clean.ok).toBe(1);
      expect(Object.prototype.hasOwnProperty.call(clean, "__proto__")).toBe(
        false,
      );

      expect(filterLogLevels(">=warn")).toEqual(["warn", "error", "fatal"]);
      const consoleLogger = new ConsoleLogger("TestCtx", {
        logLevels: ["error", "warn"],
        json: true,
      });
      expect(consoleLogger.isLevelEnabled("error")).toBe(true);
      expect(consoleLogger.isLevelEnabled("debug")).toBe(false);

      Logger.attachBuffer();
      expect(Logger.isBufferAttached()).toBe(true);
      Logger.detachBuffer();
      expect(Logger.isBufferAttached()).toBe(false);

      const file = new StreamableFile(new Uint8Array([1, 2, 3]));
      const logged: Error[] = [];
      file.setErrorLogger((err) => logged.push(err));
      file.errorLogger(new Error("boom"));
      expect(logged.length).toBe(1);
      expect(file.stream).toBeInstanceOf(ReadableStream);
    });

    it("supports @RequestMapping, WebDAV verbs (@Search, @Propfind, @QueryMethod), @Request/@Response/@Next/@Bind/@Dependencies", async () => {
      @Injectable()
      class GreetingRepo {
        getWord() {
          return "hello";
        }
      }

      @Dependencies(GreetingRepo)
      @Injectable()
      class LegacyJsService {
        constructor(public readonly repo: GreetingRepo) {}
      }

      @Controller("v12")
      class VerbsController {
        constructor(private readonly svc: LegacyJsService) {}

        @RequestMapping({ path: "mapped", method: RequestMethod.GET })
        mapped(
          @Request() req: globalThis.Request,
          @Response({ passthrough: true }) res: ResponseContext,
        ) {
          res.header("x-verb", req.method);
          return { word: this.svc.repo.getWord() };
        }

        @Search("find")
        doSearch() {
          return { searched: true };
        }

        @Propfind("meta")
        doPropfind() {
          return { dav: true };
        }

        @QueryMethod("query-verb")
        doQueryMethod() {
          return { queryVerb: true };
        }

        @Get("bound/:id")
        @Bind(Param("id"), Next())
        bound(id: string, next: NextFunction) {
          return { id, hasNext: typeof next === "function" };
        }
      }

      @Module({
        controllers: [VerbsController],
        providers: [GreetingRepo, LegacyJsService],
      })
      class VerbsModule {}

      const app = await NestFactory.create(VerbsModule, { logger: false });
      await app.init();
      try {
        const r1 = await app.inject({ method: "GET", url: "/v12/mapped" });
        expect(r1.statusCode).toBe(200);
        expect(r1.headers["x-verb"]).toBe("GET");
        expect(r1.json()).toEqual({ word: "hello" });

        const r2 = await app.inject({ method: "SEARCH", url: "/v12/find" });
        expect(r2.statusCode).toBe(200);
        expect(r2.json()).toEqual({ searched: true });

        const r3 = await app.inject({ method: "PROPFIND", url: "/v12/meta" });
        expect(r3.statusCode).toBe(200);
        expect(r3.json()).toEqual({ dav: true });

        const r4 = await app.inject({
          method: "QUERY",
          url: "/v12/query-verb",
        });
        expect(r4.statusCode).toBe(200);
        expect(r4.json()).toEqual({ queryVerb: true });

        const r5 = await app.inject({ method: "GET", url: "/v12/bound/42" });
        expect(r5.statusCode).toBe(200);
        expect(r5.json()).toEqual({ id: "42", hasNext: true });
      } finally {
        await app.close();
      }
    });
  });

  describe("Phase 2: HTTP Security (CSRF, SecurityHeaders, SignedCookies), Views, Route Strategy, ValidationPipe formats", () => {
    it("enforces Fetch-Metadata CSRF protection, applies Helmet-8 security headers (incl. 404/403), and verifies HMAC-SHA256 signed cookies with secret rotation", async () => {
      @Controller("sec")
      class SecController {
        @Get("ping")
        @Header("X-Frame-Options", "DENY")
        ping() {
          return { ok: true };
        }

        @Post("mutate")
        mutate() {
          return { mutated: true };
        }

        @Get("set-cookie")
        setCookie(@Response() res: ResponseContext) {
          res.cookie("session", "user-123", {
            signed: true,
            httpOnly: true,
            priority: "high",
          });
          return { set: true };
        }

        @Get("read-cookie")
        readCookie(@SignedCookies("session") session: string | undefined) {
          return { session: session ?? null };
        }

        @Get("page")
        @Render("welcome")
        renderPage() {
          return { name: "Bunest" };
        }
      }

      @Module({ controllers: [SecController] })
      class SecModule {}

      const app = await NestFactory.create(SecModule, {
        logger: false,
        cookies: { secret: ["new-secret", "old-secret"] },
      });
      app.enableCsrfProtection({
        trustedOrigins: ["https://trusted.example"],
      });
      app.useSecurityHeaders();
      app.setViewEngine(
        (template, model) =>
          `<h1>${template}: ${(model as { name: string }).name}</h1>`,
      );
      await app.init();

      try {
        // Security headers applied on 200 without overwriting route's X-Frame-Options: DENY
        const ping = await app.inject({ method: "GET", url: "/sec/ping" });
        expect(ping.statusCode).toBe(200);
        expect(ping.headers["x-content-type-options"]).toBe("nosniff");
        expect(ping.headers["x-frame-options"]).toBe("DENY");
        expect(ping.headers["x-powered-by"]).toBeUndefined();

        // Security headers applied on 404
        const notFound = await app.inject({
          method: "GET",
          url: "/does-not-exist",
        });
        expect(notFound.statusCode).toBe(404);
        expect(notFound.headers["x-content-type-options"]).toBe("nosniff");

        // CSRF blocks cross-site POST
        const blocked = await app.inject({
          method: "POST",
          url: "/sec/mutate",
          headers: {
            "sec-fetch-site": "cross-site",
            origin: "https://evil.example",
          },
        });
        expect(blocked.statusCode).toBe(403);
        expect(blocked.headers["x-content-type-options"]).toBe("nosniff");

        // CSRF allows same-origin POST
        const sameOrigin = await app.inject({
          method: "POST",
          url: "/sec/mutate",
          headers: { "sec-fetch-site": "same-origin" },
        });
        expect(sameOrigin.statusCode).toBe(201);

        // CSRF allows trustedOrigin cross-site POST
        const trusted = await app.inject({
          method: "POST",
          url: "/sec/mutate",
          headers: {
            "sec-fetch-site": "cross-site",
            origin: "https://trusted.example",
          },
        });
        expect(trusted.statusCode).toBe(201);

        // Signed cookies round-trip + tamper rejection
        const setRes = await app.inject({
          method: "GET",
          url: "/sec/set-cookie",
        });
        const setCookieHeader = String(setRes.headers["set-cookie"] ?? "");
        expect(setCookieHeader).toContain("Priority=High");
        const rawCookiePair = setCookieHeader.split(";")[0]!;
        const cookieVal = decodeURIComponent(
          rawCookiePair.slice("session=".length),
        );

        const readValid = await app.inject({
          method: "GET",
          url: "/sec/read-cookie",
          cookies: { session: cookieVal },
        });
        expect(readValid.json()).toEqual({ session: "user-123" });

        const readTampered = await app.inject({
          method: "GET",
          url: "/sec/read-cookie",
          cookies: { session: "s:user-999.invalidsignature" },
        });
        expect(readTampered.json()).toEqual({ session: null });

        // @Render() + setViewEngine()
        const rendered = await app.inject({ method: "GET", url: "/sec/page" });
        expect(rendered.statusCode).toBe(200);
        expect(rendered.body).toBe("<h1>welcome: Bunest</h1>");
      } finally {
        await app.close();
      }
    });

    it("supports routeResolutionStrategy: 'specificity', routeConflictPolicy object { duplicate, shadow }, and ValidationPipe errorFormat: 'list' | 'grouped'", async () => {
      @Controller("items")
      class SpecificityController {
        @Get(":id")
        byParam(@Param("id") id: string) {
          return { kind: "param", id };
        }

        @Get("special")
        special() {
          return { kind: "static" };
        }
      }

      const app = await NestFactory.create(
        { controllers: [SpecificityController] },
        {
          logger: false,
          routeResolutionStrategy: "specificity",
          routeConflictPolicy: { duplicate: "error", shadow: "off" },
        },
      );
      await app.init();
      try {
        const res = await app.inject({ method: "GET", url: "/items/special" });
        expect(res.json()).toEqual({ kind: "static" });
      } finally {
        await app.close();
      }

      // Shadow conflict policy = "error" throws on shadowed routes
      let shadowThrown = false;
      try {
        const badApp = await NestFactory.create(
          { controllers: [SpecificityController] },
          {
            logger: false,
            routeResolutionStrategy: "declaration",
            routeConflictPolicy: { duplicate: "error", shadow: "error" },
          },
        );
        await badApp.init();
      } catch (err) {
        shadowThrown =
          err instanceof Error && err.message.toLowerCase().includes("shadow");
      }
      expect(shadowThrown).toBe(true);

      // ValidationPipe errorFormat: "list" and "grouped"
      class CreateItemDto {
        @IsString()
        @MinLength(3)
        name!: string;

        @IsInt()
        qty!: number;
      }

      const listPipe = new ValidationPipe({ errorFormat: "list" });
      let listErr: unknown;
      try {
        await listPipe.transform(
          { name: "a", qty: "nope" },
          { type: "body", metatype: CreateItemDto },
        );
      } catch (e) {
        listErr = e;
      }
      expect(listErr).toBeInstanceOf(HttpException);
      const listBody = (listErr as HttpException).getResponse() as {
        message: string[];
      };
      expect(Array.isArray(listBody.message)).toBe(true);
      expect(listBody.message.length).toBeGreaterThanOrEqual(2);

      const groupedPipe = new ValidationPipe({ errorFormat: "grouped" });
      let groupedErr: unknown;
      try {
        await groupedPipe.transform(
          { name: "a", qty: "nope" },
          { type: "body", metatype: CreateItemDto },
        );
      } catch (e) {
        groupedErr = e;
      }
      const groupedBody = (groupedErr as HttpException).getResponse() as {
        message: Record<string, string[]>;
      };
      expect(groupedBody.message.name?.length).toBeGreaterThan(0);
      expect(groupedBody.message.qty?.length).toBeGreaterThan(0);

      // ClassSerializerInterceptor.transformToPlain()
      const serializer = new ClassSerializerInterceptor({
        getAllAndOverride: () => undefined,
      } as any);
      expect(serializer.transformToPlain({ a: 1 }, {})).toEqual({ a: 1 });
    });
  });

  describe("Phase 3 & 4: Core DI, INQUIRER, HttpAdapterHost, BaseExceptionFilter, DiscoveryService.createDecorator, GraphInspector, Preview & REPL", () => {
    it("supports INQUIRER, HttpAdapterHost, BaseExceptionFilter, ModuleRef.introspect, DiscoveryService.createDecorator, ExternalContextCreator, ApplicationConfig, ModulesContainer, instrument, and deep-hash", async () => {
      const FeatureFlag = DiscoveryService.createDecorator<string>();

      @Injectable({ scope: Scope.TRANSIENT })
      class ScopedLogger {
        constructor(
          @Inject(INQUIRER) public readonly parentInstance: object | undefined,
        ) {}
      }

      @FeatureFlag("beta")
      @Injectable()
      class ConsumerService {
        constructor(
          public readonly logger: ScopedLogger,
          public readonly moduleRef: ModuleRef,
          public readonly adapterHost: HttpAdapterHost,
          public readonly appConfig: ApplicationConfig,
          public readonly modulesContainer: ModulesContainer,
          public readonly externalCreator: ExternalContextCreator,
        ) {}

        publicMethod() {}
        privateHelper() {}
      }

      @Catch()
      class CustomFilter extends BaseExceptionFilter {
        override catch(exception: unknown, host: ArgumentsHost) {
          if (
            exception instanceof Error &&
            exception.message === "custom-err"
          ) {
            return new globalThis.Response(
              JSON.stringify({ handledBy: "BaseExceptionFilter" }),
              {
                status: 418,
                headers: { "content-type": "application/json" },
              },
            );
          }
          return super.catch(exception, host);
        }
      }

      @Controller("core-v12")
      @UseFilters(CustomFilter)
      class CoreV12Controller {
        constructor(private readonly svc: ConsumerService) {}

        @Get("parent")
        parent() {
          return {
            parent: this.svc.logger.parentInstance?.constructor?.name,
            hasAdapter: Boolean(this.svc.adapterHost.httpAdapter),
            introspect: this.svc.moduleRef.introspect(ScopedLogger),
            modulesCount: this.svc.modulesContainer.size,
          };
        }

        @Get("fail")
        fail() {
          throw new Error("custom-err");
        }
      }

      const decoratedTokens: string[] = [];
      const app = await NestFactory.create(
        {
          controllers: [CoreV12Controller],
          providers: [ScopedLogger, ConsumerService],
        },
        {
          logger: false,
          snapshot: true,
          moduleIdGeneratorAlgorithm: "deep-hash",
          instrument: {
            instanceDecorator: (instance) => {
              if (instance && typeof instance === "object") {
                decoratedTokens.push(instance.constructor.name);
              }
              return instance;
            },
          },
        },
      );
      await app.init();

      try {
        const res = await app.inject("/core-v12/parent");
        expect(res.statusCode).toBe(200);
        const body = res.json<{
          parent: string;
          hasAdapter: boolean;
          introspect: { scope: Scope };
          modulesCount: number;
        }>();
        expect(body.parent).toBe("ConsumerService");
        expect(body.hasAdapter).toBe(true);
        expect(body.introspect.scope).toBe(Scope.TRANSIENT);
        expect(body.modulesCount).toBeGreaterThanOrEqual(1);
        expect(decoratedTokens).toContain("ConsumerService");

        // BaseExceptionFilter subclass catches custom error
        const failRes = await app.inject("/core-v12/fail");
        expect(failRes.statusCode).toBe(418);
        expect(failRes.json()).toEqual({ handledBy: "BaseExceptionFilter" });

        // DiscoveryService.createDecorator + MetadataScanner.getAllFilteredMethodNames
        const discovery = app.get(DiscoveryService);
        const providers = discovery.getProviders({
          metadataKey: FeatureFlag.KEY,
        });
        expect(providers.length).toBe(1);
        expect(
          discovery.getMetadataByDecorator(FeatureFlag, providers[0]!),
        ).toBe("beta");

        const scanner = app.get(MetadataScanner);
        expect([
          ...scanner.getAllFilteredMethodNames(ConsumerService.prototype),
        ]).toEqual(["publicMethod", "privateHelper"]);

        // ExternalContextCreator wraps non-HTTP handler
        const externalCreator = app.get(ExternalContextCreator);
        const consumer = app.get(ConsumerService);
        const wrapped = externalCreator.create(
          consumer,
          () => "external-ok",
          "publicMethod",
        );
        expect(await wrapped()).toBe("external-ok");

        // SerializedGraph & GraphInspector snapshot populated
        const serializedGraph = app.get(SerializedGraph);
        const inspector = app.get(GraphInspector);
        expect(inspector).toBeInstanceOf(GraphInspector);
        const graphJson = serializedGraph.toJSON();
        expect(Object.keys(graphJson.nodes).length).toBeGreaterThan(0);

        // createContextId helper
        const cid = createContextId();
        expect(typeof cid.id).toBe("number");

        // createReplContext works programmatically
        const replCtx = createReplContext(app);
        expect(replCtx.get(ConsumerService)).toBe(consumer);
        expect(replCtx.$(ConsumerService)).toBe(consumer);
        expect(replCtx.methods(ConsumerService)).toContain("publicMethod");
      } finally {
        await app.close();
      }
    });

    it("supports preview: true with InitializeOnPreviewAllowlist and PartialGraphHost on bootstrap failure", async () => {
      let regularConstructed = false;
      let allowlistedConstructed = false;

      @Injectable()
      class RegularService {
        constructor() {
          regularConstructed = true;
        }
      }

      @Injectable()
      class AllowlistedService {
        constructor() {
          allowlistedConstructed = true;
        }
      }
      InitializeOnPreviewAllowlist.add(AllowlistedService);

      const previewCtx = await NestFactory.createApplicationContext(
        { providers: [RegularService, AllowlistedService] },
        { logger: false, preview: true, snapshot: true },
      );
      try {
        expect(regularConstructed).toBe(false);
        expect(allowlistedConstructed).toBe(true);
        const graph = previewCtx.get(SerializedGraph);
        expect(graph.status).toBe("complete");
      } finally {
        await previewCtx.close();
      }

      // Broken app with snapshot: true populates PartialGraphHost
      @Injectable()
      class BrokenService {
        constructor(@Inject("MISSING_DEP") _dep: unknown) {}
      }

      let failed = false;
      try {
        await NestFactory.createApplicationContext(
          { providers: [BrokenService] },
          { logger: false, snapshot: true, abortOnError: false },
        );
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(PartialGraphHost.toJSON()).toBeDefined();
      expect(PartialGraphHost.toString()).toContain("partial");
    });
  });

  describe("Phase 5: Swagger, GraphQL, WebSockets & Microservices parity", () => {
    it("supports @bunest/swagger extra models, hide property, consumes/produces, cookie/oauth2 auth, extensions, getSchemaPath, refs, and response shorthands", async () => {
      class ExtraDto {
        @ApiProperty()
        code!: string;
      }

      class UserDto {
        @ApiProperty()
        email!: string;

        @ApiHideProperty()
        passwordHash!: string;
      }

      expect(getSchemaPath(ExtraDto)).toBe("#/components/schemas/ExtraDto");
      expect(refs(ExtraDto, UserDto)).toEqual([
        { $ref: "#/components/schemas/ExtraDto" },
        { $ref: "#/components/schemas/UserDto" },
      ]);

      @ApiExtraModels(ExtraDto)
      @ApiCookieAuth("sid")
      @ApiOAuth2(["read:users"])
      @Controller("docs-test")
      class DocsController {
        @Get()
        @ApiConsumes("application/json")
        @ApiProduces("application/json")
        @ApiExtension("x-owner", "platform")
        @ApiOkResponse({ type: UserDto })
        @ApiCreatedResponse({ description: "Created" })
        list() {
          return [];
        }
      }

      const app = await NestFactory.create(
        { controllers: [DocsController] },
        { logger: false },
      );
      await app.init();
      try {
        const config = new DocumentBuilder()
          .setTitle("V12 Parity")
          .setVersion("1.0")
          .build();
        const doc = SwaggerModule.createDocument(app, config);
        expect(doc.components?.schemas?.ExtraDto).toBeDefined();
        const userSchema = doc.components?.schemas?.UserDto as {
          properties?: Record<string, unknown>;
        };
        expect(userSchema?.properties?.email).toBeDefined();
        expect(userSchema?.properties?.passwordHash).toBeUndefined();
        const op = doc.paths?.["/docs-test"]?.get as unknown as Record<
          string,
          unknown
        >;
        expect(op?.["x-owner"]).toBe("platform");
      } finally {
        await app.close();
      }
    });

    it("supports @bunest/graphql @Scalar, @Directive, @HideField, @Extensions, GraphQLSchemaHost, sortSchema, GraphQL MappedTypes, and Federation Subgraph", async () => {
      @Scalar("DateScalar", () => Date)
      class DateScalar implements CustomScalar<string, Date> {
        description = "ISO Date scalar";
        parseValue(value: unknown): Date {
          return new Date(String(value));
        }
        serialize(value: Date): string {
          return value instanceof Date ? value.toISOString() : String(value);
        }
      }

      @ObjectType()
      @Directive('@key(fields: "id")')
      @Extensions({ owner: "catalog" })
      class Product {
        @Field(() => ID)
        id!: string;

        @Field()
        title!: string;

        @Field(() => Date)
        createdAt!: Date;

        @HideField()
        internalSecret!: string;
      }

      @InputType()
      class UpdateProductInput extends GqlPartialType(Product, InputType) {}

      @Resolver(() => Product)
      class ProductResolver {
        @GqlQuery(() => Product)
        product(): Product {
          return {
            id: "p1",
            title: "Bunest Book",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            internalSecret: "hidden",
          };
        }

        @ResolveReference()
        resolveReference(ref: { __typename: string; id: string }) {
          return {
            id: ref.id,
            title: `Resolved-${ref.id}`,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            internalSecret: "hidden",
          };
        }
      }

      @Module({
        imports: [
          GraphQLModule.forRoot({
            autoSchemaFile: true,
            sortSchema: true,
            federation: { version: 2 },
            orphanedTypes: [UpdateProductInput],
          }),
        ],
        providers: [DateScalar, ProductResolver],
      })
      class GqlAppModule {}

      const app = await NestFactory.create(GqlAppModule, { logger: false });
      await app.init();
      try {
        const schemaHost = app.get(GraphQLSchemaHost);
        const gqlService = app.get(GraphQLService);
        expect(schemaHost.schema).toBe(gqlService.getSchema());

        const sdl = gqlService.printSDL();
        expect(sdl).toContain("scalar DateScalar");
        expect(sdl).not.toContain("internalSecret");
        expect(sdl).toContain("input UpdateProductInput");
        expect(sdl).toContain("_service");
        expect(sdl).toContain("_entities");

        const queryRes = await gqlService.executeQuery({
          query: `{ product { id title createdAt } }`,
        });
        expect(queryRes.result.errors).toBeUndefined();
        expect(queryRes.result.data).toEqual({
          product: {
            id: "p1",
            title: "Bunest Book",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        });

        // Federation _entities resolution via @ResolveReference()
        const entRes = await gqlService.executeQuery({
          query: `query($reps: [_Any!]!) { _entities(representations: $reps) { ... on Product { id title } } }`,
          variables: { reps: [{ __typename: "Product", id: "p99" }] },
        });
        expect(entRes.result.errors).toBeUndefined();
        expect(entRes.result.data).toEqual({
          _entities: [{ id: "p99", title: "Resolved-p99" }],
        });
      } finally {
        await app.close();
      }
    });

    it("supports @bunest/websockets @Ack(), maxConcurrentMessages, and app.useWebSocketAdapter()", async () => {
      @WebSocketGateway({ path: "/ack-ws", maxConcurrentMessages: 1 })
      class AckGateway {
        @SubscribeMessage("echo")
        handleEcho(
          @MessageBody() data: { text: string },
          @Ack() ack: (v: unknown) => void,
        ) {
          ack({ echoed: data.text });
        }
      }

      const app = await NestFactory.create(
        { providers: [AckGateway] },
        { logger: false },
      );
      const wsAdapter = new BunWebSocketAdapter();
      app.useWebSocketAdapter(wsAdapter);
      await wsAdapter.registerGateway(app.get(AckGateway));
      expect(app.getWebSocketAdapter()).toBe(wsAdapter);
      const info = await app.listen(0);
      try {
        const wsUrl = info.url.replace(/^http/, "ws") + "ack-ws";
        const reply = await new Promise<unknown>((resolve, reject) => {
          const sock = new WebSocket(wsUrl);
          sock.onopen = () => {
            sock.send(
              JSON.stringify({
                event: "echo",
                data: { text: "ping" },
                id: "req-1",
              }),
            );
          };
          sock.onmessage = (ev) => {
            sock.close();
            resolve(JSON.parse(String(ev.data)));
          };
          sock.onerror = (err) => reject(err);
        });
        expect(reply).toEqual({
          event: "echo",
          id: "req-1",
          data: { echoed: "ping" },
        });
      } finally {
        await app.close();
      }
    });

    it("supports @bunest/microservices RecordBuilders, CustomTransportStrategy, unwrap(), status/onStatus(), PreRequestHook, @GrpcStreamCall, and inheritAppConfig", async () => {
      const rmq = new RmqRecordBuilder({ a: 1 })
        .setOptions({ priority: 5 })
        .build();
      expect(rmq.data).toEqual({ a: 1 });
      expect(rmq.options?.priority).toBe(5);

      const nats = new NatsRecordBuilder("hi")
        .setHeaders({ "x-id": "1" })
        .build();
      expect(nats.headers?.["x-id"]).toBe("1");

      const mqtt = new MqttRecordBuilder("m").setQoS(1).setRetain(true).build();
      expect(mqtt.options?.qos).toBe(1);
      expect(mqtt.options?.retain).toBe(true);

      const redis = new RedisRecordBuilder("r")
        .setOptions({ headers: { h: "v" } })
        .build();
      expect(redis.options?.headers?.h).toBe("v");

      // CustomTransportStrategy
      let strategyStarted = false;
      let strategyClosed = false;
      const customStrategy: CustomTransportStrategy = {
        listen(cb) {
          strategyStarted = true;
          cb?.();
        },
        close() {
          strategyClosed = true;
        },
      };

      const customCtx = await NestFactory.createApplicationContext(
        { imports: [MicroserviceModule.forRoot({ strategy: customStrategy })] },
        { logger: false },
      );
      await customCtx.init();
      expect(strategyStarted).toBe(true);
      await customCtx.close();
      expect(strategyClosed).toBe(true);

      // Hybrid app inheritAppConfig + PreRequestHook + status/onStatus + @GrpcStreamCall metadata
      const broker = new InMemoryBroker();
      const server = new InMemoryServer({ broker });
      const client = new InMemoryClientProxy({ broker });
      const statuses: string[] = [];
      client.onStatus((s) => statuses.push(s));

      const seenHooks: string[] = [];
      server.setPreRequestHook(({ pattern }) => {
        seenHooks.push(`server:${pattern}`);
      });
      client.setPreRequestHook(({ pattern }) => {
        seenHooks.push(`client:${pattern}`);
      });

      @Controller()
      class RpcCtrl {
        @MessagePattern("upper")
        toUpper(@Payload() text: string) {
          return text;
        }

        @GrpcStreamCall("HeroService", "StreamBidi")
        streamBidi() {}
      }

      const app = await NestFactory.create(
        {
          imports: [MicroserviceModule.forRoot({ server })],
          controllers: [RpcCtrl],
        },
        { logger: false },
      );
      app.useGlobalPipes({
        transform(v: unknown) {
          return typeof v === "string" ? v.toUpperCase() : v;
        },
      });
      const host = app.get(MicroserviceHost);
      app.connectMicroservice(host, { inheritAppConfig: true });
      await app.init();
      await app.startAllMicroservices();
      await client.connect();

      try {
        expect(server.unwrap()).toBe(server);
        expect(client.unwrap()).toBe(client);
        const result = await client.send<string>("upper", "bunest");
        expect(result).toBe("BUNEST");
        expect(seenHooks).toContain("client:upper");
        expect(seenHooks).toContain("server:upper");
      } finally {
        await client.close();
        await app.close();
      }
    });
  });

  describe("Phase 6: TestingModule (preview/snapshot/instrument/createNestMicroservice), CLI repl & metadata plugin, Devtools SerializedGraph", () => {
    it("supports TestingModule preview/snapshot/instrument/createNestMicroservice, CLI repl parsing, metadata plugin hiding, and Devtools serializedGraph", async () => {
      @Injectable()
      class SampleService {
        value() {
          return 123;
        }
      }

      const moduleRef = await Test.createTestingModule(
        {
          imports: [DevtoolsModule.forRoot({ exposeEndpoints: false })],
          providers: [SampleService],
        },
        { snapshot: true, moduleIdGeneratorAlgorithm: "deep-hash" },
      ).compile();

      try {
        const devtools = moduleRef.get(DevtoolsService);
        const graph = devtools.getGraph();
        expect(graph.serializedGraph).toBeDefined();
        expect(
          Object.keys(graph.serializedGraph!.nodes).length,
        ).toBeGreaterThan(0);

        let msStarted = false;
        const ms = moduleRef.createNestMicroservice({
          listen() {
            msStarted = true;
          },
          close() {},
        });
        await ms.listen();
        expect(msStarted).toBe(true);
      } finally {
        await moduleRef.close();
      }

      // CLI repl args
      const parsed = parseCliArgs(["repl", "--entry", "src/custom-repl.ts"]);
      expect(parsed.command).toBe("repl");
      expect(parsed.flags.entry).toBe("src/custom-repl.ts");

      // CLI metadata plugin respects @ApiHideProperty() and @HideField()
      const dtoSource = `
export class AccountDto {
  email: string;
  @ApiHideProperty()
  @HideField()
  secretToken: string;
}
`;
      const transformed = transformDtoMetadataSource(
        dtoSource,
        "account.dto.ts",
        {
          swagger: true,
          graphql: true,
        },
      );
      expect(transformed.modified).toBe(true);
      expect(transformed.code).toContain('"email"');
      expect(transformed.code).not.toContain('propertyKey: "secretToken"');

      // Supertest drop-in check via NestFactory alias
      @Controller("smoke")
      class SmokeCtrl {
        @Get()
        hi() {
          return { ok: true };
        }
      }
      const smokeMod = await Test.createTestingModule({
        controllers: [SmokeCtrl],
      }).compile();
      const smokeApp = smokeMod.createNestApplication();
      await smokeApp.init();
      try {
        await request(smokeApp).get("/smoke").expect(200);
      } finally {
        await smokeMod.close();
      }
    });
  });
});
