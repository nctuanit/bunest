import { Injectable, Logger, Optional } from "@bunest/core";
import {
  ApplicationConfig,
  DiscoveryService,
  HttpAdapterHost,
  ModulesContainer,
} from "@bunest/core";
import {
  extend,
  GraphQLFactory,
  GraphQLService,
  ResolverDecoratorHost,
} from "../../index";
import { getVariableValues, GraphQLError, type GraphQLSchema } from "../../engine";
import { ApolloGateway } from "../gateway/apollo-gateway";
import type { ApolloGatewayDriverConfig } from "../interfaces/apollo-gateway-driver-config.interface";
import type {
  GatewayExecutor,
  GatewayInterface,
  GatewaySchemaLoadContext,
  GatewaySchemaLoadOrUpdateCallback,
} from "../server/apollo-server.types";
import { PluginsExplorerService } from "../services/plugins-explorer.service";
import { ApolloBaseDriver } from "./apollo-base.driver";

/**
 * Bun-native Apollo Federation Gateway driver composing multiple subgraphs
 * over native `fetch()` with live `transformSchema` support.
 *
 * @publicApi
 */
@Injectable()
export class ApolloGatewayDriver extends ApolloBaseDriver<ApolloGatewayDriverConfig> {
  private readonly logger = new Logger(ApolloGatewayDriver.name);
  private readonly pluginsExplorerService: PluginsExplorerService;

  constructor(
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
    this.pluginsExplorerService = new PluginsExplorerService(
      modulesContainer,
      discoveryService,
    );
  }

  override async start(options: ApolloGatewayDriverConfig): Promise<void> {
    options.server ??= {};
    options.server.plugins = extend(
      options.server.plugins || [],
      this.pluginsExplorerService.explore(
        options as { include?: Function[] },
      ),
    );

    const {
      server: serverOpts = {},
      gateway: gatewayOpts = {},
      transformSchema,
    } = options;

    const gateway = new ApolloGateway(gatewayOpts);
    await this.registerBunServer({
      ...(serverOpts as ApolloGatewayDriverConfig),
      gateway: transformSchema
        ? this.wrapGatewayWithSchemaTransform(gateway, transformSchema)
        : gateway,
    });
  }

  private wrapGatewayWithSchemaTransform(
    gateway: GatewayInterface,
    transformSchema: (
      schema: GraphQLSchema,
    ) => GraphQLSchema | Promise<GraphQLSchema>,
  ): GatewayInterface {
    const queuedListeners = new Set<GatewaySchemaLoadOrUpdateCallback>();
    let latestContext: GatewaySchemaLoadContext | undefined;
    let initialEmitted = false;

    const transformAndEmit = async (
      schemaContext: GatewaySchemaLoadContext,
    ) => {
      const apiSchema = await transformSchema(schemaContext.apiSchema);
      if (schemaContext !== latestContext) {
        return;
      }
      queuedListeners.forEach((listener) =>
        listener({ ...schemaContext, apiSchema }),
      );
    };

    gateway.onSchemaLoadOrUpdate((schemaContext) => {
      latestContext = schemaContext;
      if (!initialEmitted) {
        return;
      }
      transformAndEmit(schemaContext).catch((err) =>
        this.logger.error(
          "Failed to transform the updated supergraph schema. The previous schema remains in use.",
          err?.stack,
        ),
      );
    });

    return {
      load: async (loadOptions) => {
        const result = await gateway.load(loadOptions);
        let transformedContext: GatewaySchemaLoadContext | undefined;
        let lastTransformedSchema = result.schema;
        while (latestContext && transformedContext !== latestContext) {
          transformedContext = latestContext;
          const apiSchema = await transformSchema(transformedContext.apiSchema);
          if (transformedContext === latestContext) {
            lastTransformedSchema = apiSchema;
            queuedListeners.forEach((listener) =>
              listener({ ...transformedContext!, apiSchema }),
            );
          }
        }
        initialEmitted = true;
        return {
          ...result,
          schema: lastTransformedSchema,
          executor: result.executor
            ? this.checkOperationWithRequestSchema(result.executor)
            : undefined,
        };
      },
      onSchemaLoadOrUpdate: (callback) => {
        queuedListeners.add(callback);
        return () => {
          queuedListeners.delete(callback);
        };
      },
      stop: () => gateway.stop(),
    };
  }

  private checkOperationWithRequestSchema(
    executor: GatewayExecutor,
  ): GatewayExecutor {
    return async (requestContext) => {
      const { schema, operation, request } = requestContext;
      if (!operation) {
        return executor(requestContext);
      }
      if (!schema.getRootType(operation.operation)) {
        return {
          data: null,
          errors: [
            new GraphQLError(
              `Schema is not configured to execute ${operation.operation} operation.`,
              { nodes: operation },
            ),
          ],
        };
      }
      const { errors } = getVariableValues(
        schema,
        operation.variableDefinitions ?? [],
        request.variables ?? {},
        { maxErrors: 50 },
      );
      return errors ? { errors } : executor(requestContext);
    };
  }

  override async mergeDefaultOptions(
    options: ApolloGatewayDriverConfig,
  ): Promise<ApolloGatewayDriverConfig> {
    return {
      ...options,
      server: (await super.mergeDefaultOptions(
        (options?.server ?? {}) as ApolloGatewayDriverConfig,
      )) as ApolloGatewayDriverConfig["server"],
    };
  }

  override generateSchema(_: ApolloGatewayDriverConfig): null {
    return null;
  }
}
