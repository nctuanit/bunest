import { Module } from "@bunest/core";
import { GraphQLModule } from "@bunest/graphql";
import { ApolloDriver, type ApolloDriverConfig } from "@bunest/graphql/apollo";
import { RecipesModule } from "./recipes/recipes.module";

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      playground: true,
    }),
    RecipesModule,
  ],
})
export class AppModule {}
