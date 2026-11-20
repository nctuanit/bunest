import "reflect-metadata";
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@bunest/swagger";

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

export class UpdateUserDto {
  @ApiPropertyOptional({ example: "Augusta Ada", minLength: 2 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ example: "augusta@bunest.dev", format: "email" })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: 37, minimum: 13, maximum: 150 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(13)
  @Max(150)
  age?: number;
}
