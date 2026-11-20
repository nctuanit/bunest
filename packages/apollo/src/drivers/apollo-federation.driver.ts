import { Injectable, MetadataRegistry, Optional, type Type } from "@bunest/common";
import {
  ApplicationConfig,
  DiscoveryService,
  HttpAdapterHost,
  ModulesContainer,
} from "@bunest/core";
import {
  extend,
  getGraphQLDirectives,
  GqlSubscriptionService,
  GRAPHQL_METADATA_KEYS,
  GraphQLFactory,
  GraphQLFederationFactory,
  GraphQLService,
  ResolverDecoratorHost,
  TypeMetadataStorage,
} from "@bunest/graphql";
import {
  type GraphQLFieldConfig,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  isObjectType,
  Kind,
  parse,
  printSchema,
} from "graphql";
import type { ApolloDriverConfig } from "../interfaces/apollo-driver-config.interface";
import { PluginsExplorerService } from "../services/plugins-explorer.service";
import { ApolloFederationDefinitionsFactory } from "../utils/federation-definitions.factory";
import { ApolloBaseDriver } from "./apollo-base.driver";

const FEDERATION_V2_DIRECTIVE_PREAMBLE = `
scalar _FieldSet
directive @key(fields: String!, resolvable: Boolean = true) repeatable on OBJECT | INTERFACE
directive @external on FIELD_DEFINITION | OBJECT
directive @requires(fields: String!) on FIELD_DEFINITION
directive @provides(fields: String!) on FIELD_DEFINITION
directive @extends on OBJECT | INTERFACE
directive @shareable repeatable on OBJECT | FIELD_DEFINITION
directive @inaccessible on FIELD_DEFINITION | OBJECT | INTERFACE | UNION | ARGUMENT_DEFINITION | SCALAR | ENUM | ENUM_VALUE | INPUT_OBJECT | INPUT_FIELD_DEFINITION
directive @override(from: String!) on FIELD_DEFINITION
directive @tag(name: String!) repeatable on FIELD_DEFINITION | INTERFACE | OBJECT | UNION | ARGUMENT_DEFINITION | SCALAR | ENUM | ENUM_VALUE | INPUT_OBJECT | INPUT_FIELD_DEFINITION
`;

function extractEntityTypeNamesFromSdl(sdl: string): string[] {
  const names: string[] = [];
  try {
    const doc = parse(sdl);
    for (const def of doc.definitions) {
      if (
        (def.kind === Kind.OBJECT_TYPE_DEFINITION ||
          def.kind === Kind.OBJECT_TYPE_EXTENSION) &&
        def.directives?.some((d) => d.name.value === "key")
      ) {
        if (!names.includes(def.name.value)) {
          names.push(def.name.value);
        }
      }
    }
  } catch {
    // Ignore parse errors; main schema build reports them
  }
  return names;
}

function buildSubgraphSdlWithDirectives(
  schema: GraphQLSchema,
  rawTypeDefs?: string | readonly string[],
): string {
  if (rawTypeDefs !== undefined) {
    const raw =
      typeof rawTypeDefs === "string" ? rawTypeDefs : rawTypeDefs.join("\n");
    if (raw.trim().length > 0) {
      return raw;
    }
  }

  let sdl = printSchema(schema);

  // Inject code-first @Directive('@key(...)') annotations on @ObjectType classes
  for (const meta of TypeMetadataStorage.getObjectTypesMetadata()) {
    const dirs = getGraphQLDirectives(meta.target);
    if (!dirs || dirs.length === 0) continue;
    const typeName = meta.name;
    const directiveStr = dirs.join(" ");
    const pattern = new RegExp(`(type\\s+${typeName}\\b[^\\{]*)\\{`);
    sdl = sdl.replace(pattern, (match, head) => {
      if (head.includes("@key")) return match;
      return `${head.trimEnd()} ${directiveStr} {`;
    });
  }

  return sdl;
}

