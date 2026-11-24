import {
  type GqlModuleOptions,
  GraphQLFactory,
  GraphQLFederationFactory,
} from "../../index";
import type { GraphQLSchema } from "../../engine";

/**
 * Convenience helper to programmatically build an Apollo-ready `GraphQLSchema`
 * (standard or Federation v2 subgraph) using `@bunest/graphql`'s native factories.
 */
export async function createApolloSchema(
  options: GqlModuleOptions = {},
  resolvers: readonly object[] = [],
): Promise<GraphQLSchema> {
  if (options.federation) {
    const fedFactory = new GraphQLFederationFactory();
    return fedFactory.generateSchema(options, undefined, resolvers);
  }
  const factory = new GraphQLFactory();
  return factory.generateSchema(options, resolvers);
}
