import { Injectable, NotFoundException } from "@bunest/core";
import type { NewRecipeInput } from "./dto/new-recipe.input";
import type { RecipesArgs } from "./dto/recipes.args";
import type { Recipe } from "./models/recipe.model";

@Injectable()
export class RecipesService {
  private readonly recipes: Recipe[] = [
    {
      id: "1",
      title: "Pho Bo",
      description: "Traditional Vietnamese beef noodle soup",
      ingredients: ["rice noodles", "beef broth", "star anise", "herbs"],
    },
    {
      id: "2",
      title: "Banh Mi",
      description: "Crispy baguette sandwich",
      ingredients: ["baguette", "pate", "pickled carrots", "cilantro"],
    },
  ];
  private nextId = 3;

  findAll(args: RecipesArgs): Recipe[] {
    const start = args.skip ?? 0;
    const take = args.take ?? 25;
    return this.recipes.slice(start, start + take);
  }

  findOneById(id: string): Recipe {
    const found = this.recipes.find((r) => r.id === id);
    if (!found) {
      throw new NotFoundException(`Recipe #${id} not found`);
    }
    return found;
  }

  create(input: NewRecipeInput): Recipe {
    const recipe: Recipe = {
      id: String(this.nextId++),
      title: input.title,
      description: input.description,
      ingredients: [...input.ingredients],
    };
    this.recipes.push(recipe);
    return recipe;
  }

  remove(id: string): boolean {
    const idx = this.recipes.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this.recipes.splice(idx, 1);
    return true;
  }
}
