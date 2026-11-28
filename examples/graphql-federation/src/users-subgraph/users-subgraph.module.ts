import { Module } from "@bunest/core";
import { GraphQLModule } from "@bunest/graphql";
import {
  ApolloFederationDriver,
  type ApolloFederationDriverConfig,
} from "@bunest/graphql/apollo";
import { UsersResolver } from "./users.resolver";

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: { federation: 2 },
    }),
  ],
  providers: [UsersResolver],
  exports: [UsersResolver],
})
export class UsersSubgraphModule {}
