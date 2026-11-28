import { IsEmail, IsString, MinLength } from "@bunest/validation/validator";

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  password: string;
}
