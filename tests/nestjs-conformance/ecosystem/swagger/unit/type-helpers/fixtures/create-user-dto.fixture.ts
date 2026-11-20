import "reflect-metadata";
import { Expose, Transform } from "class-transformer";
import { IsEnum, IsString } from "class-validator";
import { ApiProperty } from "../../../../../../../packages/swagger/src";

export const METADATA_FACTORY_NAME = "_OPENAPI_METADATA_FACTORY" as const;

export class CreateUserDto {
  @IsString()
  firstName!: string;

  @IsString()
  lastName!: string;

  @IsEnum(["admin", "user"])
  role!: string;

  @ApiProperty({ required: true })
  login!: string;

  @Expose()
  @Transform(({ value }) => `${String(value)}_transformed`)
  @IsString()
  @ApiProperty({ minLength: 10 })
  password!: string;

  static [METADATA_FACTORY_NAME]() {
    return {
      firstName: { required: true, type: String },
      lastName: { required: true, type: String },
    };
  }
}
