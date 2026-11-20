import "reflect-metadata";
import { Transform } from "class-transformer";
import { IsBoolean, MinLength } from "class-validator";
import {
  Directive,
  Extensions,
  Field,
  ObjectType,
} from "../../../../../../../../packages/graphql/src";

@ObjectType()
export class CreateUserDto {
  @Transform(({ value }) => `${String(value)}_transformed`)
  @MinLength(10)
  @Field({ nullable: true })
  @Directive("@upper")
  login!: string;

  @Transform(({ value }) => `${String(value)}_transformed`)
  @MinLength(10)
  @Field()
  @Directive("@upper")
  @Extensions({ extension: true })
  password!: string;

  @Field({ name: "id" })
  @Extensions({ extension: true })
  _id!: string;

  @IsBoolean()
  active!: boolean;
}
