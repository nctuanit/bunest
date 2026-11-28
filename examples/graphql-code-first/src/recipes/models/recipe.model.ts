import { Field, ID, Int, ObjectType } from "@bunest/graphql";

@ObjectType({ description: "Culinary recipe model" })
export class Recipe {
  @Field(() => ID)
  id: string;

  @Field()
  title: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => [String])
  ingredients: string[];

  @Field(() => Int)
  ingredientCount?: number;
}
