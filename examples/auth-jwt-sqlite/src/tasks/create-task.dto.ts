import { IsOptional, IsString, MinLength } from "@bunest/validation/validator";

export class CreateTaskDto {
  @IsString()
  @MinLength(1)
  title: string;

  @IsOptional()
  @IsString()
  failAfterInsert?: string;
}
