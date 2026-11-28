import { IsString, MinLength } from "@bunest/validation/validator";

export class CreateOrderDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsString()
  @MinLength(2)
  description: string;
}
