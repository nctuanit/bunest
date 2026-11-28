import { UsePipes } from "@bunest/core";
import {
  Args,
  ID,
  Int,
  Mutation,
  Parent,
  PubSub,
  Query,
  ResolveField,
  Resolver,
  Subscription,
} from "@bunest/graphql";
import { ValidationPipe } from "@bunest/validation";
import { NewRecipeInput } from "./dto/new-recipe.input";
import { RecipesArgs } from "./dto/recipes.args";
import { Recipe } from "./models/recipe.model";
import { RecipesService } from "./recipes.service";

const pubSub = new PubSub();

@Resolver(() => Recipe)
export class RecipesResolver {
  constructor(private readonly recipesService: RecipesService) {}

  @Query(() => Recipe)
  recipe(@Args("id", { type: () => ID }) id: string): Recipe {
    return this.recipesService.findOneById(id);
  }

  @Query(() => [Recipe])
  recipes(@Args() args: RecipesArgs): Recipe[] {
    return this.recipesService.findAll(args);
  }

  @Mutation(() => Recipe)
  @UsePipes(new ValidationPipe({ transform: true }))
  async addRecipe(
    @Args("newRecipeData") newRecipeData: NewRecipeInput,
  ): Promise<Recipe> {
    const recipe = this.recipesService.create(newRecipeData);
    await pubSub.publish("recipeAdded", { recipeAdded: recipe });
    return recipe;
  }

  @Mutation(() => Boolean)
  removeRecipe(@Args("id", { type: () => ID }) id: string): boolean {
    return this.recipesService.remove(id);
  }

  @ResolveField(() => Int)
  ingredientCount(@Parent() recipe: Recipe): number {
    return recipe.ingredients.length;
  }

  @Subscription(() => Recipe)
  recipeAdded() {
    return pubSub.asyncIterator("recipeAdded");
  }
}
