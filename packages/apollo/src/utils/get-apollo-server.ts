import type { INestApplicationContext } from "@bunest/common";
import { AbstractGraphQLDriver, GraphQLModule } from "@bunest/graphql";
import type { BaseContext } from "../server/apollo-server.types";
import type { BunestApolloServer } from "../server/apollo-server";

type GetApolloServer = (
  app: INestApplicationContext,
) => BunestApolloServer<BaseContext>;

/**
 * Returns the underlying ApolloServer instance for a given application.
 * @param app Nest/Bunest application reference
 * @returns Apollo Server instance used by the host application
 * @publicApi
 */
export const getApolloServer: GetApolloServer = (app) => {
  try {
    const graphqlModule = app.get(GraphQLModule, {
      strict: false,
    }) as GraphQLModule & {
      graphQlAdapter?: { instance?: BunestApolloServer<BaseContext> };
    };
    if (graphqlModule?.graphQlAdapter?.instance) {
      return graphqlModule.graphQlAdapter.instance;
    }
  } catch {
    /* fallback to AbstractGraphQLDriver provider */
  }

  try {
    const driver = app.get(AbstractGraphQLDriver, { strict: false }) as {
      instance?: BunestApolloServer<BaseContext>;
    };
    if (driver?.instance) {
      return driver.instance;
    }
  } catch {
    /* empty */
  }

  throw new Error(
    `Nest could not find the "GraphQLModule" in your application's container. Please, double-check if it's registered in the given application.`,
  );
};
