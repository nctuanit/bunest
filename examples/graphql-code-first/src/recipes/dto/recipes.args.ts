import { ArgsType, Field, Int } from "@bunest/graphql";

@ArgsType()
export class RecipesArgs {
  @Field(() => Int, { nullable: true, defaultValue: 0 })
  skip = 0;

  @Field(() => Int, { nullable: true, defaultValue: 25 })
  take = 25;
}
