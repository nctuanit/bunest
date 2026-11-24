import { afterEach, describe, expect, test } from "bun:test";
import {
  type ArgumentsHost,
  type CanActivate,
  Catch,
  ensureDir,
  type ExecutionContext,
  Injectable,
  join,
  Module,
  REQUEST,
  removePath,
  UseFilters,
  UseGuards,
} from "@bunest/core";
import { BunestFactory } from "@bunest/core";
import {
  ARGS_TYPE_METADATA,
  AbstractGraphQLDriver,
  Args,
  ArgsType,
  BaseExplorerService,
  CLASS_TYPE_METADATA,
  CONTEXT,
  type CustomScalar,
  DEFINITIONS_FILE_HEADER,
  Directive,
  Extensions,
  FIELD_MIDDLEWARE_METADATA,
  FIELD_RESOLVER_COMPOSITION_METADATA,
  FIELD_RESOLVER_MIDDLEWARE_METADATA,
  FIELD_TYPENAME,
  Field,
  type FieldMiddleware,
  FileSystemHelper,
  GRAPHQL_MODULE_ID,
  GRAPHQL_MODULE_OPTIONS,
  GRAPHQL_SDL_FILE_END,
  GRAPHQL_SDL_FILE_HEADER,
  GqlArgumentsHost,
  type GqlExceptionFilter,
  GqlExecutionContext,
  type GqlModuleOptions,
  type GqlOptionsFactory,
  GqlSubscriptionService,
  GraphQLAstExplorer,
  GraphQLDefinitionsFactory,
  GraphQLFactory,
  GraphQLFederationDefinitionsFactory,
  GraphQLFederationFactory,
  GraphQLISODateTime,
  GraphQLModule,
  GraphQLObjectType,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  GraphQLService,
  GraphQLString,
  GraphQLTimestamp,
  GraphQLTypesLoader,
  HIDE_FIELD_METADATA,
  ID,
  InputType,
  Int,
  InterfaceType,
  IntersectionType,
  Kind,
  Mutation,
  ObjectType,
  OmitType,
  PARAM_ARGS_METADATA,
  Parent,
  PartialType,
  PickType,
  Query,
  RESOLVER_DELEGATE_METADATA,
  RESOLVER_NAME_METADATA,
  RESOLVER_PROPERTY_METADATA,
  RESOLVER_REFERENCE_KEY,
  RESOLVER_REFERENCE_METADATA,
  RESOLVER_TYPE_METADATA,
  ResolveField,
  ResolveProperty,
  ResolveReference,
  Resolver,
  ResolverDecoratorHost,
  SCALAR_NAME_METADATA,
  SCALAR_TYPE_METADATA,
  SUBSCRIPTION_OPTIONS_METADATA,
  SUBSCRIPTION_TYPE,
  Scalar,
  TypeMetadataStorage,
  UnableToFindFieldsError,
  UseFieldMiddleware,
  addFieldMetadata,
  createUnionType,
  extend,
  getFieldsAndDecoratorForType,
  isObjectType,
  parse,
  printSchema,
  registerEnumType,
  transformSchema,
} from "../src/index";

