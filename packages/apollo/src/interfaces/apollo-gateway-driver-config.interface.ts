import type { Type } from "@bunest/common";
import type {
  GqlModuleAsyncOptions,
  GqlOptionsFactory,
  GraphQLDriver,
} from "@bunest/graphql";
import type { GraphQLSchema } from "graphql";
import type { GatewayConfig } from "../gateway/apollo-gateway";
import type { ApolloDriverConfig } from "./apollo-driver-config.interface";

/**
 * @publicApi
 */
export interface ApolloGatewayDriverConfig<
  TDriver extends GraphQLDriver = any,
> {
  /**
   * GraphQL gateway adapter
   */
  driver?: Type<TDriver>;
  /**
   * Gateway configuration
   */
  gateway?: GatewayConfig;
  /**
   * Server configuration
   */
  server?: Omit<
    ApolloDriverConfig,
    | "typeDefs"
    | "typePaths"
    | "include"
    | "resolvers"
    | "resolverValidationOptions"
    | "directiveResolvers"
    | "autoSchemaFile"
    | "transformSchema"
    | "definitions"
    | "schema"
    | "subscriptions"
    | "buildSchemaOptions"
    | "fieldResolverEnhancers"
    | "driver"
  >;
  /**
   * Function applied to the supergraph schema produced by the gateway
   * before it is exposed to Apollo Server.
   */
  transformSchema?: (
    schema: GraphQLSchema,
  ) => GraphQLSchema | Promise<GraphQLSchema>;
}

export type ApolloGatewayDriverConfigFactory =
  GqlOptionsFactory<ApolloGatewayDriverConfig>;
export type ApolloGatewayDriverAsyncConfig =
  GqlModuleAsyncOptions<ApolloGatewayDriverConfig>;
