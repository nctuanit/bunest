import { Injectable, Optional } from "@bunest/common";
import {
  ApplicationConfig,
  DiscoveryService,
  HttpAdapterHost,
  ModulesContainer,
} from "@bunest/core";
import {
  extend,
  GqlSubscriptionService,
  GraphQLFactory,
  GraphQLService,
  ResolverDecoratorHost,
} from "@bunest/graphql";
import { printSchema } from "graphql";
import type { ApolloDriverConfig } from "../interfaces/apollo-driver-config.interface";
import { PluginsExplorerService } from "../services/plugins-explorer.service";
import { ApolloBaseDriver } from "./apollo-base.driver";

/**
 * Bun-native Apollo Server GraphQL driver.
 *
 * @publicApi
 */
@Injectable()
export class ApolloDriver extends ApolloBaseDriver {
  private _subscriptionService?: GqlSubscriptionService;
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

  override async start(options: ApolloDriverConfig): Promise<void> {
    options.plugins = extend(
      options.plugins || [],
      this.pluginsExplorerService.explore(options as any),
    );

    if (!options.schema) {
      if (this.graphqlService) {
        options.schema = await this.graphqlService.ensureSchema();
      } else {
        const generated = await this.generateSchema(options);
        if (generated) {
          options.schema = generated;
        }
      }
    }

    if (options.definitions?.path && options.schema) {
      const factory = this.graphQlFactory ?? new GraphQLFactory();
      await factory.generateDefinitions(printSchema(options.schema), options as any);
    }

    await this.registerServer(options);

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

  async registerServer(apolloOptions: ApolloDriverConfig): Promise<void> {
    await this.registerBunServer(apolloOptions);
  }

  override async stop(): Promise<void> {
    await this._subscriptionService?.stop();
    this._subscriptionService = undefined;
    await super.stop();
  }
}
