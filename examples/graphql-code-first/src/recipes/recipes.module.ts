import { Module } from "@bunest/core";
import { RecipesResolver } from "./recipes.resolver";
import { RecipesService } from "./recipes.service";

@Module({
  providers: [RecipesResolver, RecipesService],
})
export class RecipesModule {}
