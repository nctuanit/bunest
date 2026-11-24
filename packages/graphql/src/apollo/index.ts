// Constants
export {
  ApolloServerErrorCode,
  PLUGIN_METADATA,
} from "./constants/apollo.constants";

// Decorators
export { Plugin } from "./decorators/plugin.decorator";

// Drivers
export {
  ApolloBaseDriver,
  ApolloDriver,
  ApolloFederationDriver,
  ApolloGatewayDriver,
} from "./drivers/index";

// Errors
export {
  ApolloError,
  AuthenticationError,
  ForbiddenError,
  UserInputError,
  ValidationError,
} from "./errors/index";

// Interfaces (exact @nestjs/apollo public API surface)
export type {
  ApolloDriverAsyncConfig,
  ApolloDriverConfig,
  ApolloDriverConfigFactory,
  ApolloFederationDriverAsyncConfig,
  ApolloFederationDriverConfig,
  ApolloFederationDriverConfigFactory,
  ApolloGatewayDriverAsyncConfig,
  ApolloGatewayDriverConfig,
  ApolloGatewayDriverConfigFactory,
  ServerRegistration,
} from "./interfaces/index";

// Server, Plugins & GraphiQL
export { HeaderMap } from "./server/header-map";
export {
  BunestApolloServer,
  unwrapResolverError,
  type ApolloServer,
  type BunestApolloServerOptions,
} from "./server/apollo-server";
export type {
  ApolloConfigInput,
  ApolloLogger,
  ApolloServerOptionsBase,
  ApolloServerPlugin,
  BaseContext,
  CSRFPreventionOptions,
  FormattedExecutionResult,
  GatewayExecutor,
  GatewayInterface,
  GatewayLoadResult,
  GatewaySchemaLoadContext,
  GatewaySchemaLoadOrUpdateCallback,
  GraphQLRequest,
  GraphQLRequestContext,
  GraphQLRequestListener,
  GraphQLResponse,
  GraphQLServerContext,
  GraphQLServerListener,
  KeyValueCache,
  PersistedQueryOptions,
} from "./server/apollo-server.types";
export {
  ApolloServerPluginDrainHttpServer,
  ApolloServerPluginLandingPageDisabled,
  ApolloServerPluginLandingPageLocalDefault,
  type ApolloLandingPageLocalDefaultOptions,
} from "./server/apollo-plugins";
export { GraphiQLHTMLFactory } from "./graphiql/graphiql-html.factory";
export { GraphiQLPlaygroundPlugin } from "./graphiql/graphiql-playground.plugin";
export type { GraphiQLOptions } from "./graphiql/graphiql-options.interface";

// Gateway & Subgraph Data Sources
export {
  RemoteGraphQLDataSource,
  type FetcherFn,
  type GraphQLDataSource,
  type GraphQLDataSourceProcessOptions,
  type RemoteGraphQLDataSourceOptions,
} from "./gateway/graphql-data-source";
export {
  IntrospectAndCompose,
  type IntrospectAndComposeOptions,
  type ServiceEndpointDefinition,
  type SubgraphSdlEntry,
  type SupergraphManager,
} from "./gateway/introspect-and-compose";
export { ApolloGateway, type GatewayConfig } from "./gateway/apollo-gateway";

// Services
export { PluginsExplorerService } from "./services/plugins-explorer.service";

// Utilities
export { createAsyncIterator } from "./utils/async-iterator.util";
export { createApolloSchema } from "./utils/create-apollo-schema";
export { ApolloFederationDefinitionsFactory } from "./utils/federation-definitions.factory";
export { getApolloServer } from "./utils/get-apollo-server";