function ensureFederationSubgraphSchema(
  schema: GraphQLSchema,
  subgraphSdl: string,
  options: ApolloDriverConfig,
): GraphQLSchema {
  const queryType = schema.getQueryType();
  const existingFields = queryType?.getFields();

  // If code-first federation already added `_service`, just patch its SDL resolver
  if (existingFields?._service) {
    existingFields._service.resolve = () => ({ sdl: subgraphSdl });
    const serviceType = schema.getType("_Service");
    if (isObjectType(serviceType)) {
      const sdlField = serviceType.getFields().sdl;
      if (sdlField) {
        sdlField.resolve = (parent: any) => parent?.sdl ?? subgraphSdl;
      }
    }
    return schema;
  }

  if (!queryType) {
    return schema;
  }

  const anyScalar =
    (schema.getType("_Any") as GraphQLScalarType | undefined) ??
    new GraphQLScalarType({
      name: "_Any",
      serialize: (v) => v,
      parseValue: (v) => v,
      parseLiteral: (ast: any) => ast?.value,
    });

  const serviceObjType =
    (schema.getType("_Service") as GraphQLObjectType | undefined) ??
    new GraphQLObjectType({
      name: "_Service",
      fields: {
        sdl: {
          type: GraphQLString,
          resolve: (parent: any) => parent?.sdl ?? subgraphSdl,
        },
      },
    });

  const entityTypeNames = extractEntityTypeNamesFromSdl(subgraphSdl);
  const entityObjectTypes = entityTypeNames
    .map((n) => schema.getType(n))
    .filter((t): t is GraphQLObjectType => isObjectType(t));

  // Collect `__resolveReference` resolvers from schema-first `options.resolvers`
  const refResolvers = new Map<string, Function>();
  const rawResolversList = Array.isArray(options.resolvers)
    ? options.resolvers
    : options.resolvers
      ? [options.resolvers]
      : [];
  for (const map of rawResolversList) {
    if (!map || typeof map !== "object") continue;
    for (const [typeName, typeResolvers] of Object.entries(map)) {
      const fn = (typeResolvers as Record<string, any>)?.__resolveReference;
      if (typeof fn === "function") {
        refResolvers.set(typeName, fn);
      }
    }
  }

  const queryCfg = queryType.toConfig();
  const extraQueryFields: Record<string, GraphQLFieldConfig<any, any>> = {
    _service: {
      type: new GraphQLNonNull(serviceObjType),
      resolve: () => ({ sdl: subgraphSdl }),
    },
  };

  const extraTypes: any[] = [anyScalar, serviceObjType];

  if (entityObjectTypes.length > 0) {
    const entityUnion = new GraphQLUnionType({
      name: "_Entity",
      types: entityObjectTypes,
      resolveType: (value: any) => value?.__typename,
    });
    extraTypes.push(entityUnion);
    extraQueryFields._entities = {
      type: new GraphQLNonNull(new GraphQLList(entityUnion)),
      args: {
        representations: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(anyScalar))),
        },
      },
      resolve: async (_parent, args: { representations: any[] }, ctx, info) => {
        return await Promise.all(
          args.representations.map(async (rep) => {
            const typeName = rep?.__typename;
            const refFn = typeName ? refResolvers.get(typeName) : undefined;
            if (refFn) {
              const resolved = await refFn(rep, ctx, info);
              if (resolved && typeof resolved === "object" && !resolved.__typename) {
                return { __typename: typeName, ...resolved };
              }
              return resolved;
            }
            return rep;
          }),
        );
      },
    };
  }

  const newQuery = new GraphQLObjectType({
    ...queryCfg,
    fields: {
      ...queryCfg.fields,
      ...extraQueryFields,
    },
  });

  const schemaCfg = schema.toConfig();
  const types = schemaCfg.types
    .filter((t) => t.name !== queryType.name)
    .concat(newQuery, ...extraTypes);

  return new GraphQLSchema({
    ...schemaCfg,
    query: newQuery,
    types,
  });
}

/**
 * Bun-native Apollo Federation v2 Subgraph driver.
 *
 * @publicApi
 */
@Injectable()
export class ApolloFederationDriver extends ApolloBaseDriver {
  private readonly graphqlFederationFactory: GraphQLFederationFactory;
  private _subscriptionService?: GqlSubscriptionService;
  private readonly pluginsExplorerService: PluginsExplorerService;

