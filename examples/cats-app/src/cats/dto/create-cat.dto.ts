import { IsInt, IsString, Max, Min, MinLength } from "@bunest/validation/validator";

export class CreateCatDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsInt()
  @Min(0)
  @Max(35)
  age: number;

  @IsString()
  @MinLength(2)
  breed: string;
}
