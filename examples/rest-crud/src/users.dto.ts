import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from "@bunest/validation/validator";
import { Type } from "@bunest/validation/transformer";
import { ApiProperty, ApiPropertyOptional, PartialType } from "@bunest/swagger";

export class CreateUserDto {
  @ApiProperty({ example: "Ada Lovelace", minLength: 2 })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: "ada@bunest.dev", format: "email" })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({ example: 36, minimum: 13, maximum: 150 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(13)
  @Max(150)
  age?: number;
}

export class UpdateUserDto extends PartialType(CreateUserDto) {}
