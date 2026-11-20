import "reflect-metadata";
import { IsBoolean, IsOptional, IsString, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@bunest/swagger";

export class CreateTodoDto {
  @ApiProperty({ example: "Explore Bunest Playground", minLength: 2 })
  @IsString()
  @MinLength(2)
  title!: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  completed?: boolean;
}

export class UpdateTodoDto {
  @ApiPropertyOptional({ example: "Ship Bunest v0.1", minLength: 2 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  title?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  completed?: boolean;
}
