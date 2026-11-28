import { Module, readTextSync, resolve } from "@bunest/core";
import { GraphQLModule } from "@bunest/graphql";
import { CatsModule } from "./cats/cats.module";

const CATS_TYPE_DEFS = readTextSync(
  resolve(import.meta.dir, "cats", "cats.graphql"),
);

@Module({
  imports: [
    GraphQLModule.forRoot({
      typeDefs: CATS_TYPE_DEFS,
      playground: true,
      context: ({ req }) => ({
        role: req.headers.get("x-role") ?? "guest",
      }),
    }),
    CatsModule,
  ],
})
export class AppModule {}