  constructor(
    @Optional() graphqlFederationFactory?: GraphQLFederationFactory,
    @Optional() modulesContainer?: ModulesContainer,
    @Optional() httpAdapterHost?: HttpAdapterHost,
    @Optional() applicationConfig?: ApplicationConfig,
    @Optional() graphQlFactory?: GraphQLFactory,
    @Optional() resolverDecoratorHost?: ResolverDecoratorHost,
    @Optional() graphqlService?: GraphQLService,
    @Optional() discoveryService?: DiscoveryService,
  ) {
    super(
      httpAdapterHost,
      applicationConfig,
      graphQlFactory,
      resolverDecoratorHost,
      graphqlService,
      discoveryService,
    );
    this.graphqlFederationFactory =
      graphqlFederationFactory ?? new GraphQLFederationFactory();
    this.pluginsExplorerService = new PluginsExplorerService(
      modulesContainer,
      discoveryService,
    );
  }

  private discoverResolvers(options: ApolloDriverConfig): object[] {
    if (!this.discoveryService) {
      return [];
    }
    const discoveryOpts =
      options.include && options.include.length > 0
        ? { include: options.include as Type<unknown>[] }
        : undefined;
    const seen = new Set<object>();
    const resolvers: object[] = [];
    for (const wrapper of [
      ...this.discoveryService.getProviders(discoveryOpts),
      ...this.discoveryService.getControllers(discoveryOpts),
    ]) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== "object" || seen.has(instance)) {
        continue;
      }
      const ctor = (instance as { constructor?: Function }).constructor;
      if (
        typeof ctor === "function" &&
        (MetadataRegistry.has(GRAPHQL_METADATA_KEYS.RESOLVER, ctor) ||
          MetadataRegistry.has(GRAPHQL_METADATA_KEYS.SCALAR, ctor))
      ) {
        seen.add(instance);
        resolvers.push(instance);
      }
    }
    return resolvers;
  }

  override async start(options: ApolloDriverConfig): Promise<void> {
    options.plugins = extend(
      options.plugins || [],
      this.pluginsExplorerService.explore(options as any),
    );

    if (!options.schema) {
      options.schema = await this.generateSchema(options);
    }

    if (options.definitions?.path && options.schema) {
      const { path: outputPath, outputAs = "interface", ...rest } =
        options.definitions;
      const defsFactory = new ApolloFederationDefinitionsFactory();
      await defsFactory.generate({
        ...rest,
        typePaths: options.typePaths ?? [],
        path: outputPath,
        outputAs,
        typeDefs: printSchema(options.schema),
      });
    }

    await super.start(options);

    if (
      (options.installSubscriptionHandlers || options.subscriptions) &&
      options.schema
    ) {
      const subscriptionsOptions = this.getSubscriptionConfig(options);
      this._subscriptionService = new GqlSubscriptionService(
        {
          schema: options.schema,
          path: options.path,
          context: options.context as any,
          ...subscriptionsOptions,
        },
        this.httpAdapterHost?.httpAdapter,
      );
    }
  }

  override async generateSchema(
    options: ApolloDriverConfig,
  ): Promise<GraphQLSchema> {
    const resolvers = this.discoverResolvers(options);
    const rawTypeDefs = options.typeDefs;
    const preparedOptions: Record<string, any> = {
      ...(options as any),
      federation: options.federation ?? { version: 2 },
    };

    if (rawTypeDefs || (options.typePaths && options.typePaths.length > 0)) {
      const existing = Array.isArray(rawTypeDefs)
        ? [...rawTypeDefs]
        : rawTypeDefs
          ? [rawTypeDefs]
          : [];
      preparedOptions.typeDefs = [FEDERATION_V2_DIRECTIVE_PREAMBLE, ...existing];
    }

    const schema = await this.graphqlFederationFactory.generateSchema(
      preparedOptions,
      undefined,
      resolvers,
    );

    const subgraphSdl = buildSubgraphSdlWithDirectives(schema, rawTypeDefs);
    return ensureFederationSubgraphSchema(schema, subgraphSdl, options);
  }

  override async stop(): Promise<void> {
    await this._subscriptionService?.stop();
    this._subscriptionService = undefined;
    await super.stop();
  }
}
