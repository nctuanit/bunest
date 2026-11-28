import { Field, InputType } from "@bunest/graphql";
import {
  IsArray,
  IsOptional,
  IsString,
  MinLength,
} from "@bunest/validation/validator";

@InputType()
export class NewRecipeInput {
  @Field()
  @IsString()
  @MinLength(3)
  title: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => [String])
  @IsArray()
  ingredients: string[];
}
