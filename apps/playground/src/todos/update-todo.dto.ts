import { ApiPropertyOptional } from "@bunest/swagger";
import {
  IsBoolean,
  IsOptional,
  IsString,
  MinLength,
} from "@bunest/validation/validator";

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