describe("@bunest/graphql NestJS v14 API Parity", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await Promise.resolve(cleanups.pop()!()).catch(() => {});
    }
  });

  test("exports all 23 NestJS GraphQL metadata constants & tokens with exact values", () => {
    expect(ARGS_TYPE_METADATA).toBe("graphql:args_type");
    expect(CLASS_TYPE_METADATA).toBe("graphql:class_type");
    expect(CONTEXT).toBe(REQUEST);
    expect(DEFINITIONS_FILE_HEADER).toContain(
      "THIS FILE WAS AUTOMATICALLY GENERATED",
    );
    expect(FIELD_MIDDLEWARE_METADATA).toBe("graphql:field_middleware");
    expect(FIELD_RESOLVER_COMPOSITION_METADATA).toBe(
      "graphql:field_resolver_composition",
    );
    expect(FIELD_RESOLVER_MIDDLEWARE_METADATA).toBe(
      "graphql:field_resolver_middleware",
    );
    expect(FIELD_TYPENAME).toBe("__resolveType");
    expect(GRAPHQL_MODULE_ID).toBe("GqlModuleId");
    expect(GRAPHQL_SDL_FILE_END).toBe("\n");
    expect(GRAPHQL_SDL_FILE_HEADER).toContain(
      "THIS FILE WAS AUTOMATICALLY GENERATED",
    );
    expect(HIDE_FIELD_METADATA).toBe("graphql:hide_field");
    expect(PARAM_ARGS_METADATA).toBe("__routeArguments__");
    expect(RESOLVER_DELEGATE_METADATA).toBe("graphql:delegate_property");
    expect(RESOLVER_NAME_METADATA).toBe("graphql:resolver_name");
    expect(RESOLVER_PROPERTY_METADATA).toBe("graphql:resolve_property");
    expect(RESOLVER_REFERENCE_KEY).toBe("__resolveReference");
    expect(RESOLVER_REFERENCE_METADATA).toBe("graphql:resolve_reference");
    expect(RESOLVER_TYPE_METADATA).toBe("graphql:resolver_type");
    expect(SCALAR_NAME_METADATA).toBe("graphql:scalar_name");
    expect(SCALAR_TYPE_METADATA).toBe("graphql:scalar_type");
    expect(SUBSCRIPTION_OPTIONS_METADATA).toBe("graphql:subscription_options;");
    expect(SUBSCRIPTION_TYPE).toBe("Subscription");
    expect(GRAPHQL_MODULE_OPTIONS).toBeDefined();
  });

  test("GraphQLISODateTime & GraphQLTimestamp scalars serialize, parseValue, parseLiteral, and reject invalid inputs", () => {
    const sampleDate = new Date("2026-05-01T12:30:00.000Z");

    expect(GraphQLISODateTime.name).toBe("DateTime");
    expect(GraphQLISODateTime.serialize(sampleDate)).toBe(
      "2026-05-01T12:30:00.000Z",
    );
    expect(GraphQLISODateTime.parseValue("2026-05-01T12:30:00.000Z")).toEqual(
      sampleDate,
    );
    expect(
      GraphQLISODateTime.parseLiteral({
        kind: Kind.STRING,
        value: "2026-05-01T12:30:00.000Z",
      }),
    ).toEqual(sampleDate);
    expect(() => GraphQLISODateTime.parseValue("not-a-date")).toThrow();
    expect(() => GraphQLISODateTime.parseValue({ bad: true })).toThrow();
    expect(() =>
      GraphQLISODateTime.parseLiteral({ kind: Kind.INT, value: "123" }),
    ).toThrow();

    expect(GraphQLTimestamp.name).toBe("Timestamp");
    expect(GraphQLTimestamp.serialize(sampleDate)).toBe(sampleDate.getTime());
    expect(GraphQLTimestamp.parseValue(sampleDate.getTime())).toEqual(
      sampleDate,
    );
    expect(
      GraphQLTimestamp.parseLiteral({
        kind: Kind.INT,
        value: String(sampleDate.getTime()),
      }),
    ).toEqual(sampleDate);
    expect(() => GraphQLTimestamp.parseValue("invalid")).toThrow();
    expect(() =>
      GraphQLTimestamp.parseLiteral({ kind: Kind.BOOLEAN, value: true }),
    ).toThrow();
  });

  test("wires buildSchemaOptions (dateScalarMode, numberScalarMode, fieldMiddleware), @UseFieldMiddleware(), @ResolveProperty, @InputType({ isOneOf }), and @ObjectType({ inheritDescription })", async () => {
    const trace: string[] = [];

    const globalMw: FieldMiddleware = async (ctx, next) => {
      trace.push(`global:${ctx.info?.fieldName}`);
      return next();
    };
    const optionMw: FieldMiddleware = async (_ctx, next) => {
      trace.push("option");
      const val = await next();
      return typeof val === "string" ? `[opt:${val}]` : val;
    };
    const upperMw: FieldMiddleware = async (_ctx, next) => {
      trace.push("upper");
      const val = await next();
      return typeof val === "string" ? val.toUpperCase() : val;
    };
    const trimMw: FieldMiddleware = async (_ctx, next) => {
      trace.push("trim");
      const val = await next();
      return typeof val === "string" ? val.trim() : val;
    };

    @ObjectType({
      description: "Inherited base description",
      inheritDescription: true,
    })
    class BaseDoc {
      @Field(() => ID)
      id!: string;
    }

    @ObjectType()
    class EventRecord extends BaseDoc {
      @UseFieldMiddleware(upperMw)
      @UseFieldMiddleware(trimMw)
      @Field({ middleware: [optionMw] })
      title!: string;

      @Field(() => Date)
      createdAt!: Date;

      @Field(() => Number)
      count!: number;

      @Field({ nullable: true })
      computed?: string;
    }

    @InputType({ isOneOf: true })
    class LookupByOneOf {
      @Field({ nullable: true })
      id?: string;

      @Field({ nullable: true })
      slug?: string;
    }

    @Resolver(() => EventRecord)
    class EventResolver {
      @Query(() => EventRecord)
      event(
        @Args("lookup", {
          type: () => LookupByOneOf,
          nullable: true,
          deprecationReason: "Use id instead",
        })
        _lookup?: LookupByOneOf,
      ) {
        return {
          id: "e1",
          title: "  hello world  ",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          count: 42,
        };
      }

      @UseFieldMiddleware(upperMw)
      @ResolveProperty("computed", () => String, {
        middleware: [optionMw],
        complexity: 5,
      })
      computeSummary(@Parent() rec: EventRecord) {
        return `sum-${rec.id}`;
      }
    }

    @Module({
      imports: [
        GraphQLModule.forRoot({
          buildSchemaOptions: {
            dateScalarMode: "timestamp",
            numberScalarMode: "integer",
            fieldMiddleware: [globalMw],
          },
        }),
      ],
      providers: [EventResolver],
    })
    class MwAppModule {}

    const app = await BunestFactory.create(MwAppModule, { logger: false });
    cleanups.push(() => app.close());
    await app.init();

    const gql = app.get(GraphQLService);
    const sdl = gql.printSDL();
    expect(sdl).toContain("scalar Timestamp");
    expect(sdl).toContain("count: Int!");
    expect(sdl).toContain('"""Inherited base description"""');
    expect(sdl).toContain("input LookupByOneOf @oneOf");
    expect(sdl).toContain('@deprecated(reason: "Use id instead")');

    const res = await gql.executeQuery({
      query: `{ event(lookup: { id: "e1" }) { id title createdAt count computed } }`,
    });
    expect(res.status).toBe(200);
    // Middleware order for `title`: global -> option -> trim (lowest) -> upper (highest)
    // Inner value "  hello world  " -> upper -> "  HELLO WORLD  " -> trim -> "HELLO WORLD" -> option -> "[opt:HELLO WORLD]"
    expect(res.result.data).toEqual({
      event: {
        id: "e1",
        title: "[opt:HELLO WORLD]",
        createdAt: new Date("2026-06-01T00:00:00.000Z").getTime(),
        count: 42,
        computed: "[opt:SUM-E1]",
      },
    });
    expect(trace).toContain("global:title");
    expect(trace).toContain("global:computed");
    const titleStart = trace.indexOf("global:title");
    expect(trace.slice(titleStart, titleStart + 4)).toEqual([
      "global:title",
      "option",
      "trim",
      "upper",
    ]);
  });

  test("GqlArgumentsHost, GqlExecutionContext (switchToHttp/Ws/Rpc, getArgByIndex, setType), GqlExceptionFilter, and fieldResolverEnhancers", async () => {
    const events: string[] = [];

    class BlockFieldGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        const gqlCtx = GqlExecutionContext.create(ctx);
        expect(gqlCtx.getArgByIndex(3)).toBe(gqlCtx.getInfo());
        expect(gqlCtx.switchToHttp().getRequest()).toBeDefined();
        expect(gqlCtx.switchToWs().getPattern()).toBe(
          gqlCtx.getInfo().fieldName,
        );
        expect(gqlCtx.switchToRpc().getData()).toBe(gqlCtx.getArgs());
        gqlCtx.setType("custom-gql");
        expect(gqlCtx.getType<string>()).toBe("custom-gql");
        events.push(`guard:${gqlCtx.getInfo().fieldName}`);
        return false;
      }
    }

    @Catch(Error)
    class ParityGqlFilter implements GqlExceptionFilter<Error, string> {
      catch(exception: Error, host: ArgumentsHost): string {
        const gqlHost = GqlArgumentsHost.create(host);
        expect(gqlHost.getType()).toBe("graphql");
        expect(gqlHost.getInfo().fieldName).toBe("boom");
        expect(gqlHost.getArgs()).toEqual({ tag: "x" });
        return `caught:${gqlHost.getInfo().fieldName}:${exception.message}`;
      }
    }

    @ObjectType()
    class Item {
      @Field()
      name!: string;
    }

    @Resolver(() => Item)
    class GuardedItemResolver {
      @Query(() => Item)
      item() {
        return { name: "widget" };
      }

      @UseGuards(BlockFieldGuard)
      @ResolveField(() => String)
      label(@Parent() item: Item) {
        return item.name;
      }

      @UseFilters(ParityGqlFilter)
      @Query(() => String)
      boom(@Args("tag") _tag: string) {
        throw new Error("kaboom");
      }
    }

    // With `fieldResolverEnhancers: []`, guards on @ResolveField are skipped!
    @Module({
      imports: [
        GraphQLModule.forRoot({
          fieldResolverEnhancers: [],
        }),
      ],
      providers: [GuardedItemResolver, BlockFieldGuard, ParityGqlFilter],
    })
    class EnhancerModule {}

    const app = await BunestFactory.create(EnhancerModule, { logger: false });
    cleanups.push(() => app.close());
    await app.init();

    const gql = app.get(GraphQLService);
    const res = await gql.executeQuery({
      query: `{ item { name label } boom(tag: "x") }`,
    });
    expect(res.result.data).toEqual({
      item: { name: "widget", label: "widget" },
      boom: "caught:boom:kaboom",
    });
    expect(events).toEqual([]);
  });

  test("GraphQLModule.forRootAsync supports useClass & useExisting with GqlOptionsFactory, plus ResolverDecoratorHost request hooks", async () => {
    const hookLog: string[] = [];

    @Injectable()
    class GqlConfigService implements GqlOptionsFactory {
      createGqlOptions(): GqlModuleOptions {
        return {
          path: "/gql-async",
          typeDefs: `type Query { greeting(name: String!): String! }`,
          resolvers: {
            Query: {
              greeting: (_p, args: { name: string }) => `Hi ${args.name}`,
            },
          },
        };
      }
    }

    // 1. useClass
    @Module({
      imports: [
        GraphQLModule.forRootAsync({
          path: "/gql-async",
          useClass: GqlConfigService,
        }),
      ],
    })
    class UseClassAppModule {}

    const app1 = await BunestFactory.create(UseClassAppModule, {
      logger: false,
    });
    cleanups.push(() => app1.close());
    await app1.init();

    const decoratorHost = app1.get(ResolverDecoratorHost);
    decoratorHost.setOnRequestStartHook((ctx) => {
      hookLog.push(`start:${ctx.query?.trim()}`);
      return { token: 123 };
    });
    decoratorHost.setOnRequestEndHook((ctx) => {
      hookLog.push(`end:${(ctx.state as { token: number }).token}`);
    });

    const r1 = await app1.fetch(
      new Request("http://localhost/gql-async", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `{ greeting(name: "Class") }` }),
      }),
    );
    expect(await r1.json()).toEqual({ data: { greeting: "Hi Class" } });
    expect(hookLog).toEqual(['start:{ greeting(name: "Class") }', "end:123"]);

    // Regression: rejecting async onRequestStart & onRequestEnd hooks must not crash executeQuery or leak unhandled rejections
    let unhandledRejections = 0;
    const onUnhandled = () => {
      unhandledRejections++;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let endSawState: unknown = "unset";
      decoratorHost.setOnRequestStartHook(async () => {
        throw new Error("async start hook failure");
      });
      decoratorHost.setOnRequestEndHook(async (ctx) => {
        endSawState = ctx.state;
        throw new Error("async end hook failure");
      });

      const r1HookFail = await app1.fetch(
        new Request("http://localhost/gql-async", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: `{ greeting(name: "Resilient") }` }),
        }),
      );
      expect(r1HookFail.status).toBe(200);
      expect(await r1HookFail.json()).toEqual({
        data: { greeting: "Hi Resilient" },
      });
      expect(endSawState).toBeUndefined();
      await Bun.sleep(10);
      expect(unhandledRejections).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // 2. useExisting
    @Module({
      providers: [GqlConfigService],
      exports: [GqlConfigService],
    })
    class ConfigProviderModule {}

    @Module({
      imports: [
        ConfigProviderModule,
        GraphQLModule.forRootAsync({
          path: "/gql-existing",
          imports: [ConfigProviderModule],
          useExisting: GqlConfigService,
        }),
      ],
    })
    class UseExistingAppModule {}

    const app2 = await BunestFactory.create(UseExistingAppModule, {
      logger: false,
    });
    cleanups.push(() => app2.close());
    await app2.init();

    const r2 = await app2.fetch(
      new Request("http://localhost/gql-existing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `{ greeting(name: "Existing") }` }),
      }),
    );
    expect(await r2.json()).toEqual({ data: { greeting: "Hi Existing" } });
  });

  test("transformSchema utility & GraphQLModuleOptions.transformSchema / transformAutoSchemaFile / include allowlist / CustomScalar(specifiedByURL, extensions)", async () => {
    const tmpDir = join(
      Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
      `bunest-gql-parity-${crypto.randomUUID()}`,
    );
    await ensureDir(tmpDir);
    cleanups.push(() => removePath(tmpDir, { recursive: true, force: true }));
    const autoSchemaPath = join(tmpDir, "schema.gql");

    @Scalar("EmailScalar")
    class EmailScalarImpl implements CustomScalar<string, string> {
      description = "Email address scalar";
      specifiedByURL = "https://datatracker.ietf.org/doc/html/rfc5322";
      extensions = { category: "contact" };
      parseValue(value: unknown): string {
        return String(value);
      }
      serialize(value: string): string {
        return value;
      }
      parseLiteral(ast: any): string {
        return String(ast.value ?? "");
      }
    }

    @Resolver()
    class IncludedResolver {
      @Query(() => String)
      kept() {
        return "yes";
      }
    }

    @Resolver()
    class ExcludedResolver {
      @Query(() => String)
      excluded() {
        return "no";
      }
    }

    @Module({ providers: [IncludedResolver, EmailScalarImpl] })
    class IncludedModule {}

    @Module({ providers: [ExcludedResolver] })
    class ExcludedModule {}

    @Module({
      imports: [
        IncludedModule,
        ExcludedModule,
        GraphQLModule.forRoot({
          include: [IncludedModule],
          autoSchemaFile: autoSchemaPath,
          transformAutoSchemaFile: true,
          buildSchemaOptions: { addNewlineAtEnd: true },
          transformSchema: (schema) =>
            transformSchema(schema, (type) => {
              if (isObjectType(type) && type.name === "Query") {
                const cfg = type.toConfig();
                return new GraphQLObjectType({
                  ...cfg,
                  fields: {
                    ...cfg.fields,
                    injected: {
                      type: GraphQLString,
                      resolve: () => "transformed!",
                    },
                  },
                });
              }
              return type;
            }),
        }),
      ],
    })
    class TransformAppModule {}

    const app = await BunestFactory.create(TransformAppModule, {
      logger: false,
    });
    cleanups.push(() => app.close());
    await app.init();

    const gql = app.get(GraphQLService);
    const schema = gql.getSchema();
    const emailType = schema.getType("EmailScalar") as any;
    expect(emailType?.specifiedByURL).toBe(
      "https://datatracker.ietf.org/doc/html/rfc5322",
    );
    expect(emailType?.extensions).toEqual({ category: "contact" });

    const writtenSdl = await Bun.file(autoSchemaPath).text();
    expect(writtenSdl).toContain("kept: String!");
    expect(writtenSdl).toContain("injected: String");
    expect(writtenSdl).not.toContain("excluded");

    const res = await gql.executeQuery({ query: `{ kept injected }` });
    expect(res.result.data).toEqual({ kept: "yes", injected: "transformed!" });
  });

  test("TypeMetadataStorage, addFieldMetadata, getFieldsAndDecoratorForType, UnableToFindFieldsError, Mapped Types, and extend()", () => {
    class FeatureModA {}
    class FeatureModB {}

    enum SampleKind {
      ALPHA = "ALPHA",
      BETA = "BETA",
    }
    registerEnumType(SampleKind, {
      name: "SampleKind",
      registerIn: FeatureModA,
    });

    @ObjectType("StoredUser", { registerIn: FeatureModA })
    class StoredUser {
      @Field(() => ID)
      id!: string;

      @Field()
      email!: string;
    }

    addFieldMetadata(
      () => String,
      { description: "Added dynamically" },
      StoredUser.prototype,
      "nickname",
    );

    @ObjectType({ registerIn: FeatureModB })
    class OtherModel {
      @Field()
      code!: string;
    }

    const StoredUnion = createUnionType({
      name: "StoredUnion",
      types: () => [StoredUser, OtherModel] as const,
      registerIn: FeatureModA,
    });
    expect(StoredUnion.name).toBe("StoredUnion");

    expect(
      TypeMetadataStorage.getObjectTypeMetadataByTarget(StoredUser)?.name,
    ).toBe("StoredUser");
    expect(
      TypeMetadataStorage.getObjectTypesMetadataByModules([FeatureModA]).some(
        (m) => m.target === StoredUser,
      ),
    ).toBe(true);
    expect(
      TypeMetadataStorage.getObjectTypesMetadataByModules([FeatureModA]).some(
        (m) => m.target === OtherModel,
      ),
    ).toBe(false);
    expect(
      TypeMetadataStorage.getEnumsMetadataByModules([FeatureModA]).some(
        (e) => e.name === "SampleKind",
      ),
    ).toBe(true);

    const { fields, decoratorFactory } =
      getFieldsAndDecoratorForType(StoredUser);
    expect(decoratorFactory).toBe(ObjectType);
    expect(fields.map((f) => f.name)).toEqual(["id", "email", "nickname"]);

    class PlainClass {}
    expect(() => getFieldsAndDecoratorForType(PlainClass)).toThrow(
      UnableToFindFieldsError,
    );

    // Mapped types with decorator factory `InputType` remain 100% intact
    const UpdateUserInput = PartialType(StoredUser, InputType);
    const PickedUser = PickType(StoredUser, ["id"], InputType);
    const OmittedUser = OmitType(StoredUser, ["email"], ObjectType);
    const MergedType = IntersectionType(PickedUser, OmittedUser, ObjectType);

    expect(getFieldsAndDecoratorForType(UpdateUserInput).decoratorFactory).toBe(
      InputType,
    );
    expect(
      getFieldsAndDecoratorForType(PickedUser).fields.map((f) => f.name),
    ).toEqual(["id"]);
    expect(
      getFieldsAndDecoratorForType(OmittedUser).fields.map((f) => f.name),
    ).not.toContain("email");
    expect(
      getFieldsAndDecoratorForType(MergedType).fields.length,
    ).toBeGreaterThanOrEqual(2);

    // extend() helper
    expect(extend("type A { id: ID }", "type B { name: String }")).toEqual([
      "type A { id: ID }",
      "type B { name: String }",
    ]);
    expect(extend(["a"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(extend({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("GraphQLTypesLoader, GraphQLAstExplorer, GraphQLDefinitionsFactory, GraphQLFederationDefinitionsFactory, FileSystemHelper, GraphQLFactory, GraphQLFederationFactory, GraphQLSchemaBuilderModule, AbstractGraphQLDriver, BaseExplorerService, and GqlSubscriptionService", async () => {
    const tmpDir = join(
      Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
      `bunest-gql-codegen-${crypto.randomUUID()}`,
    );
    await ensureDir(tmpDir);
    cleanups.push(() => removePath(tmpDir, { recursive: true, force: true }));

    const sdlFile = join(tmpDir, "users.graphql");
    const outInterfaceFile = join(tmpDir, "generated", "graphql.interfaces.ts");
    const outClassFile = join(tmpDir, "generated", "graphql.classes.ts");
    const outFedFile = join(tmpDir, "generated", "federation.ts");

    await Bun.write(
      sdlFile,
      `
      scalar DateTime
      enum Role { ADMIN USER }
      interface Node { id: ID! }
      """A system user"""
      type User implements Node {
        id: ID!
        name: String!
        role: Role
        createdAt: DateTime
      }
      union SearchHit = User
      type Query {
        user(id: ID!): User
      }
      `,
    );

    // 1. GraphQLTypesLoader with glob
    const loader = new GraphQLTypesLoader();
    const mergedSdl = await loader.mergeTypesByPaths([
      join(tmpDir, "*.graphql"),
    ]);
    expect(mergedSdl).toContain("type User implements Node");

    // 2. GraphQLDefinitionsFactory (interface & class modes)
    const defsFactory = new GraphQLDefinitionsFactory();
    await defsFactory.generate({
      typePaths: [join(tmpDir, "*.graphql")],
      path: outInterfaceFile,
      outputAs: "interface",
      emitTypenameField: true,
      emitDescriptions: true,
      enumsAsTypes: true,
      customScalarTypeMapping: { DateTime: "Date" },
    });
    const ifaceCode = await Bun.file(outInterfaceFile).text();
    expect(ifaceCode).toContain("export type DateTime = Date;");
    expect(ifaceCode).toContain("export type Role = 'ADMIN' | 'USER';");
    expect(ifaceCode).toContain("export interface User extends Node");
    expect(ifaceCode).toContain("__typename?: 'User';");
    expect(ifaceCode).toContain("/** A system user */");
    expect(ifaceCode).toContain("export interface IQuery");

    await defsFactory.generate({
      typePaths: [join(tmpDir, "*.graphql")],
      path: outClassFile,
      outputAs: "class",
    });
    const classCode = await Bun.file(outClassFile).text();
    expect(classCode).toContain("export enum Role");
    expect(classCode).toContain("export class User implements Node");
    expect(classCode).toContain("export abstract class IQuery");

    // 3. GraphQLFederationDefinitionsFactory strips _Any/_Entity/_Service
    const fedDefs = new GraphQLFederationDefinitionsFactory();
    await fedDefs.generate({
      typePaths: [],
      typeDefs: `
        scalar _Any
        type _Service { sdl: String }
        type Product { id: ID! sku: String! }
      `,
      path: outFedFile,
      outputAs: "interface",
    });
    const fedCode = await Bun.file(outFedFile).text();
    expect(fedCode).toContain("export interface Product");
    expect(fedCode).not.toContain("_Service");
    expect(fedCode).not.toContain("_Any");

    // 4. FileSystemHelper & GraphQLAstExplorer unit checks
    const fsHelper = new FileSystemHelper();
    expect(fsHelper.getDirs("a/b/c/file.ts")).toEqual(["a", "b", "c"]);
    const astExplorer = new GraphQLAstExplorer();
    expect(astExplorer.isRoot("Query")).toBe(true);
    expect(astExplorer.addSymbolIfRoot("Mutation")).toBe("IMutation");
    expect(astExplorer.addSymbolIfRoot("User")).toBe("User");

    // 5. GraphQLFactory, GraphQLFederationFactory, GraphQLSchemaBuilderModule
    const gqlFactory = new GraphQLFactory();
    const schemaFromFactory = await gqlFactory.generateSchema({
      typePaths: [join(tmpDir, "*.graphql")],
    });
    expect(printSchema(schemaFromFactory)).toContain(
      "type User implements Node",
    );

    @Directive('@key(fields: "id")')
    @ObjectType()
    class FedProduct {
      @Field(() => ID)
      id!: string;
    }

    @Resolver(() => FedProduct)
    class FedProductResolver {
      @Query(() => FedProduct)
      product() {
        return { id: "p1" };
      }

      @ResolveReference()
      resolveRef(ref: { id: string }) {
        return { id: ref.id };
      }
    }

    const fedFactory = new GraphQLFederationFactory();
    const fedSchema = await fedFactory.buildFederatedSchema(
      { federation: 2 },
      {},
      [new FedProductResolver()],
    );
    expect(printSchema(fedSchema)).toContain("_entities");
    expect(printSchema(fedSchema)).toContain("_service");

    const builderApp = await BunestFactory.create(GraphQLSchemaBuilderModule, {
      logger: false,
    });
    cleanups.push(() => builderApp.close());
    expect(builderApp.get(GraphQLSchemaFactory)).toBeInstanceOf(
      GraphQLSchemaFactory,
    );

    // 6. AbstractGraphQLDriver subclass
    class CustomDriver extends AbstractGraphQLDriver {
      started = false;
      stopped = false;
      async start(_opts: GqlModuleOptions): Promise<void> {
        this.started = true;
      }
      async stop(): Promise<void> {
        this.stopped = true;
      }
    }
    const driver = new CustomDriver();
    const mergedOpts = await driver.mergeDefaultOptions({ path: "/custom" });
    expect(mergedOpts.path).toBe("/custom");
    await driver.start(mergedOpts);
    expect(driver.started).toBe(true);
    await driver.stop();
    expect(driver.stopped).toBe(true);

    // 7. BaseExplorerService
    const explorer = new BaseExplorerService();
    class BaseRes {}
    class DerivedRes extends BaseRes {}
    const grouped = explorer.groupMetadata([
      {
        type: "Query",
        name: "hello",
        methodName: "hello",
        target: BaseRes,
        declaredOn: BaseRes,
        callback: () => "base",
      },
      {
        type: "Query",
        name: "hello",
        methodName: "hello",
        target: DerivedRes,
        declaredOn: DerivedRes,
        callback: () => "derived",
      },
    ]);
    expect((grouped.Query!.hello as () => string)()).toBe("derived");
    const gqlCtx: Record<string | symbol, any> = {};
    const ctxId = explorer.getContextId(gqlCtx);
    expect(explorer.getContextId(gqlCtx)).toBe(ctxId);

    // 8. GqlSubscriptionService
    const subService = new GqlSubscriptionService({
      schema: schemaFromFactory,
      path: "/graphql",
      "graphql-ws": true,
    });
    expect(subService.getHandler().getPath()).toBe("/graphql");
    await subService.stop();
  });
});
