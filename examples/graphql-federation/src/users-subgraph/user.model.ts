import { Directive, Field, ID, ObjectType } from "@bunest/graphql";

@Directive('@key(fields: "id")')
@ObjectType()
export class User {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;
}
