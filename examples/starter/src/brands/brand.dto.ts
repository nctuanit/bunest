import { IsNotEmpty, IsString } from "@bunest/validation/validator";

export class CreateBrandDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  country: string;
}
