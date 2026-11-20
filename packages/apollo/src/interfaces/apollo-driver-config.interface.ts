import type {
  GqlModuleAsyncOptions,
  GqlModuleOptions,
  GqlOptionsFactory,
  GraphQLSubscriptionsConfig,
  SubscriptionConfig,
} from "@bunest/graphql";
import type { GraphiQLOptions } from "../graphiql/graphiql-options.interface";
import type { ApolloServerOptionsBase } from "../server/apollo-server.types";

/**
 * @publicApi
 */
export interface ServerRegistration {
  /**
   * Path to mount GraphQL API
   */
  path?: string;
}

/**
 * @publicApi
 */
export interface ApolloDriverConfig
  extends ApolloServerOptionsBase<any>,
    ServerRegistration,
    Omit<
      GqlModuleOptions,
      | "subscriptions"
      | "graphiql"
      | "context"
      | "formatError"
      | "introspection"
      | "includeStacktraceInErrorResponses"
      | "path"
    > {
  /**
   * Per-request GraphQL context value or factory.
   */
  context?: ((...args: any[]) => any) | Record<string, any>;
  /**
   * If enabled, graphql-ws will be automatically registered.
   */
  installSubscriptionHandlers?: boolean;
  /**
   * Subscriptions configuration.
   */
  subscriptions?: SubscriptionConfig | GraphQLSubscriptionsConfig;
  /**
   * Deprecated boolean alias for GraphiQL.
   * Set to `true` to enable GraphiQL, or `false` to disable the landing page.
   */
  playground?: boolean;
  /**
   * GraphiQL options, or a boolean to enable GraphiQL with default options.
   * GraphiQL is enabled by default in non-production when neither landing page option is configured.
   */
  graphiql?: boolean | GraphiQLOptions;
  /**
   * If enabled, automatically maps `HttpException` instances to corresponding Apollo errors.
   * @default true
   */
  autoTransformHttpErrors?: boolean;
  /**
   * Controls whether execution errors reset HTTP status to 200.
   * @default true
   */
  preserveHttpStatusForExecutionErrors?: boolean;
}

export type ApolloDriverConfigFactory = GqlOptionsFactory<ApolloDriverConfig>;
export type ApolloDriverAsyncConfig = GqlModuleAsyncOptions<ApolloDriverConfig>;
