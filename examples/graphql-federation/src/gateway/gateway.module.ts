import { Module } from "@bunest/core";
import { GraphQLModule } from "@bunest/graphql";
import {
  ApolloGatewayDriver,
  IntrospectAndCompose,
  RemoteGraphQLDataSource,
  type ApolloGatewayDriverConfig,
  type FetcherFn,
} from "@bunest/graphql/apollo";

export interface FederationGatewayOptions {
  readonly usersUrl: string;
  readonly postsUrl: string;
  readonly fetcher?: FetcherFn;
}

export function createGatewayModule(options: FederationGatewayOptions) {
  @Module({
    imports: [
      GraphQLModule.forRoot<ApolloGatewayDriverConfig>({
        driver: ApolloGatewayDriver,
        server: {
          path: "/graphql",
          playground: true,
          context: ({ req }: { req: Request }) => ({
            token: req?.headers?.get("authorization") ?? "",
          }),
        },
        gateway: {
          supergraphSdl: new IntrospectAndCompose({
            subgraphs: [
              { name: "users", url: options.usersUrl },
              { name: "posts", url: options.postsUrl },
            ],
          }),
          buildService: ({ url }) =>
            new RemoteGraphQLDataSource({
              url: url!,
              ...(options.fetcher ? { fetcher: options.fetcher } : {}),
              willSendRequest({ request, context }) {
                if (context?.token) {
                  request.http?.headers.set(
                    "x-gateway-auth",
                    String(context.token),
                  );
                }
              },
            }),
        },
      }),
    ],
  })
  class GatewayModule {}

  return GatewayModule;
}
