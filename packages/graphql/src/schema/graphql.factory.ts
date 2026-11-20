import { Injectable, Module, Optional } from "@bunest/common";
import { type GraphQLSchema, parse, printSchema } from "graphql";
import type {
  AutoSchemaFileValue,
  BuildFederatedSchemaOptions,
  GqlModuleOptions,
  GraphQLModuleOptions,
} from "../interfaces/graphql.interface";
import { FileSystemHelper } from "./file-system.helper";
import { GraphQLAstExplorer } from "./graphql-ast.explorer";
import { GraphQLDefinitionsFactory } from "./graphql-definitions.factory";
import { GraphQLSchemaFactory } from "./graphql-schema.factory";
import { GraphQLTypesLoader } from "./graphql-types.loader";

/**
 * Programmatic GraphQL schema and definitions factory mirroring
 * `@nestjs/graphql` `GraphQLFactory`.
 */
@Injectable()
export class GraphQLFactory {
  private readonly schemaFactory: GraphQLSchemaFactory;
  private readonly definitionsFactory = new GraphQLDefinitionsFactory();

  constructor(
    @Optional() schemaFactory?: GraphQLSchemaFactory,
    @Optional() _scalarsExplorer?: unknown,
    @Optional() _astExplorer?: GraphQLAstExplorer,
    @Optional() _schemaBuilder?: unknown,
  ) {
    this.schemaFactory = schemaFactory ?? new GraphQLSchemaFactory();
  }

  async generateSchema<T extends GqlModuleOptions = GraphQLModuleOptions>(
    options: T = {} as T,
    resolvers: readonly object[] = [],
  ): Promise<GraphQLSchema> {
    const schema = await this.schemaFactory.create(resolvers, options);
    if (options.definitions?.path) {
      const sdl = printSchema(schema);
      await this.generateDefinitions(sdl, options);
    }
    return schema;
  }

  async generateDefinitions(
    typeDefs: string | string[],
    options: GqlModuleOptions,
  ): Promise<void> {
    if (!options.definitions?.path) {
      return;
    }
    const { path: outputPath, outputAs = "interface", ...rest } =
      options.definitions;
    await this.definitionsFactory.generate({
      ...rest,
      typePaths: options.typePaths ?? [],
      path: outputPath,
      outputAs,
      typeDefs,
    });
  }
}

/**
 * Federated subgraph schema factory mirroring `@nestjs/graphql`
 * `GraphQLFederationFactory` (zero external `@apollo/subgraph` runtime dependency).
 */
@Injectable()
export class GraphQLFederationFactory {
  private readonly schemaFactory: GraphQLSchemaFactory;
  private readonly typesLoader = new GraphQLTypesLoader();

  constructor(
    @Optional() schemaFactory?: GraphQLSchemaFactory,
    @Optional() _scalarsExplorer?: unknown,
    @Optional() _schemaBuilder?: unknown,
    @Optional() _typeDefsDecoratorFactory?: unknown,
  ) {
    this.schemaFactory = schemaFactory ?? new GraphQLSchemaFactory();
  }

  async generateSchema<T extends GqlModuleOptions = GraphQLModuleOptions>(
    options: T = {} as T,
    buildFederatedSchema?: (
      options: BuildFederatedSchemaOptions,
    ) => GraphQLSchema,
    resolvers: readonly object[] = [],
  ): Promise<GraphQLSchema> {
    if (buildFederatedSchema && (options.typeDefs || options.typePaths)) {
      const fromPaths = options.typePaths?.length
        ? await this.typesLoader.mergeTypesByPaths(options.typePaths)
        : "";
      const inline = Array.isArray(options.typeDefs)
        ? options.typeDefs.join("\n")
        : (options.typeDefs ?? "");
      const combined = [fromPaths, inline].filter(Boolean).join("\n");
      const schema = buildFederatedSchema({
        typeDefs: parse(combined),
        resolvers: options.resolvers,
      });
      return options.transformSchema
        ? await options.transformSchema(schema)
        : schema;
    }

    return this.schemaFactory.create(resolvers, {
      ...options,
      federation: options.federation ?? { version: 2 },
    });
  }

  async buildFederatedSchema<T extends GqlModuleOptions = GraphQLModuleOptions>(
    autoSchemaFile: AutoSchemaFileValue,
    options: T = {} as T,
    resolvers: readonly object[] = [],
  ): Promise<GraphQLSchema> {
    const federationConfig =
      typeof autoSchemaFile === "object" && autoSchemaFile?.federation
        ? typeof autoSchemaFile.federation === "number"
          ? { version: autoSchemaFile.federation }
          : autoSchemaFile.federation
        : (options.federation ?? { version: 2 });

    return this.schemaFactory.create(resolvers, {
      ...options,
      autoSchemaFile,
      federation: federationConfig,
    });
  }
}

/**
 * Standalone module exporting `GraphQLSchemaFactory` for programmatic
 * code-first schema generation outside `GraphQLModule.forRoot()`.
 */
@Module({
  providers: [
    GraphQLSchemaFactory,
    FileSystemHelper,
    GraphQLTypesLoader,
    GraphQLAstExplorer,
    GraphQLFactory,
    GraphQLFederationFactory,
  ],
  exports: [
    GraphQLSchemaFactory,
    FileSystemHelper,
    GraphQLTypesLoader,
    GraphQLAstExplorer,
    GraphQLFactory,
    GraphQLFederationFactory,
  ],
})
export class GraphQLSchemaBuilderModule {}
